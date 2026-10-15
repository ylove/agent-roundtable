import { test } from "node:test";
import assert from "node:assert/strict";

const L = await import("../../dist/execution/leases.js");
const { initialState } = await import("../../dist/execution/blackboard.js");
const { validateDraft } = await import("../../dist/execution/events.js");
const { createExecutionStore } = await import("../../dist/execution/store.js");
const { newExecutionId, executionTag } = await import("../../dist/ids.js");

const src = { kind: "runner", id: "runner", pid: process.pid };

function stateWith({ leases = [], queue = [], tasks = {} } = {}) {
  const s = initialState(newExecutionId());
  for (const l of leases) s.leases[l.id] = { branch: "rt/x/y", reason: "", granted_seq: 1, mode: "exclusive", ...l };
  s.lease_queue = queue.map((r) => ({ reason: "", requested_seq: 1, blocking: [], mode: "exclusive", ...r }));
  for (const [id, t] of Object.entries(tasks)) {
    s.tasks[id] = { spec: { id, title: id, persona: "p", kind: "build", depends_on: [], paths: { write: [] }, acceptance: [], checks: [] }, attempt: 1, ...t };
  }
  return s;
}

test("matchGlob: **, *, ? and literal segments", () => {
  const yes = [
    ["src/**", "src/a.ts"],
    ["src/**", "src/nav/deep/x.ts"],
    ["src/*.ts", "src/a.ts"],
    ["src/*.ts", "src/.hidden.ts"],
    ["src/?.ts", "src/a.ts"],
    ["**/x.ts", "x.ts"],
    ["**/x.ts", "a/b/x.ts"],
    ["a/**/b", "a/b"],
    ["a/**/b", "a/x/y/b"],
    ["**", "anything/at/all"],
    ["docs/", "docs/a.md"],
    ["./src//a.ts", "src/a.ts"],
    ["src/[ab].ts", "src/[ab].ts"],
    ["src/a*b*c", "src/aXbYc"],
  ];
  const no = [
    ["src/**", "src"],
    ["src/**", "srcx/a.ts"],
    ["src/*.ts", "src/nav/a.ts"],
    ["src/*.ts", "src/a.tsx"],
    ["src/?.ts", "src/ab.ts"],
    ["src/?.ts", "src/.ts"],
    ["src/a?b", "src/a/b"],
    ["src/*", "src/nav/a.ts"],
    ["src/{a,b}.ts", "src/a.ts"],
    ["src/[ab].ts", "src/a.ts"],
    ["../x", "x"],
    ["/abs/**", "abs/a"],
    ["src/**", "../src/a"],
    ["src/a.ts", "src/a.ts/x"],
  ];
  for (const [g, p] of yes) assert.equal(L.matchGlob(g, p), true, `${g} should match ${p}`);
  for (const [g, p] of no) assert.equal(L.matchGlob(g, p), false, `${g} should not match ${p}`);
  assert.equal(L.normalizeGlob("src/{a,b}"), null, "braces are refused, not silently literal");
  assert.equal(L.normalizeGlob("docs/"), "docs/**");
});

test("staticPrefix stops at the first segment with a wildcard", () => {
  assert.equal(L.staticPrefix("src/**"), "src");
  assert.equal(L.staticPrefix("src/*.ts"), "src");
  assert.equal(L.staticPrefix("src/nav/**"), "src/nav");
  assert.equal(L.staticPrefix("a/b?/c"), "a");
  assert.equal(L.staticPrefix("**"), "");
  assert.equal(L.staticPrefix("src/a.ts"), "src/a.ts");
});

test("globsOverlap is conservative, comparing whole segments", () => {
  const overlap = [
    ["src/**", "src/*.ts"],
    ["src/nav/**", "src/**"],
    ["src/*.ts", "src/*.css"], // false positive by design
    ["src/?.ts", "src/ab.ts"], // false positive by design
    ["**", "docs/a.md"],
    ["src/a.ts", "src/a.ts"],
    ["src/nav", "src/nav/a.ts"],
    ["src/{bad", "docs/**"], // invalid globs overlap everything
  ];
  const apart = [
    ["docs/**", "src/**"],
    ["src/a.ts", "src/b.ts"],
    ["src/**", "srcx/**"],
    ["src/nav/**", "src/navigation/**"],
  ];
  for (const [a, b] of overlap) {
    assert.equal(L.globsOverlap(a, b), true, `${a} / ${b}`);
    assert.equal(L.globsOverlap(b, a), true, `${b} / ${a}`);
  }
  for (const [a, b] of apart) {
    assert.equal(L.globsOverlap(a, b), false, `${a} / ${b}`);
    assert.equal(L.globsOverlap(b, a), false, `${b} / ${a}`);
  }
});

test("leasesConflict: exclusive vs anything, shared only vs exclusive, never with yourself", () => {
  const ex = (agent, task, paths) => ({ agent, task, paths, mode: "exclusive" });
  const sh = (agent, task, paths) => ({ agent, task, paths, mode: "shared" });
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), ex("b", "t2", ["src/nav/**"])), true);
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), sh("b", "t2", ["src/x.ts"])), true);
  assert.equal(L.leasesConflict(sh("a", "t1", ["src/**"]), sh("b", "t2", ["src/**"])), false);
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), ex("b", "t2", ["docs/**"])), false);
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), ex("a", "t1", ["src/**"])), false, "same agent, same task");
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), ex("a", "t2", ["src/**"])), true, "same agent, other task");
  assert.equal(L.leasesConflict(ex("a", "t1", ["src/**"]), ex("b", "t1", ["src/**"])), true, "other agent, same task");
});

test("pathCovered: .git* metadata needs a lease that names it; .git never", () => {
  const all = [{ paths: ["**"] }];
  assert.equal(L.pathCovered("src/a.ts", all), true);
  assert.equal(L.pathCovered(".gitattributes", all), false);
  assert.equal(L.pathCovered(".gitmodules", all), false);
  assert.equal(L.pathCovered("src/.gitignore", [{ paths: ["src/**"] }]), false);
  assert.equal(L.pathCovered(".github/workflows/ci.yml", all), false);
  assert.equal(L.pathCovered(".gitattributes", [{ paths: [".gitattributes"] }]), true);
  assert.equal(L.pathCovered("src/.gitattributes", [{ paths: ["**/.gitattributes"] }]), true);
  assert.equal(L.pathCovered(".github/workflows/ci.yml", [{ paths: [".github/**"] }]), true);
  assert.equal(L.pathCovered(".git/config", [{ paths: [".git/**"] }]), false);
  assert.equal(L.pathCovered("sub/.git/hooks/x", all), false);
  assert.equal(L.pathCovered("../escape", all), false);
  assert.deepEqual(L.uncoveredPaths(["src/a.ts", "docs/b.md", "docs/b.md", ".gitattributes"], [{ paths: ["src/**", "docs/*.txt"] }]), [
    "docs/b.md",
    ".gitattributes",
  ]);
  assert.equal(L.isGitMetadataPath(".github/x"), true);
  assert.equal(L.isGitMetadataPath("src/git.ts"), false);
});

test("decideLeaseRequest grants on the task branch, queues with holders, reuses an identical lease", () => {
  const s = stateWith({
    leases: [{ id: "lease-a", agent: "alice", task: "nav", paths: ["src/nav/**"], mode: "exclusive" }],
    tasks: { nav: { state: "in_progress", percent: 40 } },
  });
  const free = L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: ["docs/", "README.md"], reason: "write docs" });
  assert.ok(free.grant);
  assert.match(free.grant.id, /^lease-/);
  assert.deepEqual(free.grant.paths, ["docs/**", "README.md"]);
  assert.equal(free.grant.mode, "exclusive");
  assert.equal(free.grant.branch, `rt/${executionTag(s.execution)}/docs`);

  const blocked = L.decideLeaseRequest(s, { id: "req-b", agent: "bob", task: "docs", paths: ["src/**"], mode: "shared" });
  assert.ok(blocked.queue);
  assert.equal(blocked.queue.id, "req-b");
  assert.deepEqual(blocked.queue.blocking, ["lease-a"]);
  assert.deepEqual(blocked.holders, [{ lease: "lease-a", agent: "alice", task: "nav", percent: 40, paths: ["src/nav/**"], mode: "exclusive", queued: false }]);

  const again = L.decideLeaseRequest(s, { agent: "alice", task: "nav", paths: ["src/nav/**"], mode: "shared" });
  assert.equal(again.existing, true);
  assert.equal(again.grant.id, "lease-a");

  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: [] }), /at least one path/);
  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: ["../up"] }), /Not a valid lease path/);
  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: ["a/{b,c}"] }), /Not a valid lease path/);
  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: [".git/**"] }), /never writable/);
  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "Bad Id", paths: ["x"] }), /Not a task id/);
  assert.throws(() => L.decideLeaseRequest(s, { agent: "bob", task: "docs", paths: ["x"], mode: "both" }), /exclusive or shared/);
});

test("queue fairness: a later compatible request never jumps a waiting one", () => {
  // shared holder S1; exclusive X waits for it; shared S2 must wait behind X, not join S1.
  const s = stateWith({
    leases: [{ id: "s1", agent: "a", task: "t1", paths: ["src/**"], mode: "shared" }],
    queue: [{ id: "x", agent: "b", task: "t2", paths: ["src/**"], mode: "exclusive", blocking: ["s1"] }],
  });
  const s2 = L.decideLeaseRequest(s, { id: "s2", agent: "c", task: "t3", paths: ["src/a.ts"], mode: "shared" });
  assert.ok(s2.queue, "queued behind the waiting exclusive request");
  assert.deepEqual(s2.queue.blocking, ["x"]);
  assert.equal(s2.holders[0].queued, true);
});

test("nextGrants and releaseLeases: FIFO, unblocked heads only, stale requests withdrawn", () => {
  const s = stateWith({
    leases: [
      { id: "A", agent: "a", task: "ta", paths: ["src/**"] },
      { id: "D", agent: "d", task: "td", paths: ["docs/**"] },
    ],
    queue: [
      { id: "B", agent: "b", task: "tb", paths: ["src/nav/**"], blocking: ["A"] },
      { id: "C", agent: "c", task: "tc", paths: ["src/**"], mode: "shared", blocking: ["A", "B"] },
      { id: "E", agent: "e", task: "te", paths: ["docs/x.md"], blocking: ["D"] },
      { id: "F", agent: "f", task: "tf", paths: ["lib/**"], blocking: [] },
    ],
    tasks: { tf: { state: "cancelled" } },
  });
  assert.deepEqual(L.nextGrants(s, src).map((d) => [d.type, d.payload.lease?.id ?? d.payload.lease_id]), [["lease.released", "F"]], "nothing unblocked; F's task is finished");

  const drafts = L.releaseLeases(s, { task: "ta" }, src);
  assert.deepEqual(
    drafts.map((d) => [d.type, d.payload.lease?.id ?? d.payload.lease_id]),
    [
      ["lease.released", "A"],
      ["lease.granted", "B"], // C conflicts with B (ahead of it) and keeps waiting
      ["lease.released", "F"],
    ]
  );
  const granted = drafts.find((d) => d.type === "lease.granted").payload.lease;
  assert.equal(granted.branch, `rt/${executionTag(s.execution)}/tb`);

  // Once B is gone too, C (shared) and E (still blocked by D) are judged again.
  assert.deepEqual(
    L.nextGrants(s, src, { gone: ["A", "B"] }).map((d) => [d.type, d.payload.lease?.id ?? d.payload.lease_id]),
    [["lease.granted", "C"], ["lease.released", "F"]]
  );

  const expired = L.releaseLeases(s, { agent: "d" }, src, { kind: "expired" });
  assert.deepEqual(expired.map((d) => [d.type, d.payload.lease?.id ?? d.payload.lease_id]), [
    ["lease.expired", "D"],
    ["lease.granted", "E"],
    ["lease.released", "F"],
  ]);
  const revoked = L.releaseLeases(s, { ids: ["A"] }, src, { kind: "revoked", reason: "reassigned", grantNext: false });
  assert.deepEqual(revoked.map((d) => d.payload), [{ lease_id: "A", by: "runner", reason: "reassigned" }]);
  const withdrawn = L.releaseLeases(s, { agent: "c" }, src, { grantNext: false });
  assert.deepEqual(withdrawn.map((d) => [d.type, d.payload.lease_id]), [["lease.released", "C"]], "a queued request is withdrawn");
  assert.throws(() => L.releaseLeases(s, {}, src), /needs an agent, a task or lease ids/);
  assert.deepEqual(L.leasesFor(s, "ta").map((l) => l.id), ["A"]);
});

test("lease drafts validate and reduce through the store", async () => {
  const store = await createExecutionStore({ repoRoot: "/srv/repo", baseSha: "a".repeat(40), agentsDir: "/srv/agents" });
  let state = await store.state();
  const first = L.decideLeaseRequest(state, { agent: "alice", task: "nav", paths: ["src/nav/**"], reason: "nav bar" });
  await store.transact(() => ({ events: [L.leaseDrafts.granted(first.grant, src)] }));
  state = await store.state();
  const second = L.decideLeaseRequest(state, { agent: "bob", task: "app", paths: ["src/**"] });
  assert.ok(second.queue);
  await store.transact(({ state: s }) => {
    const d = L.decideLeaseRequest(s, { id: second.queue.id, agent: "bob", task: "app", paths: ["src/**"] });
    return { events: [L.leaseDrafts.queued(d.queue, src)] };
  });
  state = await store.state();
  assert.deepEqual(state.lease_queue.map((r) => [r.id, r.blocking]), [[second.queue.id, [first.grant.id]]]);
  await store.transact(({ state: s }) => ({ events: L.releaseLeases(s, { agent: "alice" }, src) }));
  state = await store.state();
  assert.deepEqual(Object.keys(state.leases), [second.queue.id], "bob's queued request became his lease");
  assert.equal(state.lease_queue.length, 0);
  assert.ok(state.leases[second.queue.id].granted_seq > 0);

  const many = Array.from({ length: 2000 }, (_, i) => `src/very/long/path/number/${i}/file.ts`);
  const v = validateDraft(L.leaseDrafts.violation("app", "bob", many, src));
  assert.ok(v.payload.paths.length < many.length);
  assert.match(v.payload.paths.at(-1), /^…\(\+\d+ more\)$/);
  validateDraft(L.leaseDrafts.revoked("x", "orchestrator", "scope change", src));
  validateDraft(L.leaseDrafts.expired("x", src));
});

// ============================================================================
// The runner's merge queue: one job at a time, off the tick (git and the sandbox are slow)
//
//   merge      a task whose checks passed (merging) goes into the integration branch with
//              mergeTask under git.lock. Success: merge.succeeded, task.merged, task.accepted and
//              one batch; integration checks run before the task's leases are released.
//              A conflict inside the task's leases is prepared in the
//              task worktree (prepareConflictResolution) and the worker resumed with a "resolve
//              conflicts" card; one outside them escalates as conflict. A lease violation rejects.
//   recheck    a task amended (contract.amended lists it) after its checks passed has them run
//              again before it merges; accepted work is checked on the integration worktree.
//   complete   every task accepted: final validation on the integration branch, the goal review
//              hook, then execution.completed. Publishing follows when visibility.github.pr asks
//              for it; only the integration branch is pushed.
// ============================================================================

import { createHash } from "node:crypto";
import { redact } from "../publishers/redact.js";
import { scrubAndCap } from "../security/secrets.js";
import { failureSignature, runCommandSpec, tailForTool } from "../sandbox/index.js";
import { runGh, withBodyFile } from "../github/gh.js";
import { assertSafeRef, integrationBranch, openRepo, runGit } from "./git.js";
import { leaseDrafts, leasesFor, releaseLeases } from "./leases.js";
import { classifyConflict, mergeDrafts, mergeTask, prepareConflictResolution, type MergeResult } from "./merge.js";
import { runnerEscalation, type RunnerEscalationSpec } from "./runner-hooks.js";
import { conflictContext } from "./task-card.js";
import { taskHeld } from "./task-holds.js";
import type { AnyEventDraft, BlackboardState, CommandSpec } from "./types.js";
import { ensureIntegrationWorktree, integrationWorktreePath, snapshotWip, taskWorktreePath, withCommitCheckout } from "./worktrees.js";
import type { Runner } from "./runner.js";

const CHECK_MAX_MS = 15 * 60_000;
const MERGE_RETRY_MS = 30_000;
const MERGE_FAILURES = 3;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const own = <T>(rec: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

export interface ChecksResult {
  ok: boolean;
  failed: Array<{ id: string; status: "failed" | "timed_out" }>;
  /** The end of each failing command's output (scrubbed). */
  tails: Record<string, string>;
}

/** Every task accepted (or cancelled), at least one accepted, nothing claimed. */
export function allAccepted(state: Readonly<BlackboardState>): boolean {
  const tasks = Object.values(state.tasks);
  return (
    tasks.length > 0 &&
    tasks.every((rt) => rt.state === "accepted" || rt.state === "cancelled") &&
    tasks.some((rt) => rt.state === "accepted") &&
    Object.keys(state.claims).length === 0
  );
}

export class MergeQueue {
  private running?: Promise<void>;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private recheckedAmendment = 0;

  constructor(private readonly r: Runner) {}

  busy(): boolean {
    return this.running !== undefined;
  }

  /** Start the next job when none runs. */
  feed(state: Readonly<BlackboardState>): void {
    if (this.running || state.status !== "running") return;
    const job = this.next(state);
    if (!job) return;
    this.running = this.r.background(
      job()
        .catch((e) => { this.r.say(`merge queue: ${errText(e)}`); })
        .finally(() => {
          this.running = undefined;
        })
    );
  }

  private next(state: Readonly<BlackboardState>): (() => Promise<void>) | undefined {
    if (this.r.isStopping()) return undefined;
    for (const rt of Object.values(state.tasks)) {
      if (rt.state === "accepted" && leasesFor(state, rt.spec.id).length) {
        return async () => {
          await this.integrationChecks(`after merging ${rt.spec.id}`);
          await this.releaseTaskLeases(rt.spec.id);
        };
      }
    }
    const now = Date.now();
    for (const rt of Object.values(state.tasks)) {
      const id = rt.spec.id;
      if (rt.state !== "merging" || state.paused_tasks.includes(id) || taskHeld(state, id)) continue;
      if ((this.failures.get(id)?.retryAt ?? 0) > now) continue;
      return () => this.mergeOne(id);
    }
    if (Object.values(state.tasks).some((rt) => rt.state === "merging")) return undefined;
    const amended = this.r.lastSeq((e) => e.type === "contract.amended");
    if (amended > this.recheckedAmendment) {
      return async () => {
        for (const e of this.r.events()) {
          if (e.type !== "contract.amended" || e.seq <= this.recheckedAmendment) continue;
          for (const task of e.payload.affected_tasks) {
            const rt = own(state.tasks, task);
            if (rt?.state === "accepted") {
              const res = await this.runChecks(state, "task", rt.spec.checks, integrationWorktreePath(this.r.execution), task);
              if (!res.ok) await this.r.store.transact(({ state: s }) => ({ events: runnerEscalation(s, {
                key: `amended_checks:${state.contract?.version}:${task}`, task, kind: "blocker",
                summary: `Accepted task ${task} failed its amended checks: ${res.failed.map((f) => f.id).join(", ")}. Amend the contract to add a fix-up task.`,
              }, this.r.source) }));
            }
          }
        }
        await this.integrationChecks("the contract was amended");
        this.recheckedAmendment = amended;
      };
    }
    if (allAccepted(state)) return () => this.complete();
    return undefined;
  }

  // ==========================================================================
  // Merging one task
  // ==========================================================================

  private async mergeOne(task: string): Promise<void> {
    const r = this.r;
    const src = r.source;
    let state = await r.store.state();
    const rt = own(state.tasks, task);
    if (rt?.state !== "merging" || taskHeld(state, task)) return;

    const history = await r.store.events();
    const checked = [...history].reverse().find((e) => e.type === "task.checks_passed" &&
      e.payload.task === task && e.payload.submitted_seq === rt.submitted_seq &&
      e.payload.commit === rt.last_commit && e.payload.commit !== undefined && e.payload.submitted_seq !== undefined);
    if (!checked || checked.type !== "task.checks_passed" || !checked.payload.commit) {
      await r.commit([{ type: "task.rejected", source: src, payload: { task, reasons: ["No passing checks bound to the current submission; submit the committed work again."] } }]);
      return;
    }
    const commit = checked.payload.commit;
    const submission = { commit, submitted_seq: rt.submitted_seq! };

    // Checks that passed before an amendment touched the task run again first (WS04).
    const amended = history.filter((e) => e.type === "contract.amended" && e.payload.affected_tasks.includes(task)).at(-1)?.seq ?? 0;
    const passed = checked.seq;
    if (amended > passed && rt.spec.checks.length) {
      r.say(`re-running the checks of ${task}: the contract was amended after they passed`);
      const res = await withCommitCheckout(r.header, task, commit, (dir) => this.runChecks(state, "task", rt.spec.checks, dir, task, submission));
      if (!res.ok) {
        await r.commit([{ type: "task.rejected", source: src, payload: { task, reasons: res.failed.map((f) => `check ${f.id} ${f.status === "timed_out" ? "timed out" : "failed"} after the contract was amended`) } }]);
        return;
      }
      await r.commit([{ type: "task.checks_passed", source: src, payload: { task, commands: [...rt.spec.checks], ...submission } }]);
      state = await r.store.state();
    }

    const leases = leasesFor(state, task);
    if (taskHeld(await r.store.state(), task)) return;
    let m: MergeResult;
    try {
      m = await mergeTask(r.header, task, { leases, commit, canMerge: async () => !taskHeld(await r.store.state(), task), onMerged: async (sha) => {
        const result = await r.store.transact(({ state: s }) => {
          if (taskHeld(s, task) || own(s.tasks, task)?.state !== "merging" || s.tasks[task].submitted_seq !== submission.submitted_seq || s.tasks[task].last_commit !== commit) return { events: [] };
          return { events: [
            mergeDrafts.succeeded(task, sha, src), mergeDrafts.taskMerged(task, sha, src),
            { type: "task.accepted", source: src, payload: { task } },
          ] as AnyEventDraft[] };
        });
        return result.events.length > 0;
      } });
      this.failures.delete(task);
    } catch (e) {
      const f = { count: (this.failures.get(task)?.count ?? 0) + 1, retryAt: Date.now() + MERGE_RETRY_MS };
      this.failures.set(task, f);
      r.say(`merging ${task} failed (${f.count}): ${errText(e)}`);
      if (f.count >= MERGE_FAILURES) {
        await r.store.transact(({ state: s }) => ({
          events: runnerEscalation(s, { key: `merge_error:${task}:${rt.last_commit ?? ""}`, task, kind: "blocker", summary: `Merging task ${task} into the integration branch keeps failing: ${scrubAndCap(errText(e), 1500)}`, block: true }, src),
        }));
      }
      return;
    }

    if (!m.ok && m.reason === "held") return;
    if (m.ok) {
      const sha = m.sha;
      r.say(`merged ${task} into ${integrationBranch(r.execution)} at ${sha.slice(0, 12)}${m.already ? " (already merged)" : ""}`);
      await this.integrationChecks(`after merging ${task}`);
      await this.releaseTaskLeases(task);
      return;
    }

    const agent = own(state.claims, task)?.agent ?? rt.agent ?? "runner";
    if (m.reason === "violation") {
      await r.commit([
        leaseDrafts.violation(task, agent, m.violations, src),
        { type: "task.rejected", source: src, payload: { task, reasons: [`Changes outside the task's leases cannot be merged: ${m.violations.slice(0, 20).join(", ")}`], violations: m.violations.slice(0, 50) } },
      ]);
      return;
    }

    // A conflict.
    if (classifyConflict(m.conflicts, leases) === "outside") {
      await r.store.transact(({ state: s }) => ({
        events: [
          mergeDrafts.conflicted(task, m.conflicts, src),
          ...runnerEscalation(
            s,
            {
              key: `conflict:${task}:${rt.last_commit ?? ""}:${m.conflicts.join(",")}`,
              task,
              kind: "conflict",
              summary: `Task ${task} conflicts with the integration branch outside its leases: ${m.conflicts.slice(0, 20).join(", ")}.`,
              question: "Who resolves these files?",
              options: ["Lease the files to the task and resume it", "Resolve them by hand on the integration branch", "Reassign the task"],
              block: true,
            },
            src
          ),
        ],
      }));
      r.say(`${task} conflicts outside its leases (${m.conflicts.join(", ")}): escalated`);
      return;
    }
    await r.commit([mergeDrafts.conflicted(task, m.conflicts, src)]);
    await r.withStoppedWorker(task, "killed", "its merge conflicted", async (exit) => {
      const wt = taskWorktreePath(r.execution, task);
      await snapshotWip(wt, "rt: wip snapshot", leases);
      const prep = await prepareConflictResolution(r.header, task);
      r.say(`${task} conflicts in ${prep.conflicts.join(", ")}: resuming its worker to resolve them`);
      const rejected: AnyEventDraft = { type: "task.rejected", source: src, payload: { task, reasons: [prep.conflicts.length ? `Merge conflicts to resolve: ${prep.conflicts.slice(0, 20).join(", ")}` : "Integration changes were merged into your branch; resubmit to check the new commit."] } };
      await r.startWorker(task, {
        claim: false,
        reopen: true,
        preDrafts: [...exit, rejected],
        immediate: conflictContext({ files: prep.conflicts, integrationBranch: integrationBranch(r.execution) }),
      });
    });
  }

  // ==========================================================================
  // Checks in the sandbox
  // ==========================================================================

  private async releaseTaskLeases(task: string): Promise<void> {
    await this.r.store.transact(({ state }) => ({ events: releaseLeases(state, { task }, this.r.source) }));
  }

  /** Run contract commands as checks of `scope` in `workdir`: check.started, then passed, failed or timed_out. */
  async runChecks(state: Readonly<BlackboardState>, scope: "task" | "integration", ids: readonly string[], workdir: string, task?: string, submission?: { commit: string; submitted_seq: number }): Promise<ChecksResult> {
    const r = this.r;
    const src = r.source;
    const backend = await r.sandbox();
    const commands = state.contract?.validation.commands ?? [];
    const image = state.contract?.sandbox.image || undefined;
    const out: ChecksResult = { ok: true, failed: [], tails: {} };
    const at = { ...(task !== undefined ? { task } : {}), ...submission };
    for (const id of ids) {
      if (r.isStopping()) throw new Error("runner stopped during validation");
      const spec: CommandSpec | undefined = commands.find((c) => c.id === id);
      await r.commit([{ type: "check.started", source: src, payload: { command_id: id, scope, ...at } }]);
      let output: string;
      let exit: number | null = null;
      let timedOut = false;
      let duration = 0;
      if (!spec) output = `The contract defines no command ${id}`;
      else {
        try {
          const res = await runCommandSpec(backend, spec, workdir, { ...(image && { image }), signal: r.abort.signal, maxTimeoutMs: CHECK_MAX_MS });
          ({ output, exit, timedOut, durationMs: duration } = res);
        } catch (e) {
          output = scrubAndCap(errText(e), 4000);
        }
      }
      if (r.isStopping()) throw new Error("runner stopped during validation");
      const blob = await r.store.putBlob(output || "(no output)");
      if (timedOut) {
        out.ok = false;
        out.failed.push({ id, status: "timed_out" });
        out.tails[id] = tailForTool(output, 2000);
        await r.commit([{ type: "check.timed_out", source: src, payload: { command_id: id, scope, ...at } }]);
      } else if (exit === 0) {
        await r.commit([{ type: "check.passed", source: src, payload: { command_id: id, scope, ...at, duration_ms: duration } }]);
      } else {
        out.ok = false;
        out.failed.push({ id, status: "failed" });
        out.tails[id] = tailForTool(output, 2000);
        await r.commit([{ type: "check.failed", source: src, payload: { command_id: id, scope, ...at, exit, signature: failureSignature(id, output), output_blob: blob } }]);
      }
    }
    return out;
  }

  /** The smoke checks on the integration worktree (after a merge, or after an amendment). */
  private async integrationChecks(why: string): Promise<ChecksResult | undefined> {
    const state = await this.r.store.state();
    const ids = this.r.integrationCheckIds(state);
    if (!ids.length) return undefined;
    await ensureIntegrationWorktree(this.r.header);
    const res = await this.runChecks(state, "integration", ids, integrationWorktreePath(this.r.execution));
    this.r.say(`integration checks ${why}: ${res.ok ? "passed" : `failed (${res.failed.map((f) => f.id).join(", ")})`}`);
    return res;
  }

  // ==========================================================================
  // Completion
  // ==========================================================================

  private async complete(): Promise<void> {
    const r = this.r;
    const state = await r.store.state();
    if (!allAccepted(state) || r.hasAnyLiveWorker()) return;
    if (Object.values(state.escalations).some((e) => !["resolved", "withdrawn"].includes(e.status))) return;
    const sha = (await ensureIntegrationWorktree(r.header)).head;
    const key = createHash("sha256").update(`${sha}|${Object.keys(state.tasks).sort().join(",")}|${state.contract?.version ?? 0}`).digest("hex");
    const history = await r.store.events();
    const outcomes = history.filter((e) => e.type === "note.posted" && e.source.kind === "runner" && e.payload.topic === "completion-outcome" && e.payload.refs.includes(key));
    const last = outcomes.at(-1);
    let resolved = 0;
    if (last?.type === "note.posted") {
      const outcome = JSON.parse(last.payload.text) as { retry_at?: number; escalations?: string[]; epoch?: number };
      const related = outcome.escalations ?? [];
      const closed = related.length > 0 && related.every((id) => {
        const esc = own(state.escalations, id);
        return esc && ["resolved", "withdrawn"].includes(esc.status);
      });
      if (closed) resolved = last.seq;
      else {
        resolved = outcome.epoch ?? 0;
        if (!outcome.retry_at || outcome.retry_at > Date.now()) return;
      }
    }
    const recordOutcome = async (outcome: string, retryAt?: number, escalation?: RunnerEscalationSpec, unlessOpen = false) => {
      const since = await r.store.events();
      const related = since.filter((e) => e.seq > state.seq && e.type === "escalation.raised")
        .map((e) => e.type === "escalation.raised" ? e.payload.escalation.id : "");
      await r.store.transact(({ state: s }) => {
        const open = Object.values(s.escalations).some((e) => !["resolved", "withdrawn"].includes(e.status));
        const before = escalation && (!unlessOpen || !open) ? runnerEscalation(s, escalation, r.source) : [];
        const escalations = [...related, ...before.flatMap((e) => e.type === "escalation.raised" ? [e.payload.escalation.id] : [])];
        return { events: [...before, { type: "note.posted", source: r.source, payload: {
          topic: "completion-outcome", refs: [key],
          text: JSON.stringify({ outcome, escalations, epoch: resolved, ...(retryAt !== undefined && { retry_at: retryAt }) }),
        } }] };
      });
    };

    // 1. Final validation on the integration branch.
    const final = state.contract?.validation.final ?? [];
    if (final.length) {
      const res = await this.runChecks(state, "integration", final, integrationWorktreePath(r.execution));
      if (!res.ok) {
        const failed = res.failed.map((f) => f.id).join(", ");
        await recordOutcome("validation_failed", undefined, {
          key: `final_validation:${sha}:${state.seq}`,
          kind: "blocker",
          summary: `Every task is accepted, but the final validation failed on the integration branch (${sha.slice(0, 12)}): ${failed}.`,
          question: "Add a task to fix it, amend the validation, or accept the result as it is?",
          options: ["Add a fix-up task with amend_contract", "Amend the final validation", "Abort the run"],
        });
        r.say(`final validation failed (${failed}): escalated`);
        return;
      }
    }

    // 2. The goal review (WS10's lead; the default says COMPLETE).
    let review;
    try {
      review = await r.hooks.goalReview(r.ctx, { integrationSha: sha, state });
    } catch (e) {
      const errors = outcomes.filter((event) => event.seq > resolved && event.type === "note.posted" && JSON.parse(event.payload.text).outcome === "review_error").length + 1;
      await recordOutcome("review_error", errors < 3 ? Date.now() + 5 * 60_000 : undefined, errors >= 3 ? {
        key: `goal_review_error:${key}:${state.seq}`, kind: "blocker",
        summary: `The goal review failed ${errors} times: ${scrubAndCap(errText(e), 1500)}`,
      } : undefined);
      r.say(`goal review failed (${errors}/3): ${errText(e)}`);
      return;
    }
    if (review.verdict !== "COMPLETE") {
      await recordOutcome("incomplete", undefined, {
        key: `goal_incomplete:${key}:${state.seq}`, kind: "blocker",
        summary: `Goal review is INCOMPLETE: ${review.reason ?? "the integrated result needs review"}`,
      }, true);
      r.say(`goal review: ${review.verdict}${review.reason ? ` (${review.reason})` : ""}; the run stays open`);
      return;
    }

    if (r.isStopping()) return;
    const completed = await r.store.transact(({ state: s }) => {
      if (r.isStopping() || s.status !== "running" || !allAccepted(s) || s.contract?.version !== state.contract?.version) return { events: [] };
      return { events: [{ type: "execution.completed", source: r.source, payload: { integration_sha: sha } }] };
    });
    if (!completed.events.length) return;
    r.say(`the run completed at ${sha.slice(0, 12)}`);

    await this.publishCompleted(state, sha);
  }

  /** Retried on terminal startup if a crash interrupted publication after completion. */
  async publishCompleted(state: Readonly<BlackboardState>, sha: string): Promise<void> {
    const r = this.r;
    if (r.isStopping() || state.notes.some((n) => n.agent === "runner" && n.topic === "pull_request")) return;
    const gh = r.githubSettings();
    if (gh?.pr && gh.repo) {
      try {
        const prUrl = await openPullRequest(r, state, gh.repo, sha);
        await r.commit([{ type: "note.posted", source: r.source, payload: { topic: "pull_request", text: `Pull request: ${prUrl}`, refs: [prUrl] } }]);
        r.say(`opened ${prUrl}`);
      } catch (e) {
        r.say(`no pull request: ${errText(e)}`);
      }
    }
  }
}

// ============================================================================
// Pushing the integration branch and opening the pull request
// ============================================================================

const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The remote whose URL names `repo` (owner/name), else origin. */
async function remoteFor(repoRoot: string, repo: string): Promise<string> {
  const t = await openRepo(repoRoot);
  const r = await runGit(t, ["remote", "-v"]);
  const want = repo.toLowerCase();
  for (const line of r.stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(push\)$/.exec(line.trim());
    if (!m) continue;
    const url = m[2].toLowerCase().replace(/\.git$/, "");
    if (url.endsWith(`/${want}`) || url.endsWith(`:${want}`)) return m[1];
  }
  return "origin";
}

/**
 * Push refs/heads/<integration> to the same name on the remote, never another ref: the base
 * branch is out of reach by construction. Git's hardening stays on except transports (a push
 * needs one); hooks never run (--no-verify, core.hooksPath=/dev/null).
 */
export async function pushIntegrationBranch(repoRoot: string, executionId: string, repo: string, base: string): Promise<void> {
  const branch = integrationBranch(executionId);
  assertSafeRef(branch);
  if (branch === base || `refs/heads/${branch}` === base) throw new Error(`Refusing to push: the base branch ${base} is the integration branch`);
  const remote = await remoteFor(repoRoot, repo);
  if (!REMOTE_RE.test(remote)) throw new Error(`Unusable remote name ${remote}`);
  const t = await openRepo(repoRoot);
  await runGit(t, [
    "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "push.recurseSubmodules=no",
    "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
    "push", "--no-verify", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`,
  ], { timeoutMs: 120_000, maxOutputBytes: 1 << 20 });
}

function prBody(state: Readonly<BlackboardState>, sha: string): string {
  const c = state.contract!;
  const tasks = Object.values(state.tasks).filter((rt) => rt.state === "accepted");
  const lines = [
    `Heads-down run \`${state.execution}\` (contract ${c.id} v${c.version}).`,
    "",
    `**Goal:** ${state.goal?.ultimate ?? c.goal.ultimate}`,
    "",
    `**Tasks (${tasks.length}):**`,
    ...tasks.map((rt) => `- \`${rt.spec.id}\`: ${rt.spec.title}${own(state.diffs, rt.spec.id)?.stat ? ` (${state.diffs[rt.spec.id].stat})` : ""}`),
    "",
    `Integration head: \`${sha}\`. Review before merging: nothing here merges by itself.`,
  ];
  return redact(lines.join("\n")).text;
}

/** Push the integration branch and open a pull request into the contract's base branch; returns its URL. */
export async function openPullRequest(r: Runner, state: Readonly<BlackboardState>, repo: string, sha: string): Promise<string> {
  const base = state.contract?.scope.base_ref;
  if (!base) throw new Error("the contract names no base branch");
  assertSafeRef(base);
  await pushIntegrationBranch(r.header.repo_root, r.execution, repo, base);
  const existing = await runGh(["pr", "list", "--repo", repo, "--base", base, "--head", integrationBranch(r.execution), "--state", "all", "--json", "url", "--limit", "1"]);
  const found = JSON.parse(existing.stdout) as Array<{ url?: string }>;
  if (found[0]?.url && /^https:\/\/\S+$/.test(found[0].url)) return found[0].url;
  const title = redact(`[roundtable] ${state.contract!.title}`).text.slice(0, 200);
  const out = await withBodyFile(prBody(state, sha), (file) =>
    runGh(["pr", "create", "--repo", repo, "--base", base, "--head", integrationBranch(r.execution), "--title", title, "--body-file", file], { timeoutMs: 60_000 })
  );
  const url = out.stdout.trim().split("\n").pop() ?? "";
  if (!/^https:\/\/\S+$/.test(url)) throw new Error("gh pr create did not print a URL");
  return url;
}

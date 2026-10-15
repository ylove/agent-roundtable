// A fake `gh` for the GitHub sync tests. The test writes an executable `gh` wrapper into a temp
// directory that imports this file; that directory holds the fake's state:
//   calls.jsonl  every call: {argv, stdin, body} (body = the --body-file content, read at call time)
//   state.json   issues, labels, project fields, auth scopes and permission
//   fail.json    [{match, times, stderr, code}]: calls whose argv (joined by spaces) contains
//                `match` fail that many times
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = dirname(process.argv[1]);
const argv = process.argv.slice(2);
const statePath = join(dir, "state.json");
const failPath = join(dir, "fail.json");

const DEFAULT_FIELDS = [
  { id: "PVTF_title", name: "Title", type: "ProjectV2Field" },
  {
    id: "PVTSSF_status", name: "Status", type: "ProjectV2SingleSelectField",
    options: [{ id: "opt_todo", name: "Todo" }, { id: "opt_prog", name: "In Progress" }, { id: "opt_done", name: "Done" }],
  },
];

const load = () =>
  existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { issues: [], labels: [], fields: DEFAULT_FIELDS, scopes: "repo, project, read:org", permission: "WRITE", next: 1 };
const state = load();
state.fields ??= DEFAULT_FIELDS;
state.next ??= 1;
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));

let stdin = "";
if (!process.stdin.isTTY) {
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
}
const bodyFile = flag("--body-file");
const body = bodyFile && bodyFile !== "-" ? readFileSync(bodyFile, "utf8") : bodyFile === "-" ? stdin : undefined;
const env = Object.keys(process.env).sort();
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv, env, cwd: process.cwd(), ...(stdin && { stdin }), ...(body !== undefined && { body }) }) + "\n");

const out = (v) => {
  process.stdout.write(typeof v === "string" ? v + "\n" : JSON.stringify(v) + "\n");
  process.exit(0);
};
const fail = (msg, code = 1) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};

if (existsSync(failPath)) {
  const rules = JSON.parse(readFileSync(failPath, "utf8"));
  const line = argv.join(" ");
  const rule = rules.find((r) => r.times > 0 && line.includes(r.match));
  if (rule) {
    rule.times--;
    writeFileSync(failPath, JSON.stringify(rules));
    fail(rule.stderr ?? "HTTP 500: something went wrong", rule.code ?? 1);
  }
}

const repo = flag("--repo") ?? "acme/app";
const issueUrl = (n) => `https://github.com/${repo}/issues/${n}`;
const byNumber = (n) => state.issues.find((i) => i.number === Number(n));
const [a0, a1, a2] = argv;
/** The login gh acts as. */
const me = state.login ?? "bot";

if (a0 === "auth" && a1 === "status") {
  if (state.loggedOut) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  if (argv.includes("--json")) out({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "bot", scopes: state.scopes }] } });
  out(`github.com\n  ✓ Logged in to github.com account bot\n  - Token scopes: ${state.scopes.split(", ").map((s) => `'${s}'`).join(", ")}`);
}
if (a0 === "repo" && a1 === "view") out({ viewerPermission: state.permission, hasIssuesEnabled: true });
if (a0 === "label" && a1 === "list") out(state.labels.map((name) => ({ name })));
if (a0 === "label" && a1 === "create") {
  if (state.labels.includes(a2)) fail(`label with name "${a2}" already exists; use \`--force\` to update its color and description`);
  state.labels.push(a2);
  save();
  out("");
}
// The phrase is matched; author:@me and label: qualifiers are deliberately ignored, so the sync's
// own checks on author and labels are what the tests exercise.
if (a0 === "issue" && a1 === "list") {
  const phrase = /"([^"]+)"/.exec(flag("--search") ?? "")?.[1] ?? "";
  out(
    state.issues
      .filter((i) => !state.searchLag && i.body.includes(phrase))
      .map((i) => ({
        number: i.number, url: issueUrl(i.number), id: `I_${i.number}`, body: i.body, state: i.closed ? "CLOSED" : "OPEN",
        author: { login: i.author ?? me }, labels: i.labels.map((name) => ({ name })),
      }))
  );
}
if (a0 === "issue" && a1 === "create") {
  const n = state.next++;
  state.issues.push({ number: n, title: flag("--title"), body, labels: all("--label"), comments: [], closed: false, author: me });
  save();
  out(issueUrl(n));
}
if (a0 === "issue" && a1 === "view") {
  const i = byNumber(a2);
  if (!i) fail("GraphQL: Could not resolve to an issue or pull request with the number of " + a2);
  if (flag("--json") === "comments") out({ comments: i.comments.map((c) => ({ body: c.body ?? c, author: { login: c.author ?? me } })) });
  out({ id: `I_${i.number}`, number: i.number, url: issueUrl(i.number) });
}
if (a0 === "issue" && a1 === "comment") {
  byNumber(a2).comments.push({ body, author: me });
  save();
  out(`${issueUrl(a2)}#issuecomment-1`);
}
if (a0 === "issue" && a1 === "edit") {
  const i = byNumber(a2);
  for (const l of all("--add-label")) if (!i.labels.includes(l)) i.labels.push(l);
  for (const l of all("--remove-label")) i.labels = i.labels.filter((x) => x !== l);
  save();
  out(issueUrl(a2));
}
if (a0 === "issue" && a1 === "close") {
  byNumber(a2).closed = true;
  save();
  out("");
}
if (a0 === "api" && a1 === "graphql") {
  const vars = Object.fromEntries(all("-f").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  if (/^query \{ viewer \{ login \} \}$/.test(vars.query ?? "")) out({ data: { viewer: { login: me } } });
  if (!/addSubIssue/.test(vars.query ?? "")) fail("unexpected query");
  const child = byNumber(Number(vars.child.slice(2)));
  child.parent = vars.parent;
  save();
  out({ data: { addSubIssue: { subIssue: { id: vars.child } } } });
}
if (a0 === "project" && a1 === "view") out({ id: `PVT_${a2}`, number: Number(a2), title: "Board" });
if (a0 === "project" && a1 === "create") out({ id: "PVT_new", number: 9, title: flag("--title"), url: "https://github.com/orgs/acme/projects/9" });
if (a0 === "project" && a1 === "field-list") out({ fields: state.fields, totalCount: state.fields.length });
if (a0 === "project" && a1 === "field-create") {
  const names = (flag("--single-select-options") ?? "").split(",");
  const field = { id: "PVTSSF_rt", name: flag("--name"), type: "ProjectV2SingleSelectField", options: names.map((n, i) => ({ id: `rt_${i}`, name: n })) };
  state.fields.push(field);
  save();
  out({ id: field.id, name: field.name, type: field.type });
}
if (a0 === "project" && a1 === "item-add") out({ id: `PVTI_${/\/issues\/(\d+)$/.exec(flag("--url"))[1]}`, type: "Issue" });
if (a0 === "project" && a1 === "item-edit") out({ id: flag("--id") });
fail(`fake gh: unknown command: ${argv.slice(0, 2).join(" ")}`);

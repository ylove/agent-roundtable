// ============================================================================
// Contracts: normalization, validation, hashing, rendering and merge patches (heads-down.md §7)
//
// checkContract(input) applies CONTRACT_DEFAULTS and every structural rule synchronously;
// validateContract(input) adds persona resolution through loadAgent. Both return the normalized
// contract with the errors and warnings found: a contract is usable only when ok. Error strings
// name the field ("tasks[1].depends_on[0] ..."), so a structuring retry can quote them back.
// ============================================================================

import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AGENTS_DIR } from "../config.js";
import { readUserConfig } from "../user-config.js";
import { CONNECTOR_NAME } from "../connectors/config.js";
import { isPathLikeRef, loadAgent } from "../agents.js";
import { normalizeRelPath } from "../security/fs-safe.js";
import { scrubSecrets } from "../security/secrets.js";
import { DEFAULT_SANDBOX_IMAGE, isPrivilegedCommand, isShellCommand, resolveCwd, validateArgv } from "../sandbox/common.js";
import { canonicalJSON, sha256Hex } from "./chain.js";
import { ID_RE } from "./events.js";
import {
  CONTRACT_DEFAULTS,
  CONTRACT_SCHEMA,
  type ArtifactRef,
  type AuthorityAction,
  type CommandSpec,
  type Contract,
  type ContractStatus,
  type ConsentVerdict,
  type Decision,
  type InterfaceSpec,
  type TaskSpec,
} from "./types.js";

/** `ctr-<exe6>-<n>`: the execution's 6-character tag and the contract's number within it. */
export const CONTRACT_ID_RE = /^ctr-([0-9a-hjkmnp-tv-z]{6})-([1-9][0-9]{0,5})$/;

export const AUTHORITY_ACTIONS: readonly AuthorityAction[] = [
  "retry", "reassign", "split_task", "add_task", "amend_interfaces", "extend_budget", "resolve_merge",
];
const STATUSES: readonly ContractStatus[] = ["draft", "consenting", "frozen", "superseded", "closed"];
const VERDICTS: readonly ConsentVerdict[] = ["AGREE", "OBJECT", "UNCLEAR", "EXCUSED"];
const TASK_KINDS = ["build", "subcontract", "review"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const INTERFACE_KINDS = ["type", "api", "schema", "design", "doc", "other"] as const;
const ARTIFACT_KINDS = ["file", "blob", "text", "url"] as const;
const BACKENDS = ["docker", "local"] as const;
const DRIVERS = ["claude-code", "codex"] as const;

export const COMMAND_TIMEOUT_S = { min: 1, max: 900, default: 300 } as const;
export const MAX_PARALLEL_LIMIT = 16;
/** Size caps: a contract is a plan for one run, not a backlog. */
export const CONTRACT_LIMITS = { tasks: 200, commands: 100, participants: 50, interfaces: 200, decisions: 200, globs: 64,
  dissents: 16, dissent_claim: 500, dissent_prediction: 500 } as const;

/**
 * Env names a contract command may not set: broader than SECRET_NAME_RE on purpose, since a
 * contract's env is copied into every check run (DATABASE_URL and DSN carry credentials in the value).
 */
export const CONTRACT_SECRET_ENV_RE = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE|SESSION|(^|_)PAT$|DATABASE_URL|DSN/i;
/**
 * Budget values used when a structure (a fenced block or a structuring call) gives none. Each use
 * is reported as a warning; execute asks the human to confirm the real cap.
 */
export const BUDGET_FALLBACK = { usd: 20, per_task_usd: 5, wall_clock_min: 120 } as const;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Task ids that would clash with run infrastructure: rt/<exe6>/integration is the integration branch. */
export const RESERVED_TASK_IDS: readonly string[] = ["integration"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const q = (v: unknown) => JSON.stringify(typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v);

const clone = <T>(v: T): T => structuredClone(v);

/** Own-property write that is safe for any key, "__proto__" included. */
function put(obj: Obj, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A contract id for the n-th contract of an execution. */
export function contractIdFor(executionId: string, n = 1): string {
  return `ctr-${executionId.slice(-6)}-${n}`;
}

/** The 6-character execution tag a contract id carries, or null when it is not a contract id. */
export function contractTag(contractId: string): string | null {
  const m = typeof contractId === "string" ? CONTRACT_ID_RE.exec(contractId) : null;
  return m ? m[1] : null;
}

/** contracts/<ctr>/v<N>.json inside an execution directory (for people and tools; the reducer reads blobs). */
export function contractPath(store: { dir: string }, id: string, version: number): string {
  if (!CONTRACT_ID_RE.test(id)) throw new Error(`Not a contract id: ${q(id)}`);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Not a contract version: ${q(version)}`);
  return join(store.dir, "contracts", id, `v${version}.json`);
}

/** contracts/<ctr>/CONTRACT.md: the latest version, rendered. */
export function contractMarkdownPath(store: { dir: string }, id: string): string {
  if (!CONTRACT_ID_RE.test(id)) throw new Error(`Not a contract id: ${q(id)}`);
  return join(store.dir, "contracts", id, "CONTRACT.md");
}

// ---------------------------------------------------------------------------
// Globs: ** * ? only, compared conservatively
// ---------------------------------------------------------------------------

const hasWild = (s: string) => /[*?]/.test(s);

function segRegex(seg: string): RegExp {
  const body = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/** Whether every path the inner segment matches is matched by the outer one (false when unsure). */
function segWithin(inner: string, outer: string): boolean {
  if (inner === outer || outer === "*") return true;
  if (!hasWild(inner)) return segRegex(outer).test(inner);
  // "*.ts" inside "*s": both are star-prefixed, compare the literal tails.
  if (/^\*[^*?]*$/.test(outer) && /^\*[^*?]*$/.test(inner)) return inner.slice(1).endsWith(outer.slice(1));
  return false;
}

function segsWithin(inner: string[], outer: string[], i = 0, j = 0, seen = new Set<string>()): boolean {
  const key = `${i},${j}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (j === outer.length) return i === inner.length;
  if (outer[j] === "**") {
    // ** in the outer glob absorbs zero or more inner segments, including an inner **.
    for (let k = i; k <= inner.length; k++) if (segsWithin(inner, outer, k, j + 1, seen)) return true;
    return false;
  }
  if (i === inner.length || inner[i] === "**") return false;
  return segWithin(inner[i], outer[j]) && segsWithin(inner, outer, i + 1, j + 1, seen);
}

/** True when every path `inner` can match is also matched by `outer` (both normalized globs). */
export function globWithin(inner: string, outer: string): boolean {
  return segsWithin(inner.split("/"), outer.split("/"));
}

/** A normalized repository-relative glob, or the reason it is not one. */
export function normalizeGlob(raw: unknown): { glob: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "must be a non-empty string" };
  if (raw.trim().startsWith("!")) return { error: "is a negated glob, which is not supported" };
  if (/[[\]{}]/.test(raw)) return { error: "may use only the wildcards **, * and ? (no brackets or braces)" };
  const glob = normalizeRelPath(raw.trim());
  if (glob === null) return { error: "must be a repository-relative path or glob (no absolute path, '..' or NUL)" };
  if (glob.split("/").some((seg) => seg.includes("**") && seg !== "**")) return { error: "uses ** inside a path segment; ** must be a whole segment" };
  return { glob };
}

// ---------------------------------------------------------------------------
// Normalization and validation
// ---------------------------------------------------------------------------

export interface ContractValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The normalized contract (defaults applied). Only a contract with ok: true may be stored. */
  contract: Contract;
}

export interface ParentContext {
  contract: Contract;
  /** The parent's sub-orchestration depth (0 at the top). */
  depth: number;
  /** What the parent run has left (its budget, extensions included, minus what it has spent). */
  remainingUsd?: number;
  /** Budgets of the parent task's other child contracts, which share its cap. */
  siblingsUsd?: number;
}

export interface CheckOptions {
  /** The parent of a child contract (scope.parent). */
  parent?: ParentContext;
}

/** What a child of `task` may have in total: the task's budget (else the parent's per-task cap) and the parent's remaining budget. */
export function childBudgetCap(parent: ParentContext, taskId: string): number {
  const task = parent.contract.tasks.find((t) => t.id === taskId);
  const taskCap = Math.min(task?.budget_usd ?? parent.contract.budget.per_task_usd, parent.contract.budget.per_task_usd);
  return Math.min(taskCap, parent.remainingUsd ?? Infinity);
}

export interface ValidateOptions extends CheckOptions {
  /** Resolve personas through loadAgent (default true). */
  personas?: boolean;
}

class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  err(path: string, msg: string): void {
    this.errors.push(path ? `${path} ${msg}` : msg);
  }
  warn(path: string, msg: string): void {
    this.warnings.push(path ? `${path} ${msg}` : msg);
  }
  known(obj: Obj, keys: readonly string[], path: string): void {
    for (const k of Object.keys(obj)) {
      if (!keys.includes(k) && obj[k] !== undefined) this.err(`${path}${path ? "." : ""}${k}`, `is not a known field (expected: ${keys.join(", ")})`);
    }
  }
  obj(v: unknown, path: string, required = false): Obj | undefined {
    if (v === undefined || v === null) {
      if (required) this.err(path, "is required");
      return undefined;
    }
    if (!isObj(v)) {
      this.err(path, "must be an object");
      return undefined;
    }
    return v;
  }
  arr(v: unknown, path: string, max?: number): unknown[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.err(path, "must be an array");
      return [];
    }
    if (max !== undefined && v.length > max) this.err(path, `has ${v.length} items; the limit is ${max}`);
    return v;
  }
  str(v: unknown, path: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    if (v === undefined || v === null) {
      if (opts.required) this.err(path, "is required");
      return undefined;
    }
    if (typeof v !== "string" || !v.trim()) {
      this.err(path, "must be a non-empty string");
      return undefined;
    }
    if (v.includes("\0")) {
      this.err(path, "contains a NUL byte");
      return undefined;
    }
    if (opts.max !== undefined && v.length > opts.max) this.err(path, `is longer than ${opts.max} characters`);
    return v.trim();
  }
  text(v: unknown, path: string, fallback = ""): string {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") {
      this.err(path, "must be a string");
      return fallback;
    }
    return v;
  }
  strs(v: unknown, path: string): string[] {
    return this.arr(v, path).flatMap((item, i) => {
      const s = this.str(item, `${path}[${i}]`);
      return s === undefined ? [] : [s];
    });
  }
  id(v: unknown, path: string, required = true): string | undefined {
    if (v === undefined || v === null) {
      if (required) this.err(path, "is required");
      return undefined;
    }
    if (typeof v !== "string" || !ID_RE.test(v)) {
      this.err(path, `must be an id: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, at most 64 (got ${q(v)})`);
      return undefined;
    }
    return v;
  }
  oneOf<T extends string>(v: unknown, path: string, options: readonly T[], fallback?: T): T | undefined {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string" || !options.includes(v as T)) {
      this.err(path, `must be one of: ${options.join(", ")} (got ${q(v)})`);
      return fallback;
    }
    return v as T;
  }
  num(v: unknown, path: string, opts: { min?: number; max?: number; gt?: number; int?: boolean } = {}): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || (opts.int && !Number.isSafeInteger(v))) {
      this.err(path, opts.int ? "must be an integer" : "must be a finite number");
      return undefined;
    }
    if (opts.gt !== undefined && !(v > opts.gt)) this.err(path, `must be greater than ${opts.gt}`);
    if (opts.min !== undefined && v < opts.min) this.err(path, `must be at least ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) this.err(path, `must be at most ${opts.max}`);
    return v;
  }
}

function artifacts(ck: Checker, v: unknown, path: string): ArtifactRef[] {
  return ck.arr(v, path).flatMap((item, i) => {
    const p = `${path}[${i}]`;
    const o = ck.obj(item, p, true);
    if (!o) return [];
    ck.known(o, ["kind", "ref", "title"], p);
    const kind = ck.oneOf(o.kind, `${p}.kind`, ARTIFACT_KINDS);
    const ref = ck.str(o.ref, `${p}.ref`, { required: true });
    const title = ck.str(o.title, `${p}.title`);
    if (!kind || !ref) return [];
    return [{ kind, ref, ...(title !== undefined && { title }) }];
  });
}

function globs(ck: Checker, v: unknown, path: string): string[] {
  const out: string[] = [];
  for (const [i, raw] of ck.arr(v, path, CONTRACT_LIMITS.globs).entries()) {
    const r = normalizeGlob(raw);
    if ("error" in r) ck.err(`${path}[${i}]`, `${q(raw)} ${r.error}`);
    else if (!out.includes(r.glob)) out.push(r.glob);
  }
  return out;
}

function argvOf(ck: Checker, v: unknown, path: string, backend: string | undefined): string[] | undefined {
  if (v === undefined || v === null) {
    ck.err(path, "is required");
    return undefined;
  }
  let argv: string[];
  try {
    argv = validateArgv(v);
  } catch (e) {
    ck.err(path, `${e instanceof Error ? e.message.replace(/^argv\s*/, "") : String(e)} (a structured argv such as ["npm", "test"], never a shell string)`);
    return undefined;
  }
  if (isPrivilegedCommand(argv)) {
    ck.err(path, `runs ${argv.slice(0, 2).join(" ")}: commands never change identity (sudo, doas, su, pkexec and run0 are refused on every backend)`);
    return undefined;
  }
  if (isShellCommand(argv)) {
    const msg = `runs a shell command line (${argv.slice(0, 3).join(" ")} …): give the program and its arguments as argv instead`;
    if (backend === "local") ck.err(path, `${msg}; shell command lines are refused on the local sandbox backend`);
    else ck.warn(path, `${msg}; allowed only because the sandbox backend is docker`);
  }
  return argv;
}

function commandSpec(ck: Checker, v: unknown, path: string, backend: string | undefined): CommandSpec | undefined {
  const o = ck.obj(v, path, true);
  if (!o) return undefined;
  ck.known(o, ["id", "argv", "cwd", "timeout_s", "env"], path);
  const id = ck.id(o.id, `${path}.id`);
  const argv = argvOf(ck, o.argv, `${path}.argv`, backend);
  let cwd: string | undefined;
  if (o.cwd !== undefined && o.cwd !== null) {
    try {
      cwd = typeof o.cwd === "string" ? resolveCwd(o.cwd) || undefined : (ck.err(`${path}.cwd`, "must be a string"), undefined);
    } catch (e) {
      ck.err(`${path}.cwd`, e instanceof Error ? e.message.replace(/^cwd\s*/, "") : String(e));
    }
  }
  const timeout = o.timeout_s === undefined || o.timeout_s === null
    ? COMMAND_TIMEOUT_S.default
    : ck.num(o.timeout_s, `${path}.timeout_s`, { min: COMMAND_TIMEOUT_S.min, max: COMMAND_TIMEOUT_S.max });
  let env: Record<string, string> | undefined;
  const envObj = ck.obj(o.env, `${path}.env`);
  if (envObj) {
    env = {};
    for (const [k, val] of Object.entries(envObj)) {
      if (!ENV_KEY_RE.test(k)) ck.err(`${path}.env`, `name ${q(k)} is not a valid variable name`);
      else if (CONTRACT_SECRET_ENV_RE.test(k)) ck.err(`${path}.env.${k}`, "looks like a credential: secrets never go in a contract or the sandbox");
      else if (typeof val !== "string") ck.err(`${path}.env.${k}`, "must be a string");
      else if (val.includes("\0")) ck.err(`${path}.env.${k}`, "contains a NUL byte");
      // Stored contracts are scrubbed: a value scrubbing would change could not run as validated.
      else if (scrubSecrets(val).text !== val) ck.err(`${path}.env.${k}`, "has a value that looks like a credential: secrets never go in a contract or the sandbox");
      else put(env, k, val);
    }
  }
  if (!id || !argv || timeout === undefined) return undefined;
  return { id, argv, ...(cwd && { cwd }), timeout_s: timeout, ...(env && Object.keys(env).length > 0 && { env }) };
}

/** Kahn's algorithm over depends_on; returns one cycle (a → … → a) when the graph has any. */
export function findCycle(tasks: ReadonlyArray<Pick<TaskSpec, "id" | "depends_on">>): string[] | null {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, indegree.get(t.id) ?? 0);
    for (const d of t.depends_on) {
      if (!ids.has(d)) continue;
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
    }
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let done = 0;
  while (queue.length) {
    const id = queue.shift()!;
    done++;
    for (const next of dependents.get(id) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (done === indegree.size) return null;
  // Every node left over is on a cycle or downstream of one: walk dependencies until one repeats.
  const left = new Set([...indegree].filter(([, n]) => n > 0).map(([id]) => id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let at = [...left][0];
  const path: string[] = [];
  while (!path.includes(at)) {
    path.push(at);
    at = byId.get(at)!.depends_on.find((d) => left.has(d))!;
  }
  return [...path.slice(path.indexOf(at)), at];
}

function normalize(input: unknown, ck: Checker, opts: CheckOptions): Contract {
  const c = isObj(input) ? input : (ck.err("", "the contract must be a JSON object"), {} as Obj);
  ck.known(c, ["schema", "id", "version", "status", "title", "goal", "scope", "participants", "teams", "tasks", "interfaces",
    "decisions", "dissents", "validation", "budget", "authority", "sandbox", "workers", "connectors", "postmortem", "consent", "frozen"], "");
  if (c.schema !== undefined && c.schema !== CONTRACT_SCHEMA) ck.err("schema", `must be ${q(CONTRACT_SCHEMA)}`);
  let id = "";
  if (c.id === undefined || c.id === null) ck.err("id", "is required");
  else if (typeof c.id !== "string" || !CONTRACT_ID_RE.test(c.id)) ck.err("id", `must be a contract id like ctr-ab12cd-1 (got ${q(c.id)})`);
  else id = c.id;
  const version = c.version === undefined ? 1 : ck.num(c.version, "version", { min: 1, int: true }) ?? 1;
  const status = ck.oneOf(c.status, "status", STATUSES, "draft")!;
  const title = ck.str(c.title, "title", { required: true, max: 200 }) ?? "";

  // --- goal ---
  const g = ck.obj(c.goal, "goal", true) ?? {};
  ck.known(g, ["ultimate", "original_prompt", "artifacts", "source_session"], "goal");
  const goal: Contract["goal"] = {
    ultimate: ck.str(g.ultimate, "goal.ultimate", { required: true }) ?? "",
    original_prompt: typeof g.original_prompt === "string" && g.original_prompt.trim()
      ? g.original_prompt
      : (ck.err("goal.original_prompt", "is required: the human's request, verbatim"), ""),
    artifacts: artifacts(ck, g.artifacts, "goal.artifacts"),
  };
  const source = ck.str(g.source_session, "goal.source_session");
  if (source !== undefined) goal.source_session = source;

  // --- sandbox and workers (the backend decides how shell command lines are treated) ---
  const sb = ck.obj(c.sandbox, "sandbox") ?? {};
  ck.known(sb, ["backend", "image", "install"], "sandbox");
  const backend = ck.oneOf(sb.backend, "sandbox.backend", BACKENDS, "docker")!;
  const sandbox: Contract["sandbox"] = { backend, image: ck.str(sb.image, "sandbox.image", { max: 255 }) ?? DEFAULT_SANDBOX_IMAGE };
  const inst = ck.obj(sb.install, "sandbox.install");
  if (inst) {
    ck.known(inst, ["argv", "egress"], "sandbox.install");
    const argv = argvOf(ck, inst.argv, "sandbox.install.argv", backend);
    const egress = ck.strs(inst.egress, "sandbox.install.egress");
    for (const [i, host] of egress.entries()) {
      if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(host)) ck.err(`sandbox.install.egress[${i}]`, `${q(host)} must be a host name (optionally *.domain or host:port)`);
      // A wildcard needs a registrable domain under it: *.npmjs.org, never *.com.
      else if (host.startsWith("*.") && host.slice(2).split(":")[0].split(".").filter(Boolean).length < 2) {
        ck.err(`sandbox.install.egress[${i}]`, `${q(host)} is too broad: a wildcard needs at least two labels after "*." (e.g. *.npmjs.org)`);
      }
    }
    if (argv) sandbox.install = { argv, egress };
  }
  const wk = ck.obj(c.workers, "workers") ?? {};
  ck.known(wk, ["driver", "model", "fallback_model"], "workers");
  const workers: Contract["workers"] = { driver: ck.oneOf(wk.driver, "workers.driver", DRIVERS, "claude-code")! };
  const model = ck.str(wk.model, "workers.model");
  const fallback = ck.str(wk.fallback_model, "workers.fallback_model");
  if (model !== undefined) workers.model = model;
  if (fallback !== undefined) workers.fallback_model = fallback;

  // --- postmortem mode (docs/design/postmortem.md §2): kept out of the contract unless enabled, so older hashes stand ---
  const pm = ck.obj(c.postmortem, "postmortem");
  let postmortem: Contract["postmortem"];
  if (pm) {
    ck.known(pm, ["enabled"], "postmortem");
    if (pm.enabled !== undefined && typeof pm.enabled !== "boolean") ck.err("postmortem.enabled", "must be true or false");
    if (pm.enabled === true) postmortem = { enabled: true };
  }

  // --- validation commands (tasks reference them) ---
  const val = ck.obj(c.validation, "validation") ?? {};
  ck.known(val, ["commands", "final"], "validation");
  const commands: CommandSpec[] = [];
  for (const [i, raw] of ck.arr(val.commands, "validation.commands", CONTRACT_LIMITS.commands).entries()) {
    const spec = commandSpec(ck, raw, `validation.commands[${i}]`, backend);
    if (!spec) continue;
    if (commands.some((x) => x.id === spec.id)) ck.err(`validation.commands[${i}].id`, `${q(spec.id)} appears twice`);
    else commands.push(spec);
  }
  const commandIds = new Set(commands.map((x) => x.id));
  const final = val.final === undefined || val.final === null ? commands.map((x) => x.id) : ck.strs(val.final, "validation.final");
  for (const [i, f] of final.entries()) if (!commandIds.has(f)) ck.err(`validation.final[${i}]`, `names unknown command ${q(f)}`);

  // --- scope ---
  const sc = ck.obj(c.scope, "scope", true) ?? {};
  ck.known(sc, ["orchestrator", "parent", "repo_root", "base_ref", "paths"], "scope");
  const repoRoot = ck.str(sc.repo_root, "scope.repo_root", { required: true }) ?? "";
  if (repoRoot && !isAbsolute(repoRoot)) ck.err("scope.repo_root", "must be an absolute path");
  const scope: Contract["scope"] = {
    orchestrator: ck.str(sc.orchestrator, "scope.orchestrator", { required: true, max: 200 }) ?? "",
    repo_root: repoRoot,
    base_ref: ck.str(sc.base_ref, "scope.base_ref", { required: true }) ?? "",
    paths: [],
  };
  const parentRef = ck.obj(sc.parent, "scope.parent");
  if (parentRef) {
    ck.known(parentRef, ["contract", "task"], "scope.parent");
    const pc = typeof parentRef.contract === "string" && CONTRACT_ID_RE.test(parentRef.contract)
      ? parentRef.contract : (ck.err("scope.parent.contract", "must be a contract id"), undefined);
    const pt = ck.id(parentRef.task, "scope.parent.task");
    if (pc && pt) scope.parent = { contract: pc, task: pt };
  }
  const parentTask = scope.parent && opts.parent ? opts.parent.contract.tasks.find((t) => t.id === scope.parent!.task) : undefined;
  scope.paths = sc.paths === undefined || sc.paths === null ? (parentTask ? [...parentTask.paths.write] : ["**"]) : globs(ck, sc.paths, "scope.paths");
  if (scope.paths.length === 0) ck.err("scope.paths", "must list at least one path or glob the contract may write");

  // --- participants and teams ---
  const participants: Contract["participants"] = [];
  for (const [i, raw] of ck.arr(c.participants, "participants", CONTRACT_LIMITS.participants).entries()) {
    const p = `participants[${i}]`;
    const o = typeof raw === "string" ? { agent: raw } : ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["agent", "role", "team"], p);
    const agent = ck.str(o.agent, `${p}.agent`, { required: true });
    const role = ck.str(o.role, `${p}.role`);
    const team = ck.str(o.team, `${p}.team`);
    if (!agent) continue;
    if (participants.some((x) => x.agent === agent)) {
      ck.err(`${p}.agent`, `${q(agent)} appears twice`);
      continue;
    }
    participants.push({ agent, ...(role !== undefined && { role }), ...(team !== undefined && { team }) });
  }
  const teams: Contract["teams"] = [];
  for (const [i, raw] of ck.arr(c.teams, "teams").entries()) {
    const p = `teams[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["id", "lead", "members"], p);
    const tid = ck.id(o.id, `${p}.id`);
    const lead = ck.str(o.lead, `${p}.lead`);
    const members = [...new Set(ck.strs(o.members, `${p}.members`))];
    if (!tid) continue;
    if (teams.some((x) => x.id === tid)) {
      ck.err(`${p}.id`, `${q(tid)} appears twice`);
      continue;
    }
    if (lead !== undefined && !members.includes(lead)) members.unshift(lead);
    teams.push({ id: tid, ...(lead !== undefined && { lead }), members });
  }
  const teamIds = new Set(teams.map((t) => t.id));

  // --- tasks ---
  const rawTasks = ck.arr(c.tasks, "tasks", CONTRACT_LIMITS.tasks);
  if (c.tasks === undefined || c.tasks === null || (Array.isArray(c.tasks) && c.tasks.length === 0)) ck.err("tasks", "must list at least one task");
  const tasks: TaskSpec[] = [];
  for (const [i, raw] of rawTasks.entries()) {
    const p = `tasks[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["id", "title", "team", "persona", "kind", "depends_on", "paths", "acceptance", "checks", "verify", "effort", "budget_usd", "context"], p);
    const tid = ck.id(o.id, `${p}.id`);
    if (tid !== undefined && RESERVED_TASK_IDS.includes(tid)) {
      ck.err(`${p}.id`, `${q(tid)} is reserved: its branch would clash with the run's integration branch`);
    }
    const taskTitle = ck.str(o.title, `${p}.title`, { required: true, max: 200 });
    const persona = ck.str(o.persona, `${p}.persona`, { required: true });
    const kind = ck.oneOf(o.kind, `${p}.kind`, TASK_KINDS, "build")!;
    const team = ck.str(o.team, `${p}.team`);
    if (team !== undefined && !teamIds.has(team)) ck.err(`${p}.team`, `names unknown team ${q(team)}`);
    const deps: string[] = [];
    for (const [j, d] of ck.arr(o.depends_on, `${p}.depends_on`).entries()) {
      const dep = ck.id(d, `${p}.depends_on[${j}]`);
      if (dep && !deps.includes(dep)) deps.push(dep);
    }
    const po = ck.obj(o.paths, `${p}.paths`) ?? {};
    ck.known(po, ["write", "read"], `${p}.paths`);
    const write = globs(ck, po.write, `${p}.paths.write`);
    for (const [j, w] of write.entries()) {
      if (!scope.paths.some((s) => globWithin(w, s))) ck.err(`${p}.paths.write[${j}]`, `${q(w)} is outside scope.paths (${scope.paths.join(", ")})`);
    }
    const read = po.read === undefined || po.read === null ? undefined : globs(ck, po.read, `${p}.paths.read`);
    if (kind === "build" && write.length === 0) ck.warn(`${p}.paths.write`, "is empty: a build task without write paths cannot change anything");
    const acceptance = ck.strs(o.acceptance, `${p}.acceptance`);
    if (acceptance.length === 0) ck.warn(`${p}.acceptance`, "is empty: workers need acceptance criteria to know when they are done");
    const checks: string[] = [];
    for (const [j, x] of ck.arr(o.checks, `${p}.checks`).entries()) {
      const cid = ck.id(x, `${p}.checks[${j}]`);
      if (!cid) continue;
      if (!commandIds.has(cid)) ck.err(`${p}.checks[${j}]`, `names unknown command ${q(cid)} (define it in validation.commands)`);
      else if (!checks.includes(cid)) checks.push(cid);
    }
    const verify: NonNullable<TaskSpec["verify"]> = [];
    if (o.verify !== undefined) for (const [j, raw] of ck.arr(o.verify, `${p}.verify`, 16).entries()) {
      const at = `${p}.verify[${j}]`;
      const predicate = ck.obj(raw, at, true);
      if (!predicate) continue;
      ck.known(predicate, ["page_loads"], at);
      const page = ck.obj(predicate.page_loads, `${at}.page_loads`, true);
      if (!page) continue;
      ck.known(page, ["path"], `${at}.page_loads`);
      const path = typeof page.path === "string" ? normalizeRelPath(page.path) : null;
      if (!path || /[*?]/.test(path)) ck.err(`${at}.page_loads.path`, "must be a repository-relative file path");
      else verify.push({ page_loads: { path } });
    }
    const effort = ck.oneOf(o.effort, `${p}.effort`, EFFORTS);
    const budget = ck.num(o.budget_usd, `${p}.budget_usd`, { gt: 0 });
    const context = o.context === undefined || o.context === null ? undefined : artifacts(ck, o.context, `${p}.context`);
    if (!tid || !taskTitle || !persona) continue;
    if (tasks.some((t) => t.id === tid)) {
      ck.err(`${p}.id`, `${q(tid)} appears twice`);
      continue;
    }
    tasks.push({
      id: tid, title: taskTitle, ...(team !== undefined && { team }), persona, kind, depends_on: deps,
      paths: { write, ...(read !== undefined && { read }) }, acceptance, checks,
      ...(o.verify !== undefined && { verify }),
      ...(effort !== undefined && { effort }), ...(budget !== undefined && { budget_usd: budget }),
      ...(context !== undefined && { context }),
    });
  }
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const [i, t] of tasks.entries()) {
    for (const d of t.depends_on) {
      if (d === t.id) ck.err(`tasks[${i}].depends_on`, `${q(t.id)} depends on itself`);
      else if (!taskIds.has(d)) ck.err(`tasks[${i}].depends_on`, `names unknown task ${q(d)}`);
    }
  }
  const cycle = findCycle(tasks.map((t) => ({ id: t.id, depends_on: t.depends_on.filter((d) => d !== t.id) })));
  if (cycle) ck.err("tasks", `depends_on has a cycle: ${cycle.join(" → ")}`);

  // Participants default to the task personas, in task order. Every task persona must consent, so
  // one missing from a given list is added.
  const listed = participants.length > 0;
  for (const t of tasks) {
    if (participants.some((x) => x.agent === t.persona)) continue;
    participants.push({ agent: t.persona });
    if (listed) ck.warn("participants", `did not include task persona ${q(t.persona)}; added it, since every task persona must consent`);
  }
  const agents = new Set(participants.map((x) => x.agent));
  for (const [i, t] of teams.entries()) {
    for (const [j, m] of t.members.entries()) if (!agents.has(m)) ck.err(`teams[${i}].members[${j}]`, `${q(m)} is not a participant`);
  }
  for (const [i, x] of participants.entries()) {
    if (x.team === undefined) continue;
    const team = teams.find((t) => t.id === x.team);
    if (!team) ck.err(`participants[${i}].team`, `names unknown team ${q(x.team)}`);
    else if (!team.members.includes(x.agent)) team.members.push(x.agent);
  }
  for (const [i, t] of tasks.entries()) {
    const team = t.team !== undefined ? teams.find((x) => x.id === t.team) : undefined;
    if (team && !team.members.includes(t.persona)) ck.warn(`tasks[${i}].persona`, `${q(t.persona)} is not a member of team ${q(team.id)}`);
  }

  // --- interfaces and decisions ---
  const interfaces: InterfaceSpec[] = [];
  for (const [i, raw] of ck.arr(c.interfaces, "interfaces", CONTRACT_LIMITS.interfaces).entries()) {
    const p = `interfaces[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["name", "kind", "owner", "path", "description", "consumers"], p);
    const name = ck.str(o.name, `${p}.name`, { required: true, max: 200 });
    const kind = ck.oneOf(o.kind, `${p}.kind`, INTERFACE_KINDS, "other")!;
    const owner = ck.id(o.owner, `${p}.owner`);
    if (owner && !taskIds.has(owner)) ck.err(`${p}.owner`, `must be a task id (got ${q(owner)})`);
    let path: string | undefined;
    if (o.path !== undefined && o.path !== null) {
      path = typeof o.path === "string" ? normalizeRelPath(o.path) ?? undefined : undefined;
      if (path === undefined) ck.err(`${p}.path`, "must be a repository-relative path (no absolute path, '..' or NUL)");
    }
    const description = ck.text(o.description, `${p}.description`);
    const consumers = o.consumers === undefined || o.consumers === null ? undefined : ck.strs(o.consumers, `${p}.consumers`);
    for (const [j, x] of (consumers ?? []).entries()) if (!taskIds.has(x)) ck.err(`${p}.consumers[${j}]`, `must be a task id (got ${q(x)})`);
    if (!name || !owner) continue;
    if (interfaces.some((x) => x.name === name)) {
      ck.err(`${p}.name`, `${q(name)} appears twice`);
      continue;
    }
    interfaces.push({ name, kind, owner, ...(path !== undefined && { path }), description, ...(consumers !== undefined && { consumers: [...new Set(consumers)] }) });
  }
  const decisions: Decision[] = [];
  for (const [i, raw] of ck.arr(c.decisions, "decisions", CONTRACT_LIMITS.decisions).entries()) {
    const p = `decisions[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["id", "scope", "text", "rationale", "by", "supersedes"], p);
    const did = ck.str(o.id, `${p}.id`, { required: true, max: 64 });
    const dscope = ck.str(o.scope, `${p}.scope`) ?? "contract";
    if (dscope !== "contract" && !teamIds.has(dscope) && !taskIds.has(dscope)) ck.err(`${p}.scope`, `must be "contract", a team id or a task id (got ${q(dscope)})`);
    const text = ck.str(o.text, `${p}.text`, { required: true });
    const rationale = ck.str(o.rationale, `${p}.rationale`);
    const by = ck.str(o.by, `${p}.by`) ?? scope.orchestrator;
    const supersedes = ck.str(o.supersedes, `${p}.supersedes`);
    if (!did || !text) continue;
    if (decisions.some((x) => x.id === did)) {
      ck.err(`${p}.id`, `${q(did)} appears twice`);
      continue;
    }
    decisions.push({ id: did, scope: dscope, text, ...(rationale !== undefined && { rationale }), by, ...(supersedes !== undefined && { supersedes }) });
  }
  for (const [i, d] of decisions.entries()) {
    if (d.supersedes !== undefined && !decisions.some((x) => x.id === d.supersedes)) ck.warn(`decisions[${i}].supersedes`, `names a decision not in this contract (${q(d.supersedes)})`);
  }

  // --- dissents: data only; a missing predicate is a draft freeze blocker ---
  const dissents: Contract["dissents"] = [];
  for (const [i, raw] of ck.arr(c.dissents, "dissents", CONTRACT_LIMITS.dissents).entries()) {
    const p = `dissents[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["id", "by", "source", "claim", "predicted_failure", "tripwire", "on_fire"], p);
    const did = ck.id(o.id, `${p}.id`);
    if (did && dissents.some((d) => d.id === did)) ck.err(`${p}.id`, `${q(did)} appears twice`);
    const by = ck.str(o.by, `${p}.by`, { required: true });
    if (by && !agents.has(by)) ck.err(`${p}.by`, `${q(by)} is not a participant`);
    const src = ck.obj(o.source, `${p}.source`, true) ?? {};
    ck.known(src, ["kind", "ref"], `${p}.source`);
    const kind = ck.oneOf(src.kind, `${p}.source.kind`, ["ultraplan", "consent", "debate", "waffle_house", "duel", "manual"] as const);
    if (!kind) ck.err(`${p}.source.kind`, "is required");
    const ref = ck.str(src.ref, `${p}.source.ref`);
    const claim = ck.str(o.claim, `${p}.claim`, { required: true, max: CONTRACT_LIMITS.dissent_claim });
    const prediction = ck.str(o.predicted_failure, `${p}.predicted_failure`, { required: true, max: CONTRACT_LIMITS.dissent_prediction });
    const onFire = ck.oneOf(o.on_fire, `${p}.on_fire`, ["notify", "huddle", "pause_and_huddle"] as const, "huddle")!;
    let tripwire: Contract["dissents"][number]["tripwire"];
    if (o.tripwire === undefined) {
      if (status !== "draft" && status !== "consenting") ck.err(`${p}.tripwire`, "is required before freeze; arm or explicitly excuse the dissent");
    } else {
      const tw = ck.obj(o.tripwire, `${p}.tripwire`, true);
      if (tw) {
        const tp = `${p}.tripwire`;
        const k = ck.oneOf(tw.kind, `${tp}.kind`, ["check_failed", "path_touched", "task_state"] as const);
        if (!k) ck.err(`${tp}.kind`, "is required");
        ck.known(tw, k === "check_failed" ? ["kind", "check", "task"] : k === "path_touched" ? ["kind", "paths", "task"] : ["kind", "task", "state"], tp);
        const task = ck.id(tw.task, `${tp}.task`, k === "task_state");
        if (task && !tasks.some((t) => t.id === task)) ck.err(`${tp}.task`, `names unknown task ${q(task)}`);
        if (k === "check_failed") {
          const check = ck.id(tw.check, `${tp}.check`);
          if (check && !commandIds.has(check)) ck.err(`${tp}.check`, `names unknown command ${q(check)}`);
          if (check) tripwire = { kind: k, check, ...(task && { task }) };
        } else if (k === "path_touched") {
          // Normalize separators before checking absoluteness, including rooted Windows paths.
          const rawPaths = Array.isArray(tw.paths) ? tw.paths.map((x) => typeof x === "string" ? x.replace(/\\/g, "/") : x) : tw.paths;
          const paths = globs(ck, rawPaths, `${tp}.paths`);
          if (!paths.length) ck.err(`${tp}.paths`, "must list at least one relative glob");
          tripwire = { kind: k, paths, ...(task && { task }) };
        } else if (k === "task_state") {
          const state = ck.oneOf(tw.state, `${tp}.state`, ["rejected", "blocked"] as const);
          if (!state) ck.err(`${tp}.state`, "is required");
          if (task && state) tripwire = { kind: k, task, state };
        }
      }
    }
    if (did && by && kind && claim && prediction) dissents.push({
      id: did, by, source: { kind, ...(ref && { ref }) }, claim, predicted_failure: prediction,
      ...(tripwire && { tripwire }), on_fire: onFire,
    });
  }

  // --- budget ---
  const b = ck.obj(c.budget, "budget") ?? {};
  ck.known(b, ["usd", "per_task_usd", "per_agent_usd", "wall_clock_min", "max_parallel", "max_attempts", "max_agents", "max_subtasks"], "budget");
  const parentCap = parentTask && opts.parent
    ? Math.max(0, childBudgetCap(opts.parent, parentTask.id) - (opts.parent.siblingsUsd ?? 0)) || undefined
    : undefined;
  const usdGiven = ck.num(b.usd, "budget.usd", { gt: 0 });
  const usdMissing = b.usd === undefined || b.usd === null;
  if (usdMissing && parentCap === undefined) ck.warn("budget.usd", `was not given; defaulted to $${BUDGET_FALLBACK.usd} (execute asks the human to confirm the cap)`);
  const usd = usdGiven ?? (usdMissing ? parentCap ?? BUDGET_FALLBACK.usd : 1);
  const perTaskGiven = ck.num(b.per_task_usd, "budget.per_task_usd", { gt: 0 });
  const budget: Contract["budget"] = {
    usd,
    per_task_usd: perTaskGiven ?? Math.min(usd, BUDGET_FALLBACK.per_task_usd),
    wall_clock_min: ck.num(b.wall_clock_min, "budget.wall_clock_min", { gt: 0 }) ?? BUDGET_FALLBACK.wall_clock_min,
    max_parallel: ck.num(b.max_parallel, "budget.max_parallel", { min: 1, max: MAX_PARALLEL_LIMIT, int: true }) ?? CONTRACT_DEFAULTS.max_parallel,
    max_attempts: ck.num(b.max_attempts, "budget.max_attempts", { min: 1, max: 10, int: true }) ?? CONTRACT_DEFAULTS.max_attempts,
  };
  const maxAgents = ck.num(b.max_agents, "budget.max_agents", { min: 1, max: 32, int: true });
  if (maxAgents !== undefined) budget.max_agents = maxAgents;
  const maxSubtasks = ck.num(b.max_subtasks, "budget.max_subtasks", { min: 1, max: 64, int: true });
  if (maxSubtasks !== undefined) budget.max_subtasks = maxSubtasks;
  const perAgent = ck.num(b.per_agent_usd, "budget.per_agent_usd", { gt: 0 });
  if (perAgent !== undefined) budget.per_agent_usd = perAgent;
  if (budget.per_task_usd > budget.usd) ck.err("budget.per_task_usd", `($${budget.per_task_usd}) must not exceed budget.usd ($${budget.usd})`);
  if (perAgent !== undefined && perAgent > budget.usd) ck.err("budget.per_agent_usd", `($${perAgent}) must not exceed budget.usd ($${budget.usd})`);
  for (const [i, t] of tasks.entries()) {
    if (t.budget_usd !== undefined && t.budget_usd > budget.per_task_usd) ck.err(`tasks[${i}].budget_usd`, `($${t.budget_usd}) must not exceed budget.per_task_usd ($${budget.per_task_usd})`);
  }

  // --- authority ---
  const a = ck.obj(c.authority, "authority") ?? {};
  ck.known(a, ["lead", "may", "budget_extension_pct"], "authority");
  const lead = ck.str(a.lead, "authority.lead") ?? participants[0]?.agent ?? "";
  if (!lead) ck.err("authority.lead", "is required (no participants to default to)");
  else if (!agents.has(lead)) ck.err("authority.lead", `${q(lead)} is not a participant`);
  const may: AuthorityAction[] = [];
  if (a.may === undefined || a.may === null) may.push(...CONTRACT_DEFAULTS.authority_may);
  else for (const [i, m] of ck.arr(a.may, "authority.may").entries()) {
    const action = ck.oneOf(m, `authority.may[${i}]`, AUTHORITY_ACTIONS);
    if (action && !may.includes(action)) may.push(action);
  }
  const authority: Contract["authority"] = {
    lead, may,
    budget_extension_pct: ck.num(a.budget_extension_pct, "authority.budget_extension_pct", { min: 0, max: 100 }) ?? CONTRACT_DEFAULTS.budget_extension_pct,
  };

  // --- consent and freeze record ---
  const consent: Contract["consent"] = [];
  for (const [i, raw] of ck.arr(c.consent, "consent").entries()) {
    const p = `consent[${i}]`;
    const o = ck.obj(raw, p, true);
    if (!o) continue;
    ck.known(o, ["agent", "verdict", "reason"], p);
    const agent = ck.str(o.agent, `${p}.agent`, { required: true });
    const verdict = ck.oneOf(o.verdict, `${p}.verdict`, VERDICTS);
    const reason = typeof o.reason === "string" ? o.reason : undefined;
    if (agent && verdict) consent.push({ agent, verdict, ...(reason !== undefined && { reason }) });
  }
  let frozen: Contract["frozen"];
  const f = ck.obj(c.frozen, "frozen");
  if (f) {
    ck.known(f, ["by", "at", "hash"], "frozen");
    const by = ck.str(f.by, "frozen.by", { required: true });
    const at = ck.str(f.at, "frozen.at", { required: true });
    const hash = typeof f.hash === "string" && /^[0-9a-f]{64}$/.test(f.hash) ? f.hash : (ck.err("frozen.hash", "must be a sha256 hex digest"), undefined);
    if (by && at && hash) frozen = { by, at, hash };
  }

  const out: Contract = {
    schema: CONTRACT_SCHEMA, id, version, status, title, goal, scope, participants, teams, tasks, interfaces, decisions, dissents,
    validation: { commands, final }, budget, authority, sandbox, workers, consent,
  };
  if (c.connectors !== undefined) {
    out.connectors = [];
    for (const name of ck.arr(c.connectors, "connectors", 8)) {
      if (typeof name !== "string" || !CONNECTOR_NAME.test(name) || name === "roundtable") ck.err("connectors", "must contain connector names");
      else if (out.connectors.includes(name)) ck.err("connectors", `names ${name} twice`);
      else out.connectors.push(name);
    }
    if (out.connectors.length && workers.driver === "codex") ck.err("connectors", "are not supported by codex workers; use claude-code");
  }
  if (postmortem) out.postmortem = postmortem;
  if (frozen) out.frozen = frozen;
  if (scope.parent) checkChild(ck, out, opts);
  return out;
}

/** A child contract fits its parent task: same repository, paths inside its write scope, budget within its cap, depth bounded. */
function checkChild(ck: Checker, c: Contract, opts: CheckOptions): void {
  const ref = c.scope.parent!;
  const parent = opts.parent;
  if (!parent) return ck.err("scope.parent", `contract ${ref.contract} could not be loaded`);
  if (parent.contract.id !== ref.contract) return ck.err("scope.parent.contract", `does not match the loaded parent ${parent.contract.id}`);
  const task = parent.contract.tasks.find((t) => t.id === ref.task);
  if (!task) return ck.err("scope.parent.task", `${q(ref.task)} is not a task of ${ref.contract}`);
  if (task.kind !== "subcontract") ck.err("scope.parent.task", `${q(ref.task)} is a ${task.kind} task; only subcontract tasks get child contracts`);
  const depth = parent.depth + 1;
  if (depth > CONTRACT_DEFAULTS.max_subcontract_depth) {
    ck.err("scope.parent", `would nest sub-orchestration ${depth} levels deep; the limit is ${CONTRACT_DEFAULTS.max_subcontract_depth}`);
  }
  if (c.scope.repo_root && c.scope.repo_root !== parent.contract.scope.repo_root) ck.err("scope.repo_root", `must be the parent's repository (${parent.contract.scope.repo_root})`);
  for (const [i, p] of c.scope.paths.entries()) {
    if (!task.paths.write.some((w) => globWithin(p, w))) {
      ck.err(`scope.paths[${i}]`, `${q(p)} is outside the parent task's write paths (${task.paths.write.join(", ") || "none"})`);
    }
  }
  const cap = childBudgetCap(parent, ref.task);
  const siblings = parent.siblingsUsd ?? 0;
  if (c.budget.usd > cap) {
    ck.err("budget.usd", `($${c.budget.usd}) exceeds what the parent task may spend ($${cap}: its budget, the parent's per-task cap and the parent's remaining budget)`);
  } else if (c.budget.usd + siblings > cap + 1e-9) {
    ck.err("budget.usd", `($${c.budget.usd}) plus the task's other child contracts ($${siblings}) exceeds what the parent task may spend ($${cap})`);
  }
}

/** Every rule except persona resolution, synchronously. */
export function checkContract(input: unknown, opts: CheckOptions = {}): ContractValidation {
  const ck = new Checker();
  const contract = normalize(input, ck, opts);
  return { ok: ck.errors.length === 0, errors: ck.errors, warnings: ck.warnings, contract };
}

function agentsDirAvailable(): boolean {
  try {
    return statSync(AGENTS_DIR).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalize and validate a contract, resolving every persona (task personas and participants)
 * through loadAgent. A name that cannot be loaded is an error, or a warning when the agents
 * directory itself is unavailable; a path that cannot be loaded is always an error.
 */
export async function validateContract(input: unknown, opts: ValidateOptions = {}): Promise<ContractValidation> {
  const ck = new Checker();
  const contract = normalize(input, ck, opts);
  if (contract.connectors?.length) {
    let connectors: Record<string, unknown> = {};
    try { connectors = readUserConfig().connectors ?? {}; } catch { /* Missing local connectors are named below. */ }
    for (const name of contract.connectors) if (!Object.hasOwn(connectors, name)) ck.err("connectors", `names unknown connector ${name}`);
  }
  if (opts.personas !== false) {
    const dirOk = agentsDirAvailable();
    const refs = [...new Set([...contract.tasks.map((t) => t.persona), ...contract.participants.map((p) => p.agent)])];
    for (const ref of refs) {
      try {
        await loadAgent(ref);
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).split("\n")[0];
        if (!dirOk && !isPathLikeRef(ref)) ck.warn(`persona ${q(ref)}`, `could not be checked: the agents directory ${AGENTS_DIR} is unavailable`);
        else ck.err(`persona ${q(ref)}`, `does not resolve: ${why}`);
      }
    }
  }
  return { ok: ck.errors.length === 0, errors: ck.errors, warnings: ck.warnings, contract };
}

// ---------------------------------------------------------------------------
// Hashing, merge patches and diffs
// ---------------------------------------------------------------------------

/** sha256 hex of the canonical contract without `frozen` and `consent` (the content people agreed to). */
export function contractHash(c: Contract): string {
  const { frozen: _f, consent: _c, ...rest } = c;
  return sha256Hex(canonicalJSON(rest));
}

/**
 * What a consent verdict is tied to: contractHash without `status` either, so an AGREE given on a
 * draft still matches the same version once it is frozen.
 */
export function consentHash(c: Contract): string {
  const { frozen: _f, consent: _c, status: _s, ...rest } = c;
  return sha256Hex(canonicalJSON(rest));
}

/** RFC 7396 JSON merge patch: objects merge recursively, null deletes, anything else replaces. */
export function applyMergePatch<T = unknown>(target: unknown, patch: unknown): T {
  if (!isObj(patch)) return clone(patch) as T;
  const out: Obj = {};
  if (isObj(target)) for (const [k, v] of Object.entries(target)) put(out, k, v);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else put(out, k, applyMergePatch(Object.hasOwn(out, k) ? out[k] : undefined, v));
  }
  return out as T;
}

/** The merge patch that turns `from` into `to` (the inverse of applyMergePatch for null-free documents). */
export function createMergePatch(from: unknown, to: unknown): unknown {
  if (!isObj(from) || !isObj(to)) return clone(to);
  const patch: Obj = {};
  for (const k of Object.keys(from)) if (!Object.hasOwn(to, k)) put(patch, k, null);
  for (const [k, v] of Object.entries(to)) {
    if (!Object.hasOwn(from, k)) put(patch, k, clone(v));
    else if (canonicalJSON(from[k]) !== canonicalJSON(v)) put(patch, k, createMergePatch(from[k], v));
  }
  return patch;
}

export interface AffectedTasks {
  /** Tasks in both versions whose spec changed. */
  changed: string[];
  added: string[];
  removed: string[];
  /** Owners and consumers of interfaces that were added, removed or changed, and tasks whose check commands changed. */
  dependents: string[];
  /** All of the above, sorted. */
  all: string[];
}

/** Deep equality by canonical JSON; undefined (an added or removed entry) equals only undefined. */
const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : canonicalJSON(a) === canonicalJSON(b));

/** Which tasks an amendment touches: changed, added and removed specs, interface owners and consumers, changed checks. */
export function affectedTasks(oldC: Contract, newC: Contract): AffectedTasks {
  const before = new Map(oldC.tasks.map((t) => [t.id, t]));
  const after = new Map(newC.tasks.map((t) => [t.id, t]));
  const changed = [...after.keys()].filter((id) => before.has(id) && !same(before.get(id), after.get(id)));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const dependents = new Set<string>();
  const ifaces = new Map<string, { o?: InterfaceSpec; n?: InterfaceSpec }>();
  for (const i of oldC.interfaces) ifaces.set(i.name, { o: i });
  for (const i of newC.interfaces) ifaces.set(i.name, { ...ifaces.get(i.name), n: i });
  for (const { o, n } of ifaces.values()) {
    if (same(o, n)) continue;
    for (const spec of [o, n]) if (spec) for (const id of [spec.owner, ...(spec.consumers ?? [])]) dependents.add(id);
  }
  const oldCmds = new Map(oldC.validation.commands.map((x) => [x.id, x]));
  const changedCmds = new Set(newC.validation.commands.filter((x) => !same(oldCmds.get(x.id), x)).map((x) => x.id));
  for (const t of newC.tasks) if (t.checks.some((x) => changedCmds.has(x))) dependents.add(t.id);
  const live = new Set([...after.keys(), ...removed]);
  const dep = [...dependents].filter((id) => live.has(id)).sort();
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), dependents: dep, all: [...new Set([...changed, ...added, ...removed, ...dep])].sort() };
}

// ---------------------------------------------------------------------------
// Markdown (CONTRACT.md, tool results and consent prompts)
// ---------------------------------------------------------------------------

function argvText(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const list = (xs: readonly string[], empty = "none") => (xs.length ? xs.join(", ") : empty);
const code = (xs: readonly string[]) => list(xs.map((x) => `\`${x}\``));

export interface RenderOptions {
  /** Mark this participant's own tasks with "(yours)". */
  mark?: string;
  /** Leave out the consent section (consent prompts). */
  omitConsent?: boolean;
}

/** The contract as Markdown, for CONTRACT.md, tool results and consent prompts. */
export function renderContractMarkdown(c: Contract, opts: RenderOptions = {}): string {
  const out: string[] = [`# Contract: ${c.title}`];
  if (c.connectors?.length) out.push(`Connectors: ${c.connectors.join(", ")}`);
  out.push(`\`${c.id}\` v${c.version} · status: ${c.status} · orchestrator: ${c.scope.orchestrator} · lead: ${c.authority.lead}` +
    (c.frozen ? `\nFrozen by ${c.frozen.by} at ${c.frozen.at} · sha256 ${c.frozen.hash}` : ""));
  const goal = [`## Goal`, c.goal.ultimate, `**Original request:**\n${c.goal.original_prompt.split(/\r?\n/).map((l) => `> ${l}`).join("\n")}`];
  if (c.goal.source_session) goal.push(`Source session: \`${c.goal.source_session}\``);
  if (c.goal.artifacts.length) goal.push(`Artifacts:\n${c.goal.artifacts.map((a) => `- ${a.title ? `${a.title}: ` : ""}${a.kind} \`${a.ref}\``).join("\n")}`);
  out.push(goal.join("\n\n"));
  out.push([
    "## Scope",
    `Repository: \`${c.scope.repo_root}\` at \`${c.scope.base_ref}\``,
    `Writable paths: ${code(c.scope.paths)}`,
    ...(c.scope.parent ? [`Child of \`${c.scope.parent.contract}\`, task \`${c.scope.parent.task}\``] : []),
  ].join("\n"));
  out.push("## Participants\n\n" + (c.participants.length
    ? c.participants.map((p) => `- ${p.agent}${p.agent === opts.mark ? " (you)" : ""}${p.role ? ` — ${p.role}` : ""}${p.team ? ` · team ${p.team}` : ""}`).join("\n")
    : "(none)"));
  if (c.teams.length) out.push("## Teams\n\n" + c.teams.map((t) => `- **${t.id}**${t.lead ? `, lead ${t.lead}` : ""}: ${list(t.members)}`).join("\n"));
  if (c.dissents?.length) out.push("## Dissents\n\n" + c.dissents.map((d) =>
    `### ${d.id} (${d.tripwire ? "armed" : "draft: needs a tripwire or explicit excusal"})\n\n` +
    JSON.stringify(d, null, 2).split("\n").map((line) => `    ${line}`).join("\n")
  ).join("\n\n"));
  out.push("## Tasks\n\n" + c.tasks.map((t, i) => {
    const lines = [`### ${i + 1}. \`${t.id}\` — ${t.title}${opts.mark !== undefined && t.persona === opts.mark ? " (yours)" : ""}`];
    lines.push(`- Persona: ${t.persona}${t.team ? ` · team ${t.team}` : ""} · kind ${t.kind}${t.effort ? ` · effort ${t.effort}` : ""}${t.budget_usd !== undefined ? ` · budget ${usd(t.budget_usd)}` : ""}`);
    lines.push(`- Depends on: ${list(t.depends_on.map((d) => `\`${d}\``))}`);
    lines.push(`- Writes: ${code(t.paths.write)}${t.paths.read?.length ? ` · reads: ${code(t.paths.read)}` : ""}`);
    lines.push(`- Acceptance:${t.acceptance.length ? "\n" + t.acceptance.map((a) => `  - ${a}`).join("\n") : " (none)"}`);
    lines.push(`- Checks: ${code(t.checks)}`);
    if (t.verify?.length) lines.push(`- Verify: ${t.verify.map(v => `page_loads \`${v.page_loads.path}\``).join(", ")}`);
    if (t.context?.length) lines.push(`- Context: ${t.context.map((a) => `${a.kind} \`${a.ref}\``).join(", ")}`);
    return lines.join("\n");
  }).join("\n\n"));
  if (c.interfaces.length) {
    out.push("## Interfaces\n\n" + c.interfaces.map((f) =>
      `- **${f.name}** (${f.kind}) — owner \`${f.owner}\`${f.consumers?.length ? `; consumers ${list(f.consumers.map((x) => `\`${x}\``))}` : ""}${f.path ? `; \`${f.path}\`` : ""}${f.description ? ` — ${f.description}` : ""}`).join("\n"));
  }
  if (c.decisions.length) {
    out.push("## Decisions\n\n" + c.decisions.map((d) => `- **${d.id}** (${d.scope}, by ${d.by}): ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}${d.supersedes ? ` (supersedes ${d.supersedes})` : ""}`).join("\n"));
  }
  out.push("## Validation\n\n" + (c.validation.commands.length
    ? c.validation.commands.map((x) => `- \`${x.id}\`: \`${argvText(x.argv)}\` (timeout ${x.timeout_s} s${x.cwd ? `, cwd \`${x.cwd}\`` : ""}${x.env ? `, env ${Object.keys(x.env).join(", ")}` : ""})`).join("\n")
    : "(no commands)") + `\n\nFinal validation: ${code(c.validation.final)}`);
  const b = c.budget;
  out.push(`## Budget and authority\n\n${usd(b.usd)} total · ${usd(b.per_task_usd)} per task${b.per_agent_usd !== undefined ? ` · ${usd(b.per_agent_usd)} per agent` : ""} · ` +
    `${b.wall_clock_min} min wall clock · max parallel ${b.max_parallel} · max agents ${b.max_agents ?? "unset (swarms disabled)"} · max subtasks ${b.max_subtasks ?? CONTRACT_DEFAULTS.max_subtasks} · max attempts ${b.max_attempts}\n\n` +
    `Lead ${c.authority.lead} may: ${list(c.authority.may)} · budget extension up to ${c.authority.budget_extension_pct}%\n\n` +
    `Sandbox: ${c.sandbox.backend} (\`${c.sandbox.image}\`)${c.sandbox.install ? ` · install \`${argvText(c.sandbox.install.argv)}\` (egress ${list(c.sandbox.install.egress)})` : ""} · ` +
    `workers: ${c.workers.driver}${c.workers.model ? ` (${c.workers.model}${c.workers.fallback_model ? `, fallback ${c.workers.fallback_model}` : ""})` : ""}` +
    (c.postmortem?.enabled ? "\n\nPostmortem mode: on (findings are kept while testing sends fixers back; a postmortem meeting follows)" : ""));
  if (!opts.omitConsent) {
    out.push("## Consent\n\n" + (c.consent.length
      ? c.consent.map((x) => `- ${x.agent}: ${x.verdict}${x.reason ? ` — ${x.reason.split(/\r?\n/)[0].slice(0, 300)}` : ""}`).join("\n")
      : "(no verdicts recorded)"));
  }
  return out.join("\n\n") + "\n";
}

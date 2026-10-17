// ============================================================================
// collectUsage: the one model behind the status line, the usage CLI and tool, and the dashboard
// (usage-visibility.md §4)
//
// Heads-down figures come from each run's blackboard (lock-free reads, budget.by_agent_usage); at-the-
// table figures from today's table ledger and the live orchestrator servers (table.ts). Every figure
// keeps its provenance. Nothing here reads message text, prompts, diffs or command output.
// ============================================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { isFreeProvider } from "../execution/pricing.js";
import { executionDir, listExecutions, openExecutionStore } from "../execution/store.js";
import type { AgentUsage, BlackboardState } from "../execution/types.js";
import { scrub } from "../security/secrets.js";
import {
  day,
  readLiveServers,
  readStopRequests,
  readTableLines,
  usageDir,
  type LiveServer,
  type TableLine,
} from "./table.js";
import {
  addMoney,
  addTokens,
  mergeMoney,
  mergeTokens,
  moneyTotal,
  REPORT_MAX_USD,
  tokenTotal,
  zeroMoney,
  zeroTokens,
  type Money,
  type Tokens,
  type UsageAgent,
  type UsagePlatform,
  type UsageRun,
  type UsageStop,
  type UsageTable,
  type UsageView,
} from "./types.js";

const DAY_MS = 86_400_000;
const RUNNER_FRESH_MS = 60_000;
/** The run's budget: the contract's usd plus every extension (as execution/budget.ts, which pulls in the watchdog; the status line must start fast). */
const executionBudgetUsd = (state: BlackboardState): number => (state.contract ? state.contract.budget.usd + state.budget.extensions_usd : 0);
const own = <V>(map: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);
const text = (s: unknown, max = 200): string => scrub(String(s ?? "")).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** What the host's status line JSON told us (reported, never measured). */
export interface HostFigures {
  model?: string;
  /** The host session's cost so far, in US dollars. */
  cost_usd?: number;
  at?: string;
}

export interface CollectOptions {
  /** Only these runs (default: live and recent ones). */
  executions?: string[];
  /** A run is recent when its log moved within this many ms (default 24 h). */
  since?: number;
  /** Include the at-the-table ledger and live servers (default true). */
  table?: boolean;
  /** The host agent's reported figures. */
  host?: HostFigures;
  /** Another home for the table ledger and live files (tests). Runs always come from the configured home. */
  home?: string;
  now?: number;
}

const SOURCE_LABELS: Record<string, string> = {
  "[huddle]": "Huddles",
  "[consent]": "Consent rounds",
  "[lead]": "Lead fallback",
  "[structuring]": "Contract structuring",
  "[worker]": "Workers",
};

/** Tokens and money of one agent's per-model ledger. `unpriced` when tokens were used and nothing says what they cost. */
function fold(u: AgentUsage | undefined, fallbackProvider?: string): { tokens: Tokens; money: Money; models: string[] } {
  const tokens = zeroTokens();
  const money = zeroMoney();
  const models: Array<[string, number]> = [];
  for (const [name, m] of Object.entries(u?.models ?? {})) {
    tokens.input += m.tokens.input;
    tokens.output += m.tokens.output;
    tokens.cache_read += m.tokens.cache_read;
    tokens.cache_write += m.tokens.cache_write;
    for (const p of ["measured", "reported", "estimated"] as const) {
      tokens.by[p] += m.tokens_prov[p];
      addMoney(money, m.usd[p], p);
    }
    models.push([name, m.usd.measured + m.usd.reported + m.usd.estimated + (m.tokens.input + m.tokens.output) / 1e12]);
  }
  if (tokenTotal(tokens) > 0 && moneyTotal(money) === 0) {
    if (isFreeProvider(u?.provider ?? fallbackProvider)) money.free = true;
    else money.unpriced = true;
  }
  return { tokens, money, models: models.sort((a, b) => b[1] - a[1]).map(([n]) => n) };
}

function recentEnough(id: string, since: number, now: number): boolean {
  try {
    if (now - statSync(join(executionDir(id), "events.jsonl")).mtimeMs <= since) return true;
  } catch {
    return false;
  }
  try {
    const beat = Date.parse(JSON.parse(readFileSync(join(executionDir(id), "runner.json"), "utf8")).heartbeatAt);
    return Number.isFinite(beat) && now - beat <= RUNNER_FRESH_MS;
  } catch {
    return false;
  }
}

function runView(state: BlackboardState, agents: UsageAgent[], live: boolean): UsageRun {
  const tokens = zeroTokens();
  const money = zeroMoney();
  for (const a of agents) {
    mergeTokens(tokens, a.tokens);
    mergeMoney(money, a.money);
  }
  const tasks = Object.values(state.tasks).filter((t) => t.state !== "cancelled");
  const budget = executionBudgetUsd(state);
  const title = state.contract?.title;
  return {
    id: state.execution,
    ...(title && { title: text(title, 120) }),
    status: state.status,
    tasks: { done: tasks.filter((t) => t.state === "accepted").length, total: tasks.length },
    money,
    tokens,
    ...(budget > 0 && { budget_usd: budget, budget_pct: (state.budget.spent_usd / budget) * 100 }),
    agents: agents.length,
    live,
  };
}

function headsDownAgents(state: BlackboardState): UsageAgent[] {
  const budget = executionBudgetUsd(state);
  const terminal = ["completed", "failed", "aborted"].includes(state.status);
  const keys = new Set([...Object.keys(state.budget.by_agent_usage), ...Object.keys(state.agents)]);
  const out: UsageAgent[] = [];
  for (const id of [...keys].sort()) {
    const rec = own(state.agents, id);
    const u = own(state.budget.by_agent_usage, id);
    const { tokens, money, models } = fold(u, rec?.driver);
    if (!rec && !u) continue;
    const bucket = SOURCE_LABELS[id];
    const stop = rec?.stop;
    const running = rec?.status === "running";
    const state_: UsageAgent["state"] = stop?.state === "stopped" ? "stopped" : running ? "working" : rec?.status === "registered" ? "idle" : "done";
    const stopping = stop?.state === "requested" && running;
    const total = moneyTotal(money);
    const a: UsageAgent = {
      id: text(id, 64),
      where: "heads-down",
      scope: state.execution,
      ...(bucket && { label: bucket }),
      ...((u?.provider ?? rec?.driver) && { provider: text(u?.provider ?? rec?.driver, 64) }),
      ...(models[0] && { model: text(models[0]) }),
      models: models.map((m) => text(m)),
      tokens,
      money,
      state: state_,
      ...(stopping && { stopping: true }),
      stoppable: !terminal && running && !rec?.external && rec?.pid !== undefined && !stopping,
      ...(rec?.task && { task: rec.task }),
      ...(budget > 0 && total > 0 && { budget_share: total / budget }),
      ...(u?.last_at && { last_at: u.last_at }),
    };
    out.push(a);
  }
  return out;
}

function headsDownStops(state: BlackboardState): UsageStop[] {
  const out: UsageStop[] = [];
  for (const rec of Object.values(state.agents)) {
    const s = rec.stop;
    if (!s) continue;
    const status: UsageStop["status"] = s.state === "stopped" ? "stopped" : rec.status === "running" ? "requested" : "failed";
    out.push({ agent: text(rec.id, 64), scope: state.execution, at: s.at, by: text(s.by, 64), status });
  }
  return out;
}

// ---------------------------------------------------------------------------
// At the table
// ---------------------------------------------------------------------------

function tableAgents(lines: TableLine[], live: LiveServer[], pending: Set<string>): { agents: UsageAgent[]; stops: UsageStop[] } {
  const liveSessions = new Map<string, { busy: boolean }>();
  for (const s of live) for (const x of s.sessions) liveSessions.set(x.id, { busy: x.busy === true });
  const stopped = new Map<string, TableLine>();
  const byKey = new Map<string, { id: string; session: string; kind: string; tokens: Tokens; money: Money; models: Map<string, number>; provider?: string; last: string; priced: boolean }>();
  for (const l of lines) {
    if (l.event === "stopped") {
      stopped.set(l.session, l);
      continue;
    }
    const key = `${l.session}\0${l.agent}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { id: l.agent, session: l.session, kind: l.kind, tokens: zeroTokens(), money: zeroMoney(), models: new Map(), last: l.at, priced: false }));
    if (l.tokens) addTokens(e.tokens, l.tokens, l.tokens_prov ?? "measured");
    if (l.usd !== undefined) {
      addMoney(e.money, l.usd, l.usd_prov ?? "estimated");
      e.priced = true;
    }
    if (l.model) e.models.set(l.model, (e.models.get(l.model) ?? 0) + (l.usd ?? 0) + 1e-9);
    if (l.provider) e.provider = l.provider;
    e.last = l.at;
  }
  const agents: UsageAgent[] = [];
  for (const e of byKey.values()) {
    const l = liveSessions.get(e.session);
    const wasStopped = stopped.has(e.session);
    if (tokenTotal(e.tokens) > 0 && moneyTotal(e.money) === 0) {
      if (isFreeProvider(e.provider)) e.money.free = true;
      else if (!e.priced) e.money.unpriced = true;
    }
    const models = [...e.models].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const stoppable = !!l && !wasStopped && ["meeting", "local-meeting", "collaboration", "ultraplan"].includes(e.kind);
    const stopping = pending.has(e.session);
    agents.push({
      id: e.id,
      where: "at-the-table",
      scope: e.session,
      ...(e.provider && { provider: e.provider }),
      ...(models[0] && { model: models[0] }),
      models,
      tokens: e.tokens,
      money: e.money,
      state: wasStopped ? "stopped" : l ? (l.busy ? "working" : "idle") : "done",
      ...(stopping && { stopping: true }),
      stoppable: stoppable && !stopping,
      last_at: e.last,
    });
  }
  const stops: UsageStop[] = [...stopped.values()].map((l) => ({ agent: l.agent, scope: l.session, at: l.at, by: l.by ?? "", status: "stopped" as const }));
  return { agents, stops };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** The totals and the platforms of some agents. The host agent is reported by the host and never part of either. */
export function rollup(agents: readonly UsageAgent[]): { totals: Money & { tokens: Tokens }; platforms: UsagePlatform[] } {
  const totals: Money & { tokens: Tokens } = { ...zeroMoney(), tokens: zeroTokens() };
  const byProvider = new Map<string, UsagePlatform>();
  for (const a of agents) {
    if (a.where === "host") continue;
    mergeMoney(totals, a.money);
    mergeTokens(totals.tokens, a.tokens);
    const provider = a.provider ?? "unknown";
    let p = byProvider.get(provider);
    if (!p) byProvider.set(provider, (p = { provider, models: [], tokens: zeroTokens(), money: zeroMoney() }));
    for (const m of a.models) if (!p.models.includes(m)) p.models.push(m);
    mergeTokens(p.tokens, a.tokens);
    mergeMoney(p.money, a.money);
  }
  const platforms = [...byProvider.values()].sort((a, b) => moneyTotal(b.money) - moneyTotal(a.money) || (a.provider < b.provider ? -1 : 1));
  return { totals, platforms };
}

/** The view narrowed to one run, session or agent (the totals follow). */
export function filterView(view: UsageView, f: { execution?: string; session?: string; agent?: string }): UsageView {
  const agents = view.agents.filter(
    (a) => (f.execution === undefined || a.scope === f.execution) && (f.session === undefined || a.scope === f.session) && (f.agent === undefined || a.id === f.agent)
  );
  const scopes = new Set(agents.map((a) => a.scope));
  const table: UsageTable = { sessions: 0, agents: 0, money: zeroMoney(), tokens: zeroTokens() };
  const sessions = new Set<string>();
  for (const a of agents) {
    if (a.where !== "at-the-table") continue;
    sessions.add(a.scope);
    table.agents++;
    mergeMoney(table.money, a.money);
    mergeTokens(table.tokens, a.tokens);
  }
  table.sessions = sessions.size;
  return {
    ...view,
    ...rollup(agents),
    agents,
    stops: view.stops.filter((s) => scopes.has(s.scope) || (f.agent === undefined && f.execution === undefined && f.session === undefined)),
    runs: view.runs.filter((r) => (f.execution === undefined || r.id === f.execution) && (f.session === undefined && f.agent === undefined ? true : scopes.has(r.id))),
    table,
  };
}

export async function collectUsage(opts: CollectOptions = {}): Promise<UsageView> {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? DAY_MS;
  const home = opts.home ?? ROUNDTABLE_HOME;
  const agents: UsageAgent[] = [];
  const stops: UsageStop[] = [];
  const runs: UsageRun[] = [];

  let ids: string[];
  if (opts.executions) ids = opts.executions;
  else {
    try {
      ids = (await listExecutions()).map((h) => h.id).filter((id) => recentEnough(id, since, now));
    } catch {
      ids = [];
    }
  }
  for (const id of ids) {
    try {
      const store = await openExecutionStore(id);
      const state = await store.state();
      const mine = headsDownAgents(state);
      const live = !["completed", "failed", "aborted"].includes(state.status);
      agents.push(...mine);
      stops.push(...headsDownStops(state));
      runs.push(runView(state, mine, live));
    } catch {
      /* an unreadable or purged run is simply not listed */
    }
  }
  runs.sort((a, b) => Number(b.live) - Number(a.live) || (a.id < b.id ? 1 : -1));

  const table: UsageTable = { sessions: 0, agents: 0, money: zeroMoney(), tokens: zeroTokens() };
  if (opts.table !== false && existsSync(usageDir(home))) {
    const live = readLiveServers(now, home);
    const pending = new Set<string>();
    for (const s of live) for (const r of readStopRequests(s.server, home, { quarantine: false })) pending.add(r.session);
    const days = [day(now)];
    const t = tableAgents(readTableLines(days, home), live, pending);
    agents.push(...t.agents);
    stops.push(...t.stops);
    for (const r of pending) if (!t.stops.some((s) => s.scope === r)) stops.push({ agent: t.agents.find((a) => a.scope === r)?.id ?? "", scope: r, at: new Date(now).toISOString(), by: "", status: "requested" });
    table.sessions = new Set(t.agents.map((a) => a.scope)).size;
    table.agents = t.agents.length;
    for (const a of t.agents) {
      mergeTokens(table.tokens, a.tokens);
      mergeMoney(table.money, a.money);
    }
  }

  const spend = (a: UsageAgent) => moneyTotal(a.money) * 1e6 + tokenTotal(a.tokens) / 1e6;
  agents.sort((a, b) => spend(b) - spend(a) || (a.id < b.id ? -1 : 1));

  // The host agent: reported by the host's own status line, never part of the totals below.
  const h = opts.host;
  if (h && (h.cost_usd !== undefined || h.model)) {
    const money = zeroMoney();
    if (h.cost_usd !== undefined && Number.isFinite(h.cost_usd) && h.cost_usd > 0) addMoney(money, Math.min(h.cost_usd, REPORT_MAX_USD), "reported");
    agents.push({
      id: "host",
      where: "host",
      scope: "host",
      label: "Host agent (reported)",
      ...(h.model && { model: text(h.model) }),
      models: h.model ? [text(h.model)] : [],
      tokens: zeroTokens(),
      money,
      state: "working",
      stoppable: false,
      ...(h.at && { last_at: h.at }),
    });
  }

  const { totals, platforms } = rollup(agents);

  stops.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    generated_at: new Date(now).toISOString(),
    totals,
    platforms,
    agents,
    stops: stops.slice(0, 20),
    runs,
    table,
  };
}

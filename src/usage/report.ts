// ============================================================================
// The usage report: what `agent-roundtable usage` prints (usage-visibility.md §2, §3, §8)
//
// A friendly, readable summary of one UsageView for a terminal: the total with its provenance split,
// a one-line legend, who is working and what each agent has used (two lines each), the platforms, the
// runs and the recent stops. Colour (ANSI) is on for a terminal and never the only signal: every
// state and provenance is also a word. The same view is available as JSON (`usage --json`).
// ============================================================================

import { MEANING, moneyText, tokensShort, totalText, usd, usdBudget, useText } from "./format.js";
import { AMBER, BOLD, CYAN, DIM, RED, painter, visibleWidth, type Paint } from "./statusline.js";
import { moneyTotal, PROVENANCES, tokenTotal, type UsageAgent, type UsageView } from "./types.js";

const GREEN = "32";

const WHERE: Record<UsageAgent["where"], string> = { "heads-down": "heads-down", "at-the-table": "at the table", host: "host" };
const STATE_MARK: Record<UsageAgent["state"], string> = { working: "●", idle: "○", stopped: "■", done: "✓" };

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
};

const cut = (s: string, n: number): string => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s);
const padTo = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function stateText(a: UsageAgent, paint: Paint): string {
  if (a.where === "host") return paint(DIM, "◇ host");
  const word = a.stopping ? "stopping" : a.state;
  const mark = a.stopping ? "■" : STATE_MARK[a.state];
  const code = a.stopping || a.state === "stopped" ? AMBER : a.state === "working" ? CYAN : a.state === "done" ? GREEN : DIM;
  return paint(code, `${mark} ${word}`);
}

function agentBlock(a: UsageAgent, paint: Paint, cols: number): string[] {
  const name = a.label ?? a.id;
  const platform = [a.provider, a.model].filter(Boolean).join(" · ");
  const head = `  ${padTo(stateText(a, paint), 12)} ${paint(BOLD, cut(name, 28))}${platform ? paint(DIM, `  ${cut(platform, Math.max(12, cols - 60))}`) : ""}`;
  const where = a.where === "host" ? "host agent, figures reported by the host" : `${WHERE[a.where]} · ${a.where === "heads-down" ? `exe-${a.scope.slice(-6)}` : a.scope}`;
  const detail: string[] = [where];
  if (a.max_usd !== undefined) detail.push(`spent $${(a.spent_usd ?? 0).toFixed(4)} of $${a.max_usd} cap`);
  if (a.task) detail.push(`task ${a.task}`);
  if (a.budget_share !== undefined) detail.push(`${Math.round(a.budget_share * 100)}% of the budget`);
  const io = a.tokens.input + a.tokens.output > 0 ? `${tokensShort(a.tokens.input)} in, ${tokensShort(a.tokens.output)} out${a.tokens.cache_read ? `, ${tokensShort(a.tokens.cache_read)} cached` : ""}` : "";
  if (io) detail.push(io);
  const money = useText(a.money, a.tokens, "words");
  return [head, `               ${paint(BOLD, money)}  ${paint(DIM, detail.join(" · "))}`,
    ...(a.calls ?? []).map((c) => `               ${c.source}${c.dissent_id ? ` · dissent ${c.dissent_id}` : ""} · ${c.execution}${c.task ? ` · task ${c.task}` : ""} · charged to ${c.agent ?? a.id} · ${c.provider ?? "unknown"} · ${c.model} · ${usd(c.usd)} ${c.provenance.usd}${c.reservation ? " · outstanding reservation" : ""}`)];
}

/** The report. `now` only affects the "as of" clock. */
export function renderReport(view: UsageView, o: { color: boolean; cols: number }): string {
  const paint = painter(o.color);
  const out: string[] = [];
  out.push(`${paint(BOLD, "Roundtable usage")}  ${paint(DIM, `as of ${clock(view.generated_at)}`)}`, "");

  const t = view.totals;
  const total = moneyTotal(t) > 0 || tokenTotal(t.tokens) > 0;
  if (!total && !view.agents.length) {
    out.push("  No usage yet. Agents will show up here as soon as they start.", "");
    out.push(paint(DIM, "  Tip: this fills in as heads-down workers and at-the-table sessions use a model."));
    return out.join("\n");
  }
  out.push(`  ${paint(BOLD, "So far")}  ${moneyTotal(t) > 0 ? totalText(t) : tokenTotal(t.tokens) > 0 ? "no price known for the models used" : usd(0)}`);
  const facts = [
    tokenTotal(t.tokens) > 0 ? `${tokensShort(tokenTotal(t.tokens))} tokens` : "",
    plural(view.platforms.length, "platform"),
    plural(view.agents.filter((a) => a.where !== "host").length, "agent"),
  ].filter(Boolean);
  out.push(`  ${paint(DIM, facts.join(" · "))}`, "");
  for (const p of PROVENANCES) out.push(`  ${paint(DIM, `${p.padEnd(9)} ${MEANING[p]}`)}`);
  out.push("");

  if (view.agents.length) {
    out.push(paint(BOLD, "  Who is working"), "");
    for (const a of view.agents) out.push(...agentBlock(a, paint, o.cols), "");
  }

  if (view.platforms.length) {
    out.push(paint(BOLD, "  By platform"), "");
    for (const p of view.platforms) {
      const models = p.models.length ? paint(DIM, `  ${cut(p.models.join(", "), Math.max(12, o.cols - 70))}`) : "";
      out.push(`  ${padTo(cut(p.provider, 20), 21)}${useText(p.money, p.tokens, "words")}${models}`);
    }
    out.push("");
  }

  if (view.runs.length) {
    out.push(paint(BOLD, "  Heads-down runs"), "");
    for (const r of view.runs) {
      const over = r.budget_pct !== undefined && r.budget_pct >= 80;
      const budget = r.budget_usd !== undefined ? ` of ${usdBudget(r.budget_usd)} (${Math.round(r.budget_pct ?? 0)}%)` : "";
      const spent = moneyTotal(r.money) > 0 ? moneyText(r.money, "words") : usd(0);
      out.push(`  exe-${r.id.slice(-6)}  ${r.live ? paint(CYAN, "live") : paint(DIM, r.status)}  ${r.tasks.done}/${r.tasks.total} tasks  ${spent}${over ? paint(RED, budget) : budget}${r.title ? paint(DIM, `  ${cut(r.title, 40)}`) : ""}`);
    }
    out.push("");
  }

  if (view.stops.length) {
    out.push(paint(BOLD, "  Stops"), "");
    for (const s of view.stops.slice(0, 5)) out.push(`  ${paint(AMBER, s.status.padEnd(9))} ${s.agent || s.scope}${s.by ? ` · by ${s.by}` : ""}${paint(DIM, ` · ${clock(s.at)}`)}`);
    out.push("");
  }

  const stoppable = view.agents.filter((a) => a.stoppable);
  out.push(paint(DIM, stoppable.length ? `  Stop an agent with: agent-roundtable stop ${stoppable.length === 1 ? stoppable[0].id : "<agent>"}   ·   JSON for scripts: usage --json` : "  JSON for scripts: agent-roundtable usage --json"));
  return out.join("\n");
}

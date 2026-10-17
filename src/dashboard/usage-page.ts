// ============================================================================
// The dashboard's Usage page (usage-visibility.md §7)
//
// "Here's who's working and what it's cost so far": the run's total split by provenance, a legend, one
// card per agent (initials avatar in a stable colour, platform chip, status pill, tokens, money with
// its provenance chips, share of the budget and a spend sparkline), a by-platform table, and a Stop
// button on every stoppable card that opens a native <dialog> (Cancel focused by default).
//
// Every name comes from the run and is redacted and escaped. Colour is never the only signal: states
// and provenance are words ("working", "measured"). No inline script, style or handler: the sparkline
// is server-rendered SVG, the avatar colour a class, and dashboard.js does the rest.
// ============================================================================

import { createHash } from "node:crypto";
import { escapeHtml } from "../http/secure-server.js";
import { MEANING, moneyParts, tokensShort, usd, usdBudget } from "../usage/format.js";
import { moneyTotal, tokenTotal, type Money, type Provenance, type Tokens, type UsageAgent, type UsageView } from "../usage/types.js";
import { frame, t, tc, type PageContext } from "./render.js";

/** One point of an agent's spend: cumulative US dollars at a time. */
export interface SpendPoint {
  at: number;
  usd: number;
}

/** Spend over time by agent id, then for the whole run ("" key), from the run's usage events. */
export type SpendSeries = Record<string, SpendPoint[]>;

const SPARK_W = 160;
const SPARK_H = 36;

/** A small area-and-line chart of cumulative spend. At least two points; otherwise an empty placeholder. */
export function sparkline(points: readonly SpendPoint[], label: string): string {
  if (points.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" role="img"><title>${escapeHtml(label)}: not enough points yet</title><line class="base" x1="0" y1="${SPARK_H - 1}" x2="${SPARK_W}" y2="${SPARK_H - 1}"/></svg>`;
  }
  const t0 = points[0].at;
  const span = Math.max(1, points[points.length - 1].at - t0);
  const top = Math.max(1e-9, points[points.length - 1].usd);
  const xy = points.map((p) => [Math.round(((p.at - t0) / span) * (SPARK_W - 2) + 1), Math.round((SPARK_H - 3) - (p.usd / top) * (SPARK_H - 6) + 1)]);
  const line = xy.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `1,${SPARK_H - 1} ${line} ${xy[xy.length - 1][0]},${SPARK_H - 1}`;
  return (
    `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" role="img"><title>${escapeHtml(label)}</title>` +
    `<polygon class="area" points="${area}"/><polyline class="line" points="${line}"/></svg>`
  );
}

/** A stable avatar hue class (av-0 … av-11) from the agent id. */
export function avatarClass(id: string): string {
  return `av-${createHash("sha256").update(id).digest()[0] % 12}`;
}

function initials(name: string): string {
  const words = name.replace(/^\[|\]$/g, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const PROV_ORDER: Provenance[] = ["measured", "reported", "estimated"];

/** A provenance chip: the word is always there, and estimated carries "≈" and a dashed outline. */
function chip(p: Provenance): string {
  return `<span class="chip prov-${p}">${p}</span>`;
}

/** "$1.62 measured + ≈$0.22 estimated" as amounts with chips; "no price" for tokens without a cost. */
function moneyHtml(m: Money, tokens: Tokens): string {
  const parts: string[] = [];
  for (const p of PROV_ORDER) {
    if (m[p] <= 0) continue;
    parts.push(`<span class="amt">${p === "estimated" ? "≈" : ""}${escapeHtml(usd(m[p]))}</span> ${chip(p)}`);
  }
  if (parts.length) return parts.join(` <span class="plus">+</span> `);
  return m.unpriced ? `<span class="amt">no price</span> <span class="chip prov-none">tokens only</span>` : `<span class="amt">${escapeHtml(usd(0))}</span>`;
}

function tokensHtml(tk: Tokens): string {
  if (tokenTotal(tk) === 0) return `<span class="empty">no tokens yet</span>`;
  const bits = [`${tokensShort(tk.input)} in`, `${tokensShort(tk.output)} out`];
  if (tk.cache_read) bits.push(`${tokensShort(tk.cache_read)} cached`);
  const prov = PROV_ORDER.filter((p) => tk.by[p] > 0);
  return `${escapeHtml(bits.join(" · "))} <span class="prov-words">${prov.map((p) => `${tokensShort(tk.by[p])} tokens ${p}`).map(escapeHtml).join(", ")}</span>`;
}

const STATE_MARK: Record<UsageAgent["state"], string> = { working: "●", idle: "○", stopped: "■", done: "✓" };

function pill(a: UsageAgent): string {
  if (a.stopping) return `<span class="pill st-stopping">■ stopping…</span>`;
  return `<span class="pill st-${a.state}">${STATE_MARK[a.state]} ${a.state}</span>`;
}

/** Agent ids the dashboard can name in a URL (the stop route's pattern); any other id gets no data attribute and no button. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function stopControl(a: UsageAgent): string {
  if (a.stopping) return `<button type="button" class="stop" disabled>Stopping…</button>`;
  if (!a.stoppable || !SAFE_ID.test(a.id)) return "";
  return `<button type="button" class="stop" data-stop="${escapeHtml(a.id)}">Stop<span class="sr-only"> ${t(a.id)}</span></button>`;
}

function card(a: UsageAgent, series: SpendSeries, budget: number | undefined): string {
  const name = a.label ?? a.id;
  // Provider and model are separate chips, so a long model id wraps between them instead of being cut.
  const platform = [a.provider, a.model].filter(Boolean).map((x) => `<span class="chip platform">${tc(x, 60)}</span>`).join(" ");
  const share = a.budget_share !== undefined ? Math.min(100, Math.round(a.budget_share * 100)) : undefined;
  const shareText = a.budget_share !== undefined && a.budget_share > 0 && a.budget_share < 0.005 ? "<1%" : `${share}%`;
  const unpriced = a.money.unpriced === true;
  const points = series[a.id] ?? [];
  const note =
    a.state === "stopped"
      ? `Stopped. ${a.task ? `Task ${tc(a.task, 64)} waits for the orchestrator.` : ""}`
      : a.task
        ? `Working on ${tc(a.task, 64)}`
        : a.label
          ? "Orchestration, not an agent"
          : "";
  return (
    `<li class="agent-card state-${a.state}" tabindex="-1"${SAFE_ID.test(a.id) ? ` data-agent="${escapeHtml(a.id)}"` : ""} data-state="${a.stopping ? "stopping" : a.state}">` +
    `<div class="card-top"><span class="avatar ${avatarClass(a.id)}" aria-hidden="true">${escapeHtml(initials(name))}</span>` +
    `<div class="who"><h3>${t(name)}</h3>${platform}</div>${pill(a)}</div>` +
    `<div class="money">${moneyHtml(a.money, a.tokens)}</div>` +
    `<div class="tokens">${tokensHtml(a.tokens)}</div>` +
    (share !== undefined && budget
      ? `<div class="share"><progress max="100" value="${share}" aria-label="Share of the budget">${shareText}</progress><span>${shareText} of the budget</span></div>`
      : `<div class="share none"><span class="empty">${unpriced ? "No price is known for this model, so it has no share of the budget" : "Its share of the budget appears with its first spend"}</span></div>`) +
    sparkline(points, `${name}: spend over time`) +
    `<div class="card-foot"><span class="note">${note}</span>${stopControl(a)}</div>` +
    `</li>`
  );
}

function platformTable(v: UsageView): string {
  if (!v.platforms.length) return "";
  const rows = v.platforms.map(
    (p) =>
      `<tr><th scope="row">${t(p.provider)}</th><td>${p.models.length ? p.models.map((m) => `<code>${tc(m, 60)}</code>`).join(" ") : `<span class="empty">none named</span>`}</td>` +
      `<td class="num">${tokenTotal(p.tokens) ? `${escapeHtml(tokensShort(tokenTotal(p.tokens)))} tokens` : "none"}</td><td>${moneyHtml(p.money, p.tokens)}</td></tr>`
  );
  return (
    `<section aria-labelledby="by-platform"><h2 id="by-platform">By platform</h2><div class="tablewrap"><table>` +
    `<thead><tr><th scope="col">Platform</th><th scope="col">Models</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></section>`
  );
}

function legend(): string {
  return (
    `<dl class="legend">` +
    PROV_ORDER.map((p) => `<div><dt>${chip(p)}</dt><dd>${escapeHtml(MEANING[p][0].toUpperCase() + MEANING[p].slice(1))}.</dd></div>`).join("") +
    `</dl>`
  );
}

function stopsList(v: UsageView): string {
  if (!v.stops.length) return "";
  const rows = v.stops.slice(0, 5).map((s) => `<li><strong>${t(s.agent)}</strong> · ${escapeHtml(s.status)}${s.by ? ` · by ${tc(s.by, 80)}` : ""} · <time datetime="${escapeHtml(s.at)}">${escapeHtml(s.at.slice(11, 19))}</time></li>`);
  return `<section aria-labelledby="recent-stops"><h2 id="recent-stops">Recent stops</h2><ul class="stops">${rows.join("")}</ul></section>`;
}

/** The Usage page. `series` is each agent's cumulative spend over time (from the run's usage events). */
export function renderUsage(c: PageContext, v: UsageView, series: SpendSeries): string {
  const run = v.runs[0];
  const budget = run?.budget_usd;
  const total = moneyTotal(v.totals);
  const hasUsage = v.agents.length > 0 || total > 0 || tokenTotal(v.totals.tokens) > 0;
  const split = moneyParts(v.totals, "words");
  const pct = run?.budget_pct;

  const hero =
    `<section class="hero" aria-labelledby="usage-title"><h1 id="usage-title">Usage</h1>` +
    `<p class="lead">Here's who's working and what it's cost so far.</p>` +
    (hasUsage
      ? `<div class="hero-total"><span class="big">${total > 0 ? `${v.totals.measured + v.totals.reported === 0 ? "≈" : ""}${escapeHtml(usd(total))}` : tokenTotal(v.totals.tokens) > 0 ? "no price" : escapeHtml(usd(0))}</span> ` +
        `<span class="hero-split">${moneyHtml(v.totals, v.totals.tokens)}</span></div>` +
        `<p class="meta">${tokenTotal(v.totals.tokens) > 0 ? `${escapeHtml(tokensShort(tokenTotal(v.totals.tokens)))} tokens` : "no tokens yet"}` +
        `${budget ? ` · ${escapeHtml(usd(total))} of ${escapeHtml(usdBudget(budget))}${pct !== undefined ? ` (${Math.round(pct)}%)` : ""}` : ""}` +
        `${split.length > 1 ? ` · the total mixes ${split.length} kinds of figure, so it is shown split` : ""}</p>` +
        (budget && pct !== undefined ? `<progress max="100" value="${Math.min(100, Math.round(pct))}" aria-label="Budget spent">${Math.round(pct)}%</progress>` : "")
      : "") +
    legend() +
    `</section>`;

  const cards = v.agents.filter((a) => a.where !== "host");
  const body = hasUsage
    ? `<section aria-labelledby="agents-title"><h2 id="agents-title">Agents</h2><ul class="agent-cards">${cards.map((a) => card(a, series, budget)).join("")}</ul></section>` +
      platformTable(v) +
      stopsList(v)
    : `<section class="empty-state"><p class="lead">No usage yet.</p><p class="empty">Agents will show up here as soon as they start.</p></section>`;

  return frame(
    c,
    "usage",
    "Usage",
    `${hero}${body}`,
    `<div id="announce" class="sr-only" aria-live="polite"></div>` +
      `<dialog id="stop-dialog" aria-labelledby="stop-title" aria-describedby="stop-text">` +
      `<h2 id="stop-title">Stop <span id="stop-name"></span>?</h2>` +
      `<p id="stop-text">Its task will pause and the orchestrator will be asked to rework or write a handoff.</p>` +
      `<div class="dialog-actions"><button type="button" id="stop-cancel" autofocus>Cancel</button>` +
      `<button type="button" id="stop-confirm" class="danger">Stop <span id="stop-name2"></span></button></div></dialog>`
  );
}

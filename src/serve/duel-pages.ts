import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { escapeHtml as e, type Route } from "../http/secure-server.js";
import { ID_RE } from "../execution/events.js";
import { sitePage } from "../dashboard/shell.js";
import { humanTime } from "../dashboard/time.js";
import { markdownToHtml } from "../dashboard/render.js";
import { persistedLiveDuels, type LiveDuel } from "../table/live-duels.js";
import { agentGlyph } from "./agent-glyph.js";
import { arr, obj, str, num, count, strings, redactedData, loadDuel, listDuelPages, readPageData, type DuelPageData, type DuelSeat, type DuelTurn, type DuelPrototype } from "./duel-data.js";
import { DUEL_CSS, DUEL_JS } from "./duel-assets.js";
import { DuelPreviewHost } from "./duel-prototypes.js";

const pill = (text: string, state = "draft", title = "") => `<span class="duel-pill state-${state}"${title ? ` title="${e(title)}"` : ""}>${e(text)}</span>`;
const teamClass = (team: string) => ["A", "B", "C", "D"].includes(team) ? `team-${team.toLowerCase()}` : "team-neutral";
const teamLabel = (team: string) => team === "judge" ? "Judges" : team ? `Team ${team}` : "Participants";
const topic = (d: DuelPageData) => str(d.start.topic, "Untitled duel");
const rawDetails = (value: unknown, label: string) => `<details class="duel-card raw-archive"><summary>${label}</summary><pre tabindex="0">${e(JSON.stringify(value, null, 2))}</pre></details>`;
// These are static reading pages. Omit the shared execution polling script so a refresh cannot
// close a reader's expanded turn, source listing, or running artifact every fifteen seconds.
const page = (base: string, title: string, body: string) => sitePage({ base, title, active: "duels", body: `<div class="duel-page">${body}</div>`, stylesheets: ["static/duel.css"], scripts: ["static/duel.js"] })
  .replace(`<script src="${e(base)}static/dashboard.js"></script>`, "");
const money = (value: unknown) => num(value) === undefined ? "unpriced" : `$${count(value).toFixed(4)}`;
const n = (value: unknown) => e(count(value).toLocaleString("en-US"));
const quantity = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;
/** Markdown markers removed, for a one-paragraph preview of a turn that is rendered as markdown when expanded. */
const plainText = (md: string) => md.replace(/!?\[([^\[\]]+)\]\([^)\s]+\)/g, "$1").replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
  .replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,;:!?])/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
const textBlock = (value: string) => `<div class="duel-text">${markdownToHtml(value)}</div>`;
function duration(d: DuelPageData): string {
  const first = Date.parse(str(d.start.startedAt));
  const exact = count(d.end.durationMs) || Math.max(...Object.values(d.metrics).map(m => count(obj(m).elapsedMs)), 0);
  const last = d.events.reduce((latest, x) => Math.max(latest, Date.parse(str(x.ts)) || 0), 0);
  const elapsed = exact || (Number.isFinite(first) && last ? Math.max(0, last - first) : 0);
  if (!elapsed) return "Duration not recorded";
  const seconds = Math.round(elapsed / 1000);
  return `${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s${exact ? " active time" : " recorded span"}`;
}
function outcome(d: DuelPageData): string {
  if (d.end.aborted === true) return pill("Aborted", "aborted");
  if (!d.end.type) return pill("Interrupted", "interrupted", "This archive has no final outcome.");
  const winner = str(d.end.winner);
  return `${pill("Completed", "completed")} <strong>${e(winner === "tie" ? "Tied" : winner && winner !== "none" ? `Team ${winner} wins` : "No winner recorded")}</strong>`;
}
function seatView(seat: DuelSeat): string {
  return `${agentGlyph(seat.name, seat.role)}<span class="seat-identity"><strong>${e(seat.name)}</strong><span>${e(seat.role)} · ${e(teamLabel(seat.team))}</span><span class="model-chip">${e(seat.provider)} / ${e(seat.model)}</span></span>`;
}
function tableView(d: DuelPageData): string {
  const judges = d.seats.filter(s => s.team === "judge"), players = d.seats.filter(s => s.team !== "judge");
  const left = players.filter((s, i) => ["A", "C"].includes(s.team) || (!["B", "D"].includes(s.team) && i % 2 === 0));
  const right = players.filter(s => !left.includes(s));
  const head = Math.ceil(judges.length / 3) * 110 + 55, rows = Math.max(left.length, right.length, 2), height = head + rows * 110 + 35;
  const seat = (s: DuelSeat, x: number, y: number) => `<a class="table-seat ${teamClass(s.team)}" href="#turn-flow" role="button" tabindex="0" data-filter-seat="${e(s.id)}" aria-label="${e(`${s.name}, ${s.role}, ${teamLabel(s.team)}, ${s.provider}, ${s.model}. Show this agent's turns`)}">` +
    `<g transform="translate(${x},${y})"><rect class="seat-tile" x="-128" y="-42" width="256" height="94" rx="14"/><g transform="translate(-118,-30)">${agentGlyph(s.name, s.role)}</g>` +
    `<text class="seat-name" x="-50" y="-9">${e(s.name.length > 22 ? s.name.slice(0, 20) + "…" : s.name)}</text><text class="seat-role" x="-50" y="11">${e(s.role.slice(0, 24))}</text>` +
    `<text class="seat-model" x="-113" y="40">${e(`${s.provider} / ${s.model}`.slice(0, 34))}</text></g></a>`;
  return `<section aria-labelledby="table-title"><div class="section-heading"><div><p class="eyebrow">The people behind the outcome</p><h2 id="table-title">At the table</h2></div><p class="muted">Select an agent to follow their turns.</p></div>` +
    (d.seats.length ? `<div class="duel-card table-card"><svg class="duel-table" viewBox="0 0 1000 ${height}" role="group" aria-label="Duel table. Teams sit on opposite sides; judges sit at the head.">` +
      `<ellipse class="table-surface" cx="500" cy="${head + rows * 55 - 15}" rx="205" ry="${rows * 53}"/><ellipse class="table-ring" cx="500" cy="${head + rows * 55 - 15}" rx="185" ry="${rows * 53 - 20}"/>` +
      `<text class="table-caption" x="500" y="${head + rows * 55 - 20}" text-anchor="middle">ROUNDTABLE</text><text class="table-subcaption" x="500" y="${head + rows * 55 + 4}" text-anchor="middle">${quantity(new Set(players.map(s => s.team).filter(Boolean)).size, "team")} · ${quantity(judges.length, "judge")}</text>` +
      judges.map((s, i) => seat(s, (1000 / Math.min(judges.length - Math.floor(i / 3) * 3, 3)) * (i % 3 + 0.5), 55 + Math.floor(i / 3) * 110)).join("") +
      left.map((s, i) => seat(s, 145, head + i * 110 + 45)).join("") + right.map((s, i) => seat(s, 855, head + i * 110 + 45)).join("") + `</svg></div>` +
      `<div class="seat-roster">${d.seats.map(s => `<a href="#turn-flow" class="duel-card seat-card ${teamClass(s.team)}" data-filter-seat="${e(s.id)}" role="button" aria-label="${e(`Follow ${s.name}, ${s.role}, ${s.provider}, ${s.model}`)}">${seatView(s)}</a>`).join("")}</div>` : `<p class="duel-card muted">Seats were not recorded in this archive.</p>`) + `</section>`;
}

function relations(d: DuelPageData, turn: DuelTurn): string {
  const before = d.turns.filter(t => t.order < turn.order && t.index !== turn.index);
  let answers: DuelTurn[] = [];
  const links: string[] = [];
  if (turn.label === "Tool interaction") {
    const earlier = d.turns.filter(t => t.index < turn.index && t.label !== "Tool interaction");
    const previous = earlier.sort((a, b) => b.index - a.index)[0];
    if (previous) answers = [previous];
  } else if (turn.label === "Revision") {
    d.assessments.forEach((a, i) => { if (a.team === turn.seat.team) links.push(`<a href="#assessment-${i}">${e(str(obj(a.judge).name, "Judge"))}'s ${e(str(a.verdict, "assessment"))}</a>`); });
    answers = before.filter(t => t.label === "Judging");
  } else if (turn.label === "Critique" || turn.label === "Build") {
    const own = before.filter(t => t.seat.team === turn.seat.team && t.index < turn.index);
    if (own.length) answers = own.filter(t => t.order === own.at(-1)!.order);
  }
  if (!answers.length && !links.length) {
    const other = before.filter(t => turn.seat.team === "judge" ? t.seat.team !== "judge" : t.seat.team !== turn.seat.team);
    if (other.length) { const previous = Math.max(...other.map(t => t.order)); answers = other.filter(t => t.order === previous); }
  }
  links.push(...answers.map(t => `<a href="#turn-${t.index}" data-related-seat="${e(t.seat.id)}">${e(t.seat.name)} · ${e(t.round)}${t.stage ? ` stage ${n(t.stage.stage)}` : ""}</a>`));
  return links.length ? `<p class="turn-response"><span aria-hidden="true">↳</span> Responds to ${links.join(", ")}</p>` : `<p class="turn-response muted">${turn.label === "Concept" ? "Opens the brief for this team." : "No earlier response was recorded."}</p>`;
}
function turnCard(d: DuelPageData, turn: DuelTurn): string {
  const long = turn.text.length > 850, preview = plainText(turn.text).slice(0, 850).replace(/\s+\S*$/, "") + "…";
  return `<article id="turn-${turn.index}" class="duel-card turn-card ${teamClass(turn.seat.team)}${turn.label === "Tool interaction" ? " interaction-card" : ""}" data-turn-seat="${e(turn.seat.id)}">` +
    `<div class="turn-top">${agentGlyph(turn.seat.name, turn.seat.role)}<div><h4>${e(turn.seat.name)}</h4><span class="team-label">${e(teamLabel(turn.seat.team))}</span></div><span class="turn-type" title="${e(turn.label === "Critique" ? "Feedback on the team's concept." : turn.label === "Revision" ? "A change following the judges' feedback." : `${turn.label} contribution`)}">${e(turn.label)}</span></div>` +
    `<p class="turn-meta">${e(turn.round)}${turn.stage ? ` · Stage ${n(turn.stage.stage)}: ${e(str(turn.stage.name))}` : ""}${turn.ts ? ` · ${humanTime(turn.ts)}` : ""}</p>` +
    (long ? `<details class="turn-expand"><summary><span class="turn-preview">${e(preview)}</span><span class="show-more">Show more</span><span class="show-less">Show less</span></summary>${textBlock(turn.text)}</details>` : textBlock(turn.text)) +
    relations(d, turn) + `</article>`;
}
function turnFlow(d: DuelPageData): string {
  const groups = new Map<number, DuelTurn[]>();
  d.turns.forEach(t => groups.set(t.order, [...(groups.get(t.order) ?? []), t]));
  const teams = [...new Set(d.turns.map(t => t.seat.team))].sort();
  return `<section id="turn-flow" aria-labelledby="flow-title"><div class="section-heading"><div><p class="eyebrow">From idea to decision</p><h2 id="flow-title">Turn flow</h2></div><div class="flow-filter" hidden><span id="filter-status" role="status" aria-live="polite">All agents</span><button type="button" data-clear-filter>Show all agents</button></div></div>` +
    (d.turns.length ? `<p class="muted">Follow each team's lane. Response links connect ideas, feedback and revisions.</p><div class="turn-flow">${[...groups].map(([order, turns]) => `<section class="flow-round" data-flow-round><h3><span class="round-dot" aria-hidden="true"></span>${e(turns[0].label)}${turns[0].stage ? ` · ${e(str(turns[0].stage.name))}` : ""}<small>${e(turns[0].round)}</small></h3><div class="flow-lanes${teams.length > 2 ? " many-lanes" : ""}">${teams.map(team => {
      const mine = turns.filter(t => t.seat.team === team);
      return mine.length ? `<div class="flow-lane ${teamClass(team)}"><span class="lane-label">${e(teamLabel(team))}</span>${mine.map(t => turnCard(d, t)).join("")}</div>` : "";
    }).join("")}</div></section>`).join("")}</div>` : `<p class="duel-card muted">No turns were saved in this archive.</p>`) + `</section>`;
}

function prototypeVersion(p: DuelPrototype, urls: Map<number, string>): string {
  const url = urls.get(p.index);
  return `<div class="prototype-version"><div class="prototype-heading"><h4>${e(p.title)}</h4>${pill(p.ok ? "Completed" : "Failed", p.ok ? "completed" : "failed")}</div>` +
    `<p class="muted">${e(p.kind)} · Version ${n(p.version)}${p.stage ? ` · Stage ${n(p.stage)}` : ""}</p>` +
    `<ul class="file-list">${p.files.map(f => `<li><code>${e(f.path)}</code><span>${n(f.bytes)} bytes</span></li>`).join("") || "<li>No files recorded.</li>"}</ul>` +
    (p.error ? `<p class="prototype-error">${e(p.error)}</p>` : "") +
    (url ? `<details class="prototype-run"><summary class="duel-action">Run <span class="sr-only">${e(p.title)}</span></summary><p class="muted">Runs locally in an isolated frame. Network access is blocked. Inline scripts and styles work; external resources do not.</p><iframe class="artifact-frame" src="${e(url)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="${e(`Team ${p.team}: ${p.title}`)}"></iframe></details>` : `<p class="muted">${p.kind !== "web" ? "This is a source artifact. It needs its own runtime and cannot run in the browser." : !p.ok ? "This build failed. View any saved code below." : "Run is unavailable. Open the index on this machine; the HTML source must also be present."}</p>`) +
    `<details class="prototype-code"><summary class="duel-action">View code <span class="sr-only">${e(p.title)}</span></summary>${p.files.map(f => `<h5>${e(f.path)}</h5>${f.content !== undefined ? `<pre tabindex="0"><code>${e(f.content)}</code></pre>` : `<p class="muted">Source was not saved for this file.</p>`}`).join("") || "<p>No source files recorded.</p>"}</details></div>`;
}
function prototypes(d: DuelPageData, urls: Map<number, string>): string {
  const teams = [...new Set(d.prototypes.map(p => p.team))];
  return `<section aria-labelledby="prototypes-title"><div class="section-heading"><div><p class="eyebrow">What the teams made</p><h2 id="prototypes-title">Prototypes</h2></div></div><div class="duel-grid">` +
    (teams.map(team => {
      const versions = d.prototypes.filter(p => p.team === team), latest = [...versions].reverse().find(p => p.ok) ?? versions.at(-1)!;
      const others = versions.filter(p => p !== latest);
      return `<article class="duel-card prototype-card ${teamClass(team)}"><span class="team-label">${e(teamLabel(team))}</span>${prototypeVersion(latest, urls)}${others.length ? `<details class="version-history"><summary>${others.length} other ${others.length === 1 ? "version" : "versions"}</summary>${others.map(p => prototypeVersion(p, urls)).join("")}</details>` : ""}</article>`;
    }).join("") || `<p class="duel-card muted">No prototypes were saved in this archive.</p>`) + `</div></section>`;
}
function judgeSeat(d: DuelPageData, value: unknown): DuelSeat {
  const s = obj(value); return d.seats.find(x => x.id === str(s.id, str(value))) ?? { id: "", name: str(s.name, str(value, "Judge")), role: "judge", team: "judge", provider: "", model: "" };
}
function judging(d: DuelPageData): string {
  const tally = obj(d.end.tally), teams = [...new Set([...Object.keys(tally), ...d.assessments.map(a => str(a.team))])].filter(Boolean);
  const verdicts: Record<string, [string, string]> = { APPROVE: ["Approve", "Meets the judging criteria."], REVISE: ["Revise", "Needs changes before approval."], REJECT: ["Reject", "Does not meet the judging criteria."], UNCLEAR: ["Unclear", "No clear judgment was recorded."] };
  return `<section aria-labelledby="judging-title"><div class="section-heading"><div><p class="eyebrow">How the decision was reached</p><h2 id="judging-title">Judging</h2></div>${d.end.decidedBy === "human" ? pill("Chosen by a person", "completed") : ""}</div>` +
    `<div class="duel-grid">${teams.map(team => `<article class="duel-card verdict-group ${teamClass(team)}"><div class="score-heading"><h3>${e(teamLabel(team))}</h3>${num(tally[team]) !== undefined ? `<span class="score" aria-label="Team ${e(team)} score ${e(tally[team])}">${e(tally[team])} <small>points</small></span>` : ""}</div>` +
      d.assessments.flatMap((a, i) => {
        if (a.team !== team) return [];
        const judge = judgeSeat(d, a.judge), verdict = str(a.verdict), [label, explanation] = verdicts[verdict] ?? [verdict || "Unclear", "Recorded judgment."];
        const color = verdict === "APPROVE" ? "completed" : verdict === "REJECT" ? "failed" : verdict === "REVISE" ? "interrupted" : "draft";
        return [`<section class="verdict-card" id="assessment-${i}"><div class="turn-top">${agentGlyph(judge.name, "judge")}<h4>${e(judge.name)}</h4>${pill(label, color, explanation)}</div><p class="verdict-explanation">${e(explanation)}${num(a.version) !== undefined ? ` Version ${n(a.version)}.` : ""}</p>${textBlock(str(a.reason, "No reason recorded."))}</section>`];
      }).join("") + `</article>`).join("") || `<p class="duel-card muted">No judging was recorded.</p>`}</div><p class="muted">Approve adds 1 point. Revise and Unclear add 0. Reject subtracts 1.</p></section>`;
}
function dissents(d: DuelPageData): string {
  return `<section aria-labelledby="dissents-title"><h2 id="dissents-title">Dissents <span class="muted">(${d.dissents.length})</span></h2><p class="muted">Concerns that remain after the decision.</p><div class="duel-grid">` +
    (d.dissents.map(a => {
      const seat = judgeSeat(d, a.seat);
      return `<aside class="duel-card dissent-card"><div class="turn-top">${agentGlyph(seat.name, seat.role)}<div><h3>${e(seat.name)}</h3><span class="dissent-label">Dissent ${a.team ? `on ${e(teamLabel(str(a.team)))}` : "from the final decision"}</span></div></div>${a.from || a.against ? `<p>Disagrees with ${e(str(a.from, str(a.against)))}</p>` : ""}<blockquote>${textBlock(str(a.text, str(a.reason, "No explanation recorded.")))}</blockquote></aside>`;
    }).join("") || `<p class="duel-card muted">No dissents were recorded.</p>`) + `</div></section>`;
}
function usage(d: DuelPageData): string {
  return `<details class="duel-card usage-card"><summary>Usage and cost <span class="muted">${money(d.usage.totalCostUsd)}${count(d.usage.totalUnpricedTokens) ? ` + ${n(d.usage.totalUnpricedTokens)} unpriced tokens` : ""}</span></summary><div class="duel-table-scroll" tabindex="0" role="region" aria-label="Per-agent token usage"><table><thead><tr><th scope="col">Agent</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Cost</th></tr></thead><tbody>` +
    arr(d.usage.perSeat).map(obj).map(u => `<tr><th scope="row">${e(d.seats.find(s => s.id === str(u.seatId))?.name ?? str(u.seatId, "Unknown agent"))}${u.estimated ? " (estimated)" : ""}</th><td>${n(u.inputTokens)}</td><td>${n(u.outputTokens)}</td><td>${count(u.unpricedTokens) ? `${num(u.costUsd) !== undefined && count(u.costUsd) > 0 ? `${money(u.costUsd)} + ` : ""}${n(u.unpricedTokens)} tokens unpriced` : money(u.costUsd)}</td></tr>`).join("") +
    `</tbody><tfoot><tr><th scope="row">Total</th><td>${n(arr(d.usage.perSeat).reduce<number>((sum, u) => sum + count(obj(u).inputTokens), 0))}</td><td>${n(arr(d.usage.perSeat).reduce<number>((sum, u) => sum + count(obj(u).outputTokens), 0))}</td><td>${money(d.usage.totalCostUsd)}${count(d.usage.totalUnpricedTokens) ? ` + ${n(d.usage.totalUnpricedTokens)} tokens unpriced` : ""}</td></tr></tfoot></table></div></details>`;
}
function metrics(d: DuelPageData): string {
  const teams = Object.entries(d.metrics).filter(([, m]) => Object.keys(obj(m)).length);
  const stages = d.events.filter(x => x.type === "stage");
  if (!teams.length && !stages.length) return "";
  const states: Record<string, string> = { started: "Running", done: "Completed", failed: "Failed", skipped: "Aborted" };
  return `<details class="duel-card process-record"><summary>Build stages and team progress</summary><div class="duel-grid">${teams.map(([team, value]) => {
    const m = obj(value);
    return `<section><h3>${e(teamLabel(team))}</h3><p>${n(m.stagesDone)} of ${n(m.stagesTotal)} stages · ${n(m.versions)} versions · ${n(m.rewrites)} rewrites</p><p>${n(m.turns)} turns · ${n(m.failedTurns)} failed · ${n(m.pageErrors)} page errors · ${n(m.validationFailures)} validation failures · ${n(m.toolCalls)} tool calls</p>${m.finishedAt ? `<p>Finished ${humanTime(str(m.finishedAt))}</p>` : ""}</section>`;
  }).join("")}</div><div class="stage-records">${stages.map(s => `<p class="stage-record ${teamClass(str(s.team))}"><strong>${e(teamLabel(str(s.team)))}</strong> · Stage ${n(s.stage)}: ${e(str(s.name))} ${pill(states[str(s.status)] ?? "Draft", (states[str(s.status)] ?? "Draft").toLowerCase())} ${humanTime(str(s.ts))}</p>`).join("")}</div></details>`;
}

export function renderDuel(base: string, d: DuelPageData, urls = new Map<number, string>()): string {
  const teams = new Set(d.seats.map(s => s.team).filter(t => t && t !== "judge")).size;
  return page(base, topic(d), `<a class="back-link" href="${e(base)}duels">← All duels</a><header class="duel-hero"><p class="eyebrow">Archived duel · ${e(str(d.start.kind, "web"))}</p><h1>${e(topic(d))}</h1><div class="duel-outcome">${outcome(d)}</div>` +
    `<p class="duel-summary">${quantity(teams, "team")} explored the brief across ${quantity(d.turns.length, "turn")}, produced ${quantity(d.prototypes.filter(p => p.ok).length, "saved build")} and recorded ${quantity(d.dissents.length, "dissent")}.</p><p class="muted">Started ${humanTime(str(d.start.startedAt))} · ${e(duration(d))}</p><p class="archive-id">${e(d.id)}</p>` +
    (strings(d.start.criteria).length ? `<div class="criteria"><strong>Judged on</strong>${strings(d.start.criteria).map(c => `<span>${e(c)}</span>`).join("")}</div>` : `<p class="muted">Judging criteria were not recorded.</p>`) + `</header>` +
    (d.partial ? `<p class="duel-card partial-note">This archive is partial. The page shows the information that was saved.</p>` : "") +
    tableView(d) + turnFlow(d) + prototypes(d, urls) + judging(d) + dissents(d) + metrics(d) + usage(d) +
    rawDetails(d.raw, "Raw archive (JSON)") + `<p><a class="duel-action" href="${e(base)}duels/${e(d.id)}.json" download>Download redacted JSON</a></p>`);
}

/** Registry 2.1 has no room URL yet. Accept only explicit local origins if a later registry adds one. */
function roomLink(value: unknown): string {
  if (typeof value !== "string") return "";
  try { const u = new URL(value); if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && !u.username && !u.password) return `<a class="duel-action" href="${e(u.href)}" rel="noreferrer">Open live room</a>`; } catch { /* absent or invalid */ }
  return "";
}
export function renderDuels(base: string, duels: DuelPageData[], input: Array<LiveDuel & { host: string }> = []): string {
  const live = redactedData(input) as typeof input;
  const liveCards = [...live].sort((a, b) => (Date.parse(b.started) || 0) - (Date.parse(a.started) || 0)).map(d => `<article class="duel-card live-duel"><div class="card-kicker">${pill("Live", "running", "This session is running.")} <span>${e(d.kind ?? "duel")}</span></div><h2>${e(d.agents.join(" + ") || "Live duel")}</h2><p>Started ${humanTime(d.started)}</p><p class="archive-id">${e(d.id)}</p>${roomLink(obj(d).roomUrl ?? obj(d).url)}</article>`).join("");
  const cards = duels.map(d => `<article class="duel-card duel-list-card"><div class="card-kicker"><span>${e(str(d.start.kind, "web"))}</span>${outcome(d)}</div><h2><a href="${e(base)}duels/${e(d.id)}">${e(topic(d))}</a></h2><p class="muted">${humanTime(str(d.start.startedAt))}</p><p class="archive-id">${e(d.id)}</p><div class="list-teams">` +
    [...new Set(d.seats.filter(s => s.team !== "judge").map(s => s.team))].map(team => `<div class="list-team ${teamClass(team)}"><span class="team-label">${e(teamLabel(team))}</span><div>${d.seats.filter(s => s.team === team).map(s => `<span class="mini-agent">${agentGlyph(s.name, s.role)}<span>${e(s.name)}</span></span>`).join("")}</div></div>`).join("") + `</div><p class="dissent-count${d.dissents.length ? "" : " none"}">${d.dissents.length} ${d.dissents.length === 1 ? "dissent" : "dissents"}</p></article>`).join("");
  return page(base, "Duels", `<header class="duel-hero"><p class="eyebrow">Ideas, builds and decisions</p><h1>Duels</h1><p class="duel-summary">See what each team built, how the ideas changed and why one won.</p><a href="${e(base)}casting">Latest casting report</a></header>` +
    (liveCards ? `<section aria-label="Live duels"><h2>Live now</h2><div class="duel-grid">${liveCards}</div></section>` : "") +
    `<section aria-label="Archived duels"><h2>Archived duels</h2><div class="duel-grid">${cards || `<div class="duel-card duel-empty"><h3>No duels yet.</h3><p>Run a duel to see its teams, turns and outcome here.</p><code>roundtable duel "&lt;topic&gt;" --team-a designer,builder --team-b critic,engineer --judges judge</code></div>`}</div></section>`);
}

export function renderCasting(base: string, input?: unknown): string {
  const value = redactedData(input);
  if (value === undefined) return page(base, "Casting", `<header class="duel-hero"><p class="eyebrow">Choose a team for the brief</p><h1>Casting</h1></header><div class="duel-card duel-empty"><h2>No casting report yet.</h2><p>Run <code>roundtable cast "&lt;topic&gt;"</code> to compare candidates and save a report here.</p></div>`);
  const r = obj(value), verdictNames: Record<string, string> = { cast: "Recommended", bench: "Reserve", redundant: "Overlapping", unclear: "Needs review" };
  const ranking = ["cast", "bench", "unclear", "redundant"];
  const candidates = arr(r.agents).map(obj).sort((a, b) => {
    const rank = (v: unknown) => ranking.includes(str(v)) ? ranking.indexOf(str(v)) : 4;
    return rank(a.verdict) - rank(b.verdict);
  });
  const notes = (label: string, values: unknown) => strings(values).length ? `<div class="casting-notes"><h3>${label}</h3><ul>${strings(values).map(s => `<li>${e(s)}</li>`).join("")}</ul></div>` : "";
  return page(base, "Casting", `<header class="duel-hero"><p class="eyebrow">Latest casting report</p><h1>${e(str(r.brief, "Casting report"))}</h1><p class="duel-summary">Candidates ranked by recommendation. Original order is kept within each verdict.</p><p>${humanTime(str(r.createdAt))}${r.dryRun === true ? ` · ${pill("Draft", "draft", "A dry run uses local checks without a director audition.")}` : ""}</p><p class="archive-id">${e(str(r.id))}</p>${r.note ? textBlock(str(r.note)) : ""}</header>` +
    `<section aria-label="Ranked candidates"><h2>Candidates</h2><div class="duel-grid casting-candidates">${candidates.map((a, index) => {
      const name = str(a.name, str(a.key, "Unknown candidate")), role = str(a.role, "participant"), verdict = str(a.verdict);
      return `<article class="duel-card casting-card"><div class="turn-top"><span class="candidate-rank">${index + 1}</span>${agentGlyph(name, role)}<div><h2>${e(name)}</h2><span class="muted">${e(role)}</span></div></div><p>${pill(verdictNames[verdict] ?? "Needs review", verdict === "cast" ? "completed" : verdict === "unclear" ? "interrupted" : "draft", verdict === "bench" ? "A reserve candidate for this brief." : verdict === "redundant" ? "Has substantial overlap with another candidate." : "Casting recommendation for this brief.")}</p>` +
        notes("Strengths", a.strengths) + notes("Risks", a.risks) + notes("Similar candidates", a.overlapsWith) +
        `<div class="lint-notes"><h3>Prompt checks</h3><p class="muted">Local checks for issues in the persona's instructions.</p>${arr(a.lint).map(obj).map(l => `<p>${pill(l.level === "warn" ? "Warning" : "Info", l.level === "warn" ? "interrupted" : "draft")} ${e(str(l.message))}${l.code ? ` <small>(${e(str(l.code))})</small>` : ""}</p>`).join("") || "<p>No findings recorded.</p>"}</div></article>`;
    }).join("") || `<p class="duel-card muted">No candidates were recorded.</p>`}</div></section>` +
    `<section class="duel-grid casting-context"><article class="duel-card"><h2>Recommended seats</h2>${notes("Cast", obj(r.recommended).seats)}${notes("Team A", obj(r.recommended).teamA)}${notes("Team B", obj(r.recommended).teamB)}${notes("Judges", obj(r.recommended).judges)}${!strings(obj(r.recommended).seats).length ? "<p>No seats recommended.</p>" : ""}</article><article class="duel-card"><h2>Similarity and gaps</h2><p class="muted">Similarity means two personas may bring the same perspective.</p>${arr(r.redundancy).map(obj).map(s => `<p><strong>${e(strings(s.keys).join(", "))}</strong>: ${e(str(s.reason))}</p>`).join("") || "<p>No similarity notes recorded.</p>"}${notes("Missing perspectives", r.gaps)}</article></section>` +
    `<details class="duel-card usage-card"><summary>Usage and cost</summary><p>Total: ${money(obj(r.usage).totalCostUsd)}${obj(r.usage).estimated ? " (estimated)" : ""}${count(obj(r.usage).unpricedTokens) ? ` + ${n(obj(r.usage).unpricedTokens)} tokens unpriced` : ""}</p>${num(obj(r.usage).capUsd) !== undefined ? `<p>Spent ${money(obj(r.usage).spentUsd)} of ${money(obj(r.usage).capUsd)} cap${obj(r.usage).capReached ? ". The spend cap was reached." : "."}</p>` : ""}</details>` + rawDetails(value, "Raw report (JSON)"));
}

export function duelPageRoutes(indexCsp: string, previews = new DuelPreviewHost()): Route[] {
  return [
    { path: "/static/duel.css", handler: c => c.send(200, DUEL_CSS, "text/css; charset=utf-8") },
    { path: "/static/duel.js", handler: c => c.send(200, DUEL_JS, "text/javascript; charset=utf-8") },
    { path: "/duels", handler: c => c.html(200, renderDuels(c.base, listDuelPages(), persistedLiveDuels()), indexCsp) },
    { path: /^\/duels\/([^/]+)\.json$/, handler(c) {
      const id = c.match![1], d = ID_RE.test(id) ? loadDuel(id) : undefined;
      if (!d) return c.notFound();
      c.send(200, JSON.stringify(d.raw, null, 2), "application/json; charset=utf-8", { "Content-Disposition": `attachment; filename="${id}.json"` });
    } },
    { path: /^\/duels\/([^/]+)$/, async handler(c) {
      const d = loadDuel(c.match![1]);
      if (!d) return c.notFound();
      const urls = await previews.publish(d.prototypes, `http://${c.req.headers.host}`);
      const origins = [...new Set([...urls.values()].map(u => new URL(u).origin))];
      c.html(200, renderDuel(c.base, d, urls), origins.length ? `${indexCsp}; frame-src ${origins.join(" ")}` : indexCsp);
    } },
    { path: "/casting", handler(c) {
      let report: unknown;
      try { report = readPageData(join(ROUNDTABLE_HOME, "casting", "latest.json")); } catch { /* empty state */ }
      c.html(200, renderCasting(c.base, report), indexCsp);
    } },
  ];
}

import { scrub } from "../security/secrets.js";
import { clean } from "./text.js";
export { clean } from "./text.js";
import { renderRoster } from "../casting/report.js";
import { NO_PRICE_LABEL } from "../usage/format.js";
import type { Seat, TableEvent, TableObserver, TeamMetrics } from "./events.js";

export interface TerminalOutput { write(text: string): unknown; isTTY?: boolean; columns?: number }
export interface TerminalOptions {
  output?: TerminalOutput;
  env?: NodeJS.ProcessEnv;
  width?: number;
  agentsDir?: string;
  /** Two teams side by side ("split"), interleaved ("stack"), or split on a wide TTY ("auto", the default). */
  layout?: "auto" | "split" | "stack";
}
const oneLine = (text: string): string => clean(scrub(text)).replace(/\s+/g, " ").trim();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const glyphs = (text: string): string[] => [...segmenter.segment(text)].map(part => part.segment);
/** Visible terminal cells after removing control sequences. */
export function visibleWidth(text: string): number {
  return glyphs(clean(text)).reduce((n, ch) => {
    const cp = ch.codePointAt(0)!;
    if (/^\p{Mark}+$/u.test(ch) || cp === 0x200d || cp === 0xfe0f) return n;
    return n + (/\p{Extended_Pictographic}/u.test(ch) || cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300) ? 2 : 1);
  }, 0);
}
function wrapped(text: string, width: number, limit = 6): string[] {
  const lines: string[] = [];
  for (const paragraph of clean(scrub(text)).split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && visibleWidth(line + word) > width) { lines.push(line.trimEnd()); line = ""; }
      for (const ch of glyphs(word)) {
        if (line && visibleWidth(line + ch) > width) { lines.push(line.trimEnd()); line = ""; }
        line += ch;
      }
      line += " ";
    }
    lines.push(line.trimEnd());
    if (lines.length > limit) break;
  }
  if (lines.length <= limit) return lines;
  let last = lines[limit - 1];
  while (visibleWidth(last) > width - 1) last = glyphs(last).slice(0, -1).join("");
  return [...lines.slice(0, limit - 1), last + "…"];
}
const elapsed = (ms: number): string => { const seconds = Math.floor(ms / 1000); return `${seconds >= 60 ? `${Math.floor(seconds / 60)}m` : ""}${seconds % 60}s`; };
const tokensShort = (n: number): string => n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k` : `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
/** A seat's spend: dollars when priced, "N tok (no price)" when not, both when mixed. Never a bare $0.0000 for unpriced use. */
export function seatSpendText(costUsd: number, unpricedTokens = 0): string {
  const unpriced = unpricedTokens > 0 ? `${tokensShort(unpricedTokens)} tok (${NO_PRICE_LABEL})` : "";
  return unpriced && costUsd <= 0 ? unpriced : unpriced ? `$${costUsd.toFixed(4)} + ${unpriced}` : `$${costUsd.toFixed(4)}`;
}
/** The footer total: "$0.0123 + 41.2k tok unpriced", or just the tokens when nothing was priced. */
export function totalSpendText(costUsd: number, unpricedTokens = 0): string {
  if (unpricedTokens <= 0) return `$${costUsd.toFixed(4)}`;
  return costUsd > 0 ? `$${costUsd.toFixed(4)} + ${tokensShort(unpricedTokens)} tok unpriced` : `${tokensShort(unpricedTokens)} tok unpriced`;
}
/** A routed seat's reason is "excluded...; excluded...; chosen: ...": the exclusions are shared, the choice is the seat's. */
export function splitRoutingReason(reason: string | undefined): { excluded: string[]; chosen?: string } {
  if (!reason) return { excluded: [] };
  const parts = reason.split("; ");
  return /chosen: /.test(parts[parts.length - 1]) ? { excluded: parts.slice(0, -1), chosen: parts[parts.length - 1] } : { excluded: [], chosen: reason };
}

export function createTerminalObserver(options: TerminalOptions = {}): TableObserver {
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  const color = !!output.isTTY && env.NO_COLOR === undefined;
  const width = Math.max(20, options.width ?? output.columns ?? 88);
  const paint = (code: number, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const seatColor = (seat: Seat) => 31 + ([...seat.id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0) % 6);
  const label = (seat: Seat, reason?: string) => paint(seatColor(seat), oneLine(`${seat.name} · ${seat.role ?? seat.team ?? "at the table"} · [${seat.provider}/${seat.model || "default"}]${reason ? ` · ${reason}` : ""}`));
  const split = width >= 100 && (options.layout === "split" || ((options.layout ?? "auto") === "auto" && !!output.isTTY));
  const columnWidth = Math.floor((width - 3) / 2);
  const pad = (text: string) => text + " ".repeat(Math.max(0, columnWidth - visibleWidth(text)));
  const pair = (left: string, right: string) => output.write(`${pad(left)} │ ${pad(right)}\n`);
  const tag = (team: "A" | "B") => paint(team === "A" ? 36 : 35, `[${team}]`);
  let teams: Record<"A" | "B", string[]> = { A: [], B: [] };
  let metrics: Partial<Record<"A" | "B", TeamMetrics>> = {};
  const progress: Partial<Record<"A" | "B", { stage: number; of: number }>> = {};
  const teamOf = (seat: Seat): "A" | "B" | undefined => teams.A.includes(seat.id) ? "A" : teams.B.includes(seat.id) ? "B" : seat.team === "A" || seat.team === "B" ? seat.team : undefined;
  const teamLine = (team: "A" | "B", text: string, code?: number) => {
    if (split) for (const line of wrapped(text, columnWidth, Infinity)) {
      const colored = code ? paint(code, line) : line;
      pair(team === "A" ? colored : "", team === "B" ? colored : "");
    } else output.write(`${tag(team)} ${text}\n`);
  };
  const status = (team: "A" | "B") => {
    const m = metrics[team], p = progress[team];
    return `${team} ${m ? `${m.stagesDone}/${m.stagesTotal} · ${elapsed(m.elapsedMs)} · ${tokensShort(m.inputTokens + m.outputTokens)} tok` : p ? `${p.stage}/${p.of}` : "waiting"}${m?.finishedAt ? " · done" : ""}`;
  };
  const statusLine = () => {
    if (split) {
      const a = wrapped(status("A"), columnWidth, Infinity), b = wrapped(status("B"), columnWidth, Infinity);
      for (let i = 0; i < Math.max(a.length, b.length); i++) pair(a[i] ?? "", b[i] ?? "");
    } else output.write(`${status("A")} | ${status("B")}\n`);
  };
  const metricsTable = () => {
    const rows = (team: "A" | "B") => {
      const m = metrics[team];
      return m ? [`Team ${team}`, `Tokens: ${tokensShort(m.inputTokens + m.outputTokens)}${m.estimated ? " (estimated)" : ""}`, `Cost: ${seatSpendText(m.costUsd, m.unpricedTokens)}`, `Time: ${elapsed(m.elapsedMs)}`, `Versions: ${m.versions}`, `Rewrites: ${m.rewrites}`, `Errors: ${m.failedTurns + m.validationFailures + m.pageErrors}`] : [`Team ${team}: no metrics`];
    };
    const a = rows("A"), b = rows("B");
    if (split) {
      for (let row = 0; row < Math.max(a.length, b.length); row++) {
        const left = wrapped(a[row] ?? "", columnWidth, Infinity), right = wrapped(b[row] ?? "", columnWidth, Infinity);
        for (let i = 0; i < Math.max(left.length, right.length); i++) pair(left[i] ?? "", right[i] ?? "");
      }
    } else output.write([...a, ...b].join("\n") + "\n");
  };
  let spend = 0, unpriced = 0;
  let perSeat: Extract<TableEvent, { type: "usage" }>["perSeat"] = [];
  return { onEvent(event) {
    switch (event.type) {
      case "start": {
        teams = event.teams ?? { A: event.seats.filter(s => s.team === "A").map(s => s.id), B: event.seats.filter(s => s.team === "B").map(s => s.id) };
        if (!event.resumed) { metrics = {}; delete progress.A; delete progress.B; spend = 0; unpriced = 0; perSeat = []; }
        output.write(`At the table: ${oneLine(event.topic)}\n`);
        // Exclusions are shared by every routed seat: print each once, then only the per-seat choice.
        const split = event.seats.map(seat => splitRoutingReason(seat.reason));
        const shared = [...new Set(split.flatMap(s => s.excluded))];
        if (shared.length) output.write(`  Routing: ${oneLine(shared.join("; "))}\n`);
        event.seats.forEach((seat, i) => output.write(`  ${label(seat, split[i].chosen)}\n`));
        break;
      }
      case "turn": {
        const team = teamOf(event.seat);
        if (team && split && !/closing/i.test(event.round)) {
          teamLine(team, `● ${clean(label(event.seat))}`, seatColor(event.seat));
          for (const line of wrapped(event.text, columnWidth)) teamLine(team, line);
        } else {
          output.write(`\n${team ? tag(team) + " " : ""}● ${label(event.seat)}\n`);
          for (const line of wrapped(event.text, team ? width - 4 : width)) output.write(`${team ? tag(team) + " " : ""}${line}\n`);
        }
        break;
      }
      case "prototype": teamLine(event.team, `Prototype ${event.team}: ${event.ok ? `${oneLine(event.title ?? "untitled artifact")}${event.kind && event.kind !== "web" ? ` [${event.kind}]` : ""} (${event.files.length} files, ${event.files.reduce((n, f) => n + f.bytes, 0)} bytes)` : "unavailable"}`); break;
      case "stage":
        progress[event.team] = { stage: event.stage, of: event.of };
        teamLine(event.team, `▸ Stage ${event.stage}/${event.of} ${oneLine(event.name)} · ${event.status}${event.version ? ` (v${event.version})` : ""}`);
        if (event.status === "done") statusLine();
        break;
      case "metrics": metrics = event.teams; break;
      case "control": output.write(event.action === "resumed" ? "Resumed\n" : `Stopped by ${oneLine(event.by)}\n`); break;
      case "decision": output.write(event.status === "awaiting" ? "Waiting for you to choose the winner in the room.\n" : `You chose Team ${event.winner}.\n`); break;
      case "assessment": output.write(`${oneLine(event.judge.name)} → ${event.team} ${paint(event.verdict === "APPROVE" ? 32 : event.verdict === "REJECT" ? 31 : 33, `[${event.verdict}]`)} ${(lines => (lines[0] ?? "") + (lines.length > 1 ? "…" : ""))(wrapped(event.reason, width))}\n`); break;
      case "dissent": output.write(`Dissent · ${label(event.seat)}\n${wrapped(event.text, width).join("\n")}\n`); break;
      case "usage": spend = event.totalCostUsd; unpriced = event.totalUnpricedTokens ?? 0; perSeat = event.perSeat; break;
      case "roster": output.write("\n" + renderRoster(event.report, options.agentsDir)); break;
      case "end":
        if (event.mode === "casting") { output.write(`\n${event.aborted ? "Aborted" : "Done"} · Spend: ${totalSpendText(spend, unpriced)}\n`); break; }
        output.write(`\n${event.aborted ? "Aborted" : event.winner === "tie" ? "Tie" : event.winner === "none" ? "No verdict" : `Winner: ${event.winner}`} · A ${event.tally.A} / B ${event.tally.B}\nSpend: ${totalSpendText(spend, unpriced)}${perSeat.length ? ` (${perSeat.map(s => `${oneLine(s.seatId)} ${seatSpendText(s.costUsd, s.unpricedTokens)}`).join(", ")})` : ""}\n`);
        if (event.decidedBy) output.write(event.decidedBy === "human" ? "Chosen by you\n" : `Judges' tally A ${event.tally.A} / B ${event.tally.B}\n`);
        if (event.chosen) output.write(`Chosen artifact: ${oneLine(event.chosen.dir)}\n`);
        if (event.metrics) metrics = event.metrics;
        if (metrics.A || metrics.B) metricsTable();
    }
  } };
}
export function createNdjsonObserver(output: TerminalOutput = process.stdout): TableObserver {
  return { onEvent(event) { output.write(JSON.stringify(event).replace(/[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n"); } };
}

import { clean } from "./text.js";
export { clean } from "./text.js";
import { renderRoster } from "../casting/report.js";
import { NO_PRICE_LABEL } from "../usage/format.js";
import type { Seat, TableEvent, TableObserver } from "./events.js";

export interface TerminalOutput { write(text: string): unknown; isTTY?: boolean; columns?: number }
export interface TerminalOptions {
  output?: TerminalOutput;
  env?: NodeJS.ProcessEnv;
  width?: number;
  agentsDir?: string;
  /** Two teams side by side ("split"), interleaved ("stack"), or split on a wide TTY ("auto", the default). */
  layout?: "auto" | "split" | "stack";
}
const oneLine = (text: string): string => clean(text).replace(/\s+/g, " ").trim();
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of clean(text).split(/\r?\n/)) {
    let line = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) { lines.push(line); line = ""; }
      while (word.length > width) { lines.push(word.slice(0, width)); word = word.slice(width); }
      line += (line ? " " : "") + word;
    }
    lines.push(line);
    if (lines.length > 6) break;
  }
  return lines.length > 6 ? [...lines.slice(0, 5), lines[5].slice(0, Math.max(0, width - 1)) + "…"] : lines;
}
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
  const width = Math.max(20, Math.min(options.width ?? output.columns ?? 88, 120));
  const paint = (code: number, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const seatColor = (seat: Seat) => 31 + ([...seat.id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0) % 6);
  const label = (seat: Seat, reason?: string) => paint(seatColor(seat), oneLine(`${seat.name} · ${seat.role ?? seat.team ?? "at the table"} · [${seat.provider}/${seat.model || "default"}]${reason ? ` · ${reason}` : ""}`));
  let spend = 0, unpriced = 0;
  let perSeat: Extract<TableEvent, { type: "usage" }>["perSeat"] = [];
  return { onEvent(event) {
    switch (event.type) {
      case "start": {
        output.write(`At the table: ${oneLine(event.topic)}\n`);
        // Exclusions are shared by every routed seat: print each once, then only the per-seat choice.
        const split = event.seats.map(seat => splitRoutingReason(seat.reason));
        const shared = [...new Set(split.flatMap(s => s.excluded))];
        if (shared.length) output.write(`  Routing: ${oneLine(shared.join("; "))}\n`);
        event.seats.forEach((seat, i) => output.write(`  ${label(seat, split[i].chosen)}\n`));
        break;
      }
      case "turn": output.write(`\n● ${label(event.seat)}\n${wrapped(event.text, width).join("\n")}\n`); break;
      case "prototype": output.write(`Prototype ${event.team}: ${event.ok ? `${oneLine(event.title ?? "untitled artifact")}${event.kind && event.kind !== "web" ? ` [${event.kind}]` : ""} (${event.files.length} files, ${event.files.reduce((n, f) => n + f.bytes, 0)} bytes)` : "unavailable"}\n`); break;
      case "assessment": output.write(`${oneLine(event.judge.name)} → ${event.team} ${paint(event.verdict === "APPROVE" ? 32 : event.verdict === "REJECT" ? 31 : 33, `[${event.verdict}]`)} ${(lines => (lines[0] ?? "") + (lines.length > 1 ? "…" : ""))(wrapped(event.reason, width))}\n`); break;
      case "dissent": output.write(`Dissent · ${label(event.seat)}\n${wrapped(event.text, width).join("\n")}\n`); break;
      case "usage": spend = event.totalCostUsd; unpriced = event.totalUnpricedTokens ?? 0; perSeat = event.perSeat; break;
      case "roster": output.write("\n" + renderRoster(event.report, options.agentsDir)); break;
      case "end":
        if (event.mode === "casting") { output.write(`\n${event.aborted ? "Aborted" : "Done"} · Spend: ${totalSpendText(spend, unpriced)}\n`); break; }
        output.write(`\n${event.aborted ? "Aborted" : event.winner === "tie" ? "Tie" : event.winner === "none" ? "No verdict" : `Winner: ${event.winner}`} · A ${event.tally.A} / B ${event.tally.B}\nSpend: ${totalSpendText(spend, unpriced)}${perSeat.length ? ` (${perSeat.map(s => `${clean(s.seatId)} ${seatSpendText(s.costUsd, s.unpricedTokens)}`).join(", ")})` : ""}\n`);
    }
  } };
}
export function createNdjsonObserver(output: TerminalOutput = process.stdout): TableObserver {
  return { onEvent(event) { output.write(JSON.stringify(event).replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n"); } };
}

import type { Seat, TableEvent, TableObserver } from "./events.js";

export interface TerminalOutput { write(text: string): unknown; isTTY?: boolean; columns?: number }
export interface TerminalOptions { output?: TerminalOutput; env?: NodeJS.ProcessEnv; width?: number }
export const clean = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
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
export function createTerminalObserver(options: TerminalOptions = {}): TableObserver {
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  const color = !!output.isTTY && env.NO_COLOR === undefined;
  const width = Math.max(20, Math.min(options.width ?? output.columns ?? 88, 120));
  const paint = (code: number, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const seatColor = (seat: Seat) => 31 + ([...seat.id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0) % 6);
  const label = (seat: Seat) => paint(seatColor(seat), oneLine(`${seat.name} · ${seat.role ?? seat.team ?? "at the table"} · [${seat.provider}/${seat.model}]`));
  let spend = 0;
  let perSeat: Extract<TableEvent, { type: "usage" }>["perSeat"] = [];
  return { onEvent(event) {
    switch (event.type) {
      case "start": output.write(`At the table: ${oneLine(event.topic)}\n`); break;
      case "turn": output.write(`\n● ${label(event.seat)}\n${wrapped(event.text, width).join("\n")}\n`); break;
      case "prototype": output.write(`Prototype ${event.team}: ${event.ok ? `${oneLine(event.title ?? "playable game")} (${event.files.length} files, ${event.files.reduce((n, f) => n + f.bytes, 0)} bytes)` : "unavailable"}\n`); break;
      case "assessment": output.write(`${oneLine(event.judge.name)} → ${event.team} ${paint(event.verdict === "APPROVE" ? 32 : event.verdict === "REJECT" ? 31 : 33, `[${event.verdict}]`)} ${(lines => (lines[0] ?? "") + (lines.length > 1 ? "…" : ""))(wrapped(event.reason, width))}\n`); break;
      case "dissent": output.write(`Dissent · ${label(event.seat)}\n${wrapped(event.text, width).join("\n")}\n`); break;
      case "usage": spend = event.totalCostUsd; perSeat = event.perSeat; break;
      case "end":
        output.write(`\n${event.aborted ? "Aborted" : event.winner === "tie" ? "Tie" : event.winner === "none" ? "No verdict" : `Winner: ${event.winner}`} · A ${event.tally.A} / B ${event.tally.B}\nSpend: $${spend.toFixed(4)}${perSeat.length ? ` (${perSeat.map(s => `${clean(s.seatId)} $${s.costUsd.toFixed(4)}`).join(", ")})` : ""}\n`);
    }
  } };
}
export function createNdjsonObserver(output: TerminalOutput = process.stdout): TableObserver {
  return { onEvent(event) { output.write(JSON.stringify(event).replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n"); } };
}

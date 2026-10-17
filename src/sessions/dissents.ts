import type { ArchivedSession } from "./archive.js";
import type { Contract } from "../execution/types.js";

type Concern = Pick<Contract["dissents"][number], "claim" | "predicted_failure">;

/**
 * Only complete blocks on the answer's own, unindented lines count. Like ownLines in
 * escalation.ts, ignore backtick/tilde fences and blockquotes. Invalidate a block if
 * excluded text interrupts it, so filtering cannot splice a forged block together.
 * Extra fields (including Decision/Outcome directives) and multiline values fail closed.
 * Contract validation enforces the shared text and count limits at import.
 */
export function parseDissentBlocks(text: string): Concern[] {
  const out: Concern[] = [];
  let fence: string | undefined;
  let lines: string[] | undefined;
  let invalid = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === undefined) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
      if (lines) invalid = true;
      continue;
    }
    if (fence !== undefined || /^\s*>/.test(line) || /^\s+\S/.test(line)) {
      if (lines) invalid = true;
      continue;
    }
    if (line === "<DISSENT>") {
      if (lines) invalid = true;
      else { lines = []; invalid = false; }
    } else if (line === "</DISSENT>" && lines) {
      const claim = /^claim: (\S.*)$/.exec(lines[0] ?? "")?.[1].trim();
      const prediction = /^predicted_failure: (\S.*)$/.exec(lines[1] ?? "")?.[1].trim();
      if (!invalid && lines.length === 2 && claim && prediction) out.push({ claim, predicted_failure: prediction });
      lines = undefined;
    } else if (lines) {
      // Only two single-line values are accepted; do not retain an unbounded malformed block.
      if (lines.length < 2) lines.push(line);
      else invalid = true;
    }
  }
  return out;
}

/** Identity and provenance come from the session, never from model-written fields. */
export function sessionDissentDrafts(session: ArchivedSession): Contract["dissents"] {
  if (session.mode !== "debate" && session.mode !== "waffle-house") return [];
  const kind: "debate" | "waffle_house" = session.mode === "debate" ? "debate" : "waffle_house";
  const summaries = session.kind === "collaboration"
    ? (session.dissentSummaries ?? []).filter((s) => session.agents.slice(1).includes(s.agent))
    : (session.kind === "meeting" || session.kind === "local-meeting") && session.mode === "debate" && session.summary
      ? [{ agent: session.agents[0], content: session.summary }]
      : [];
  return summaries.flatMap((s) => parseDissentBlocks(s.content).map((concern) => ({
    ...concern, by: s.agent, source: { kind, ref: session.id }, on_fire: "huddle" as const,
  }))).map((d, i) => ({ ...d, id: `${kind}-dissent-${i + 1}` }));
}

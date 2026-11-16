// ============================================================================
// Lesson sign-off policy: ROUNDTABLE_LESSON_SIGNOFF=human limits sign-off to the CLI and the dashboard form (#251)
// ============================================================================

import { clean } from "../table/text.js";

let warnedInvalid = false;

/** Read at call time. Invalid values require CLI or dashboard sign-off and warn once per process. */
export function lessonSignoffMode(): "any" | "human" {
  const raw = process.env.ROUNDTABLE_LESSON_SIGNOFF ?? "";
  const value = raw.trim().toLowerCase();
  if (!value || value === "any") return "any";
  if (value === "human") return "human";
  if (!warnedInvalid) {
    warnedInvalid = true;
    const display = clean(raw).replace(/[\t\n]/g, "").slice(0, 32);
    process.stderr.write(`[Roundtable] ROUNDTABLE_LESSON_SIGNOFF=${display} is not "any" or "human"; treating it as "human".\n`);
  }
  return "human";
}

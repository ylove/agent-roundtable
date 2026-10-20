// ============================================================================
// The usage view as a tool hands it to a model: every string redacted (secrets and personal data)
// ============================================================================

import { redact } from "../publishers/redact.js";
import type { UsageView } from "./types.js";

/** Every string in the view, redacted (secrets and personal data): what a tool hands to a model. */
export function redactedView(view: UsageView): UsageView {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(view) as UsageView;
}

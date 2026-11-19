import { createHash } from "node:crypto";
import { escapeHtml } from "../http/secure-server.js";
import { redact } from "../publishers/redact.js";

export type AgentRole = "builder" | "designer" | "judge" | "critic" | "other";
export function agentRole(role: string): AgentRole {
  if (/judge|adjudicat/i.test(role)) return "judge";
  if (/critic|skeptic|review/i.test(role)) return "critic";
  if (/design|artist/i.test(role)) return "designer";
  if (/build|engineer|develop|cod/i.test(role)) return "builder";
  return "other";
}

/** Original geometric busts: no external artwork, ids, inline styles, or random state. */
export function agentGlyph(name: string, role = "participant"): string {
  const safeName = redact(name).text, safeRole = redact(role).text;
  const hash = createHash("sha256").update(safeName).digest();
  const kind = agentRole(role), eye = 19 + hash[0] % 4, radius = 9 + hash[1] % 5;
  const accessory: Record<AgentRole, string> = {
    builder: '<path d="M40 35l-9 12m8-14l5 4-4 5-5-4"/>',
    designer: '<path d="M32 47l3-9 7-9 4 3-8 10zM35 38l4 3"/>',
    judge: '<path d="M34 40h13m-7-10v16m-8 0h15m-14-7l3-7 3 7zm8 0l3-7 3 7z"/>',
    critic: '<circle cx="38" cy="36" r="6"/><path d="M42 41l5 7"/>',
    other: '<circle cx="39" cy="41" r="3"/>',
  };
  return `<svg class="agent-glyph role-${kind} glyph-tone-${hash[2] % 4}" viewBox="0 0 56 56" width="56" height="56" role="img" aria-label="${escapeHtml(`${safeName}, ${safeRole}`)}">` +
    `<path class="agent-body" d="M6 51c0-15 8-20 20-20s20 5 20 20"/>` +
    `<rect class="agent-head" x="12" y="5" width="28" height="29" rx="${radius}"/>` +
    `<path class="agent-hair" d="M15 12l${5 + hash[3] % 8} -4 13 4"/>` +
    `<g class="agent-face"><circle cx="${eye}" cy="20" r="1.6"/><circle cx="${eye + 9}" cy="20" r="1.6"/><path d="M22 27q4 ${hash[4] % 4} 8-1"/></g>` +
    `<g class="agent-accessory accessory-${kind}">${accessory[kind]}</g></svg>`;
}

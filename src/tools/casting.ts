import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runCastingCall, type CastingOptions } from "../casting/casting.js";
import { renderCastingMarkdown } from "../casting/report.js";
import { START_DUEL_SCHEMA } from "./duel.js";
import type { ToolCallContext } from "./shared.js";
import type { JsonSchema } from "../validate.js";

export const CASTING_CALL_SCHEMA: JsonSchema & { type: "object" } = {
  type: "object",
  properties: {
    brief: { type: "string", minLength: 1, maxLength: 4000, description: "The brief the personas audition for." },
    agents: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 24, description: "Persona identifiers; omitted means every persona in agents_dir." },
    agents_dir: { type: "string", minLength: 1, description: "Absolute persona directory." },
    seats: { type: "number", minimum: 1, maximum: 24, description: "Recommended cast size; default min(5, personas). Must be a whole number." },
    examine: { type: "boolean", description: "Cross-examine personas after their auditions; default true." },
    dry_run: { type: "boolean", description: "Only local lint and overlap checks; no provider calls or keys." },
    provider: START_DUEL_SCHEMA.properties!.provider,
    model: START_DUEL_SCHEMA.properties!.model,
    seat: START_DUEL_SCHEMA.properties!.seats,
    mix: { type: "string", enum: ["auto", "cheap"], description: "Prefer lower-cost providers using the table's routing judgment." },
    turn_timeout_s: { ...START_DUEL_SCHEMA.properties!.turn_timeout_s, description: "Seconds per turn; default 90." },
    max_seconds: { ...START_DUEL_SCHEMA.properties!.max_seconds, description: "Whole-run deadline; default 300 seconds. Stops new calls and archives available results." },
  },
  required: ["brief"],
};
export const CASTING_CALL_DESCRIPTION = "Audition 2 to 24 personas for any brief. A neutral casting director cross-examines their claims, identifies redundancy and gaps, and recommends a cast (with duel teams when at least four seats are requested). Returns the roster in markdown, archive id and usage. Runs the whole casting call with progress notifications on every visible step. dry_run performs static checks without keys or provider calls.";

export async function castingCallTool(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<CallToolResult> {
  args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
  const opts: CastingOptions = {
    brief: args.brief as string, agents: args.agents as string[] | undefined, agentsDir: args.agents_dir as string | undefined,
    seats: args.seats as number | undefined, examine: args.examine as boolean | undefined, dryRun: args.dry_run as boolean | undefined,
    provider: args.provider as CastingOptions["provider"], model: args.model as string | undefined, seat: args.seat as CastingOptions["seat"], mix: args.mix as CastingOptions["mix"],
    ...(args.turn_timeout_s !== undefined && { turnTimeoutMs: (args.turn_timeout_s as number) * 1000 }),
    ...(args.max_seconds !== undefined && { maxSeconds: args.max_seconds as number }),
  };
  let step = 0;
  let routing: Array<{ id: string; provider: string; model: string; reason?: string }> = [];
  const report = await runCastingCall(opts, { onEvent(event) {
    if (event.type === "start") routing = event.seats.map(({ id, provider, model, reason }) => ({ id, provider, model, reason }));
    ctx?.progress?.(++step, undefined, event.type === "turn" ? `${event.round}: ${event.seat.name}` : event.type);
  } }, ctx?.signal ?? new AbortController().signal);
  return { content: [{ type: "text", text: renderCastingMarkdown(report, opts.agentsDir) }], structuredContent: { report, archive_id: report.id, archive: `casting/${report.id}.json`, usage: report.usage, routing } };
}

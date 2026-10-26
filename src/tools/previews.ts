// ============================================================================
// Preview tools (orchestrator server only): start_preview, list_previews, stop_preview
//
// A heads-down task's build or a duel prototype runs its dev server in a locked-down Docker container
// published on 127.0.0.1 only. The logic and the validation live in src/previews/; the same checks
// apply as for `roundtable preview`.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { refreshPreviews, startPreview, stopPreview, type StartInput } from "../previews/manager.js";
import { PREVIEW_ID_RE } from "../previews/args.js";
import { PREVIEW_SCRIPTS, PreviewError } from "../previews/scripts.js";
import { previewLabel } from "../previews/embed.js";
import type { PreviewRecord } from "../previews/store.js";
import { LIST_PREVIEWS, START_PREVIEW, STOP_PREVIEW } from "./names.js";
import { ORCHESTRATOR_ONLY, READ_ONLY_LOCAL, type ToolArgs, type ToolDefinition } from "./shared.js";

export const previewTools: ToolDefinition[] = [
  {
    name: START_PREVIEW,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Start preview", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Preview a web app live: run a heads-down task's dev server (execution_id and task_id) or a duel prototype directory (prototype) in a locked-down Docker container, published on 127.0.0.1 only (no tunnel, never 0.0.0.0). " +
      "It runs the package's dev, start or preview script (script picks one) as `npm run <script>`; the server must listen on 0.0.0.0 and honour PORT. " +
      "When the source has no node_modules the dependencies are installed inside the container, through a proxy that allows only the npm registry, with lifecycle scripts off. " +
      "Returns the preview id and its http://127.0.0.1:<port> url, and the page check. The dashboard task page, the duel room and the serve index embed it. Idle previews stop after 30 minutes; at most 3 run at once.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        execution_id: { type: "string", pattern: "^exe-[0-9a-hjkmnp-tv-z]{16}$", description: "The heads-down run (exe-…); goes with task_id." },
        task_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "The task whose worktree to preview." },
        prototype: { type: "string", maxLength: 1024, description: "Instead of a task: an absolute prototype directory under the prototype root (a duel team's version)." },
        script: { type: "string", enum: [...PREVIEW_SCRIPTS], description: "The package script to run (default: the first of dev, start, preview that exists)." },
        port: { type: "integer", minimum: 1024, maximum: 65535, description: "The port the dev server listens on in the container (default: the usual port of the package's dev server, else 3000)." },
      },
    },
  },
  {
    name: LIST_PREVIEWS,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "List previews", ...READ_ONLY_LOCAL },
    description: "The running dev-server previews: id, url, what they show and the page check.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: STOP_PREVIEW,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Stop preview", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Stop a preview and remove its container.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { preview_id: { type: "string", pattern: "^prv-[0-9a-hjkmnp-tv-z]{8}$", description: "The preview (prv-…)." } },
      required: ["preview_id"],
    },
  },
];

const render = (body: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });

const view = (r: PreviewRecord) => ({
  preview_id: r.id, url: `${r.origin}/`, shows: previewLabel(r), script: r.script, container_port: r.container_port,
  started_at: r.started_at, idle_ttl_min: Math.round(r.ttl_ms / 60_000), ...(r.check && { page_check: r.check }),
});

/** The tool arguments as the manager's input (a bad value is a PreviewError the caller sees as the tool's error). */
export function startInput(a: Record<string, unknown>): StartInput {
  const input: StartInput = {};
  if (a.execution_id !== undefined) input.execution = a.execution_id as string;
  if (a.task_id !== undefined) input.task = a.task_id as string;
  if (a.prototype !== undefined) input.prototype = a.prototype as string;
  if (a.script !== undefined) input.script = a.script as string;
  if (a.port !== undefined) input.port = a.port as number;
  return input;
}

export async function handlePreviewTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  const a = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined));
  switch (name) {
    case START_PREVIEW:
      return render(view(await startPreview(startInput(a))));
    case LIST_PREVIEWS:
      return render({ previews: (await refreshPreviews()).map(view) });
    case STOP_PREVIEW: {
      const id = a.preview_id;
      if (typeof id !== "string" || !PREVIEW_ID_RE.test(id)) throw new PreviewError("preview_id must be a preview id (prv-…)");
      return render({ preview_id: id, stopped: await stopPreview(id) });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

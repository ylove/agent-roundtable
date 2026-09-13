// --- Replicate (text models via the predictions API; schema-aware) ---
//
// Replicate has no OpenAI-compatible endpoint and rejects unknown input keys with 422, and every
// model declares its own input schema (prompt / system_prompt / max_tokens vs max_new_tokens ...).
// So we fetch the model's OpenAPI Input schema once per process, build an input that only uses
// keys the model declares, create a prediction, and poll it to a terminal state.
import { setTimeout as sleep } from "node:timers/promises";
import type { LLMMessage, ProviderCall } from "./shared.js";
import { assertNonEmpty, stripThinkTags } from "./shared.js";
import { requireEnv } from "../config.js";

const API_BASE = "https://api.replicate.com/v1";

export interface ReplicateModelRef {
  owner: string;
  name: string;
  version?: string;
}

const OWNER_OR_NAME = /^[A-Za-z0-9_.-]+$/;
const VERSION_ID = /^[A-Za-z0-9]+$/;

/**
 * Accepts "owner/name", "owner/name:version", and the URL forms
 * https://replicate.com/owner/name[/versions/<id>] (www., trailing slash, query and hash tolerated)
 * and https://api.replicate.com/v1/models/owner/name[/versions/<id>].
 */
export function parseReplicateModelRef(input: string): ReplicateModelRef {
  const invalid = () =>
    new Error(
      `Invalid Replicate model "${input}": expected owner/name, owner/name:version, or https://replicate.com/owner/name`
    );
  const raw = (input ?? "").trim();
  if (!raw) throw invalid();

  let owner: string | undefined;
  let name: string | undefined;
  let version: string | undefined;

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw invalid();
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "replicate.com" || host === "www.replicate.com") {
      // /owner/name or /owner/name/versions/<id>
      if (segments.length === 2) {
        [owner, name] = segments;
      } else if (segments.length === 4 && segments[2] === "versions") {
        [owner, name, , version] = segments;
      } else {
        throw invalid();
      }
    } else if (host === "api.replicate.com") {
      // /v1/models/owner/name or /v1/models/owner/name/versions/<id>
      if (segments[0] !== "v1" || segments[1] !== "models") throw invalid();
      if (segments.length === 4) {
        [, , owner, name] = segments;
      } else if (segments.length === 6 && segments[4] === "versions") {
        [, , owner, name, , version] = segments;
      } else {
        throw invalid();
      }
    } else {
      throw invalid();
    }
  } else {
    const colon = raw.indexOf(":");
    const path = colon >= 0 ? raw.slice(0, colon) : raw;
    version = colon >= 0 ? raw.slice(colon + 1) : undefined;
    const parts = path.split("/");
    if (parts.length !== 2) throw invalid();
    [owner, name] = parts;
  }

  if (!owner || !name || !OWNER_OR_NAME.test(owner) || !OWNER_OR_NAME.test(name)) throw invalid();
  if (version !== undefined && !VERSION_ID.test(version)) throw invalid();
  return version ? { owner, name, version } : { owner, name };
}

export function formatReplicateModelRef(ref: ReplicateModelRef): string {
  return ref.version ? `${ref.owner}/${ref.name}:${ref.version}` : `${ref.owner}/${ref.name}`;
}

export interface ReplicateInputSchema {
  keys: Set<string>;
}

interface ReplicateModelResponse {
  detail?: string;
  title?: string;
  // GET /models/{owner}/{name}
  latest_version?: { openapi_schema?: OpenApiSchema };
  // GET /models/{owner}/{name}/versions/{id}
  openapi_schema?: OpenApiSchema;
}

interface OpenApiSchema {
  components?: { schemas?: { Input?: { properties?: Record<string, unknown> } } };
}

// Keyed by formatReplicateModelRef. Storing the promise dedupes concurrent first calls.
const schemaCache = new Map<string, Promise<ReplicateInputSchema>>();
const tokenWarned = new Set<string>();

export function clearReplicateSchemaCache(): void {
  schemaCache.clear();
  tokenWarned.clear();
}

async function readJsonBestEffort(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function fetchReplicateInputSchema(
  ref: ReplicateModelRef,
  apiKey: string,
  signal?: AbortSignal
): Promise<ReplicateInputSchema> {
  const key = formatReplicateModelRef(ref);
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<ReplicateInputSchema> => {
    const url = ref.version
      ? `${API_BASE}/models/${ref.owner}/${ref.name}/versions/${ref.version}`
      : `${API_BASE}/models/${ref.owner}/${ref.name}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const body = (await readJsonBestEffort(response)) as ReplicateModelResponse;
    if (!response.ok) {
      let message = `Replicate API error (${response.status}) fetching schema for model ${key}: ${
        body.detail || response.statusText
      }`;
      if (response.status === 404) {
        message += " — check owner/name; community models may need owner/name:version";
      }
      throw new Error(message);
    }
    const schema = ref.version ? body.openapi_schema : body.latest_version?.openapi_schema;
    const properties = schema?.components?.schemas?.Input?.properties;
    if (!properties || typeof properties !== "object") {
      console.error(`[Replicate] model ${key} exposes no Input schema; sending {prompt} only`);
      return { keys: new Set<string>() };
    }
    return { keys: new Set(Object.keys(properties)) };
  })();

  schemaCache.set(key, pending);
  // A transient failure must not poison the process: forget the rejected promise.
  pending.catch(() => {
    if (schemaCache.get(key) === pending) schemaCache.delete(key);
  });
  return pending;
}

/**
 * Render the chat transcript into the model's declared input keys and nothing else.
 */
export function buildReplicateInput(
  messages: LLMMessage[],
  schema: ReplicateInputSchema,
  options: { maxTokens: number; temperature?: number; modelRef?: string }
): Record<string, unknown> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n\n`)
    .join("");

  const input: Record<string, unknown> = {};
  if (schema.keys.has("system_prompt") && system) {
    input.system_prompt = system;
    input.prompt = transcript;
  } else {
    input.prompt = system ? `${system}\n\n${transcript}` : transcript;
  }

  if (schema.keys.has("max_tokens")) {
    input.max_tokens = options.maxTokens;
  } else if (schema.keys.has("max_new_tokens")) {
    input.max_new_tokens = options.maxTokens;
  } else {
    const label = options.modelRef ?? "(unknown)";
    if (!tokenWarned.has(label)) {
      tokenWarned.add(label);
      console.error(
        `[Replicate] model ${label} declares neither max_tokens nor max_new_tokens; sending no token limit`
      );
    }
  }

  if (options.temperature !== undefined && schema.keys.has("temperature")) {
    input.temperature = options.temperature;
  }
  return input;
}

export function normalizeReplicateOutput(output: unknown, ref: string): string {
  if (Array.isArray(output)) {
    const text = output.map(String).join("");
    if (!text) throw new Error(`Replicate returned no text for model ${ref}`);
    return text;
  }
  if (typeof output === "string") {
    if (!output) throw new Error(`Replicate returned no text for model ${ref}`);
    return output;
  }
  if (output === null || output === undefined) {
    throw new Error(`Replicate returned no text for model ${ref}`);
  }
  throw new Error(`Replicate returned unexpected output type ${typeof output} for model ${ref}`);
}

interface ReplicatePrediction {
  id?: string;
  status?: "starting" | "processing" | "succeeded" | "failed" | "canceled" | string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
  // error envelope
  detail?: string;
  title?: string;
  invalid_fields?: Array<{ field?: string }>;
}

export function createReplicateCall({
  pollIntervalMs = 1000,
  waitSeconds = 60,
}: { pollIntervalMs?: number; waitSeconds?: number } = {}): ProviderCall {
  return async (messages, o) => {
    const token = requireEnv("REPLICATE_API_TOKEN", "the replicate provider");
    const ref = parseReplicateModelRef(o.model);
    const refText = formatReplicateModelRef(ref);
    const schema = await fetchReplicateInputSchema(ref, token, o.signal);
    const input = buildReplicateInput(messages, schema, {
      maxTokens: o.maxTokens,
      temperature: o.temperature,
      modelRef: refText,
    });

    const createUrl = ref.version
      ? `${API_BASE}/predictions`
      : `${API_BASE}/models/${ref.owner}/${ref.name}/predictions`;
    const createBody = ref.version ? { version: ref.version, input } : { input };

    const response = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: `wait=${waitSeconds}`,
      },
      body: JSON.stringify(createBody),
      signal: o.signal,
    });
    let prediction = (await readJsonBestEffort(response)) as ReplicatePrediction;
    if (!response.ok) {
      let message = `Replicate API error (${response.status}) for model ${refText}: ${
        prediction.detail || prediction.title || response.statusText
      }`;
      const fields = (prediction.invalid_fields ?? [])
        .map((f) => f.field)
        .filter((f): f is string => Boolean(f));
      if (fields.length > 0) message += ` (invalid fields: ${fields.join(", ")})`;
      throw new Error(message);
    }

    const terminal = (p: ReplicatePrediction): string | undefined => {
      if (p.status === "succeeded") return normalizeReplicateOutput(p.output, refText);
      if (p.status === "failed" || p.status === "canceled") {
        throw new Error(
          `Replicate prediction ${p.status} for model ${refText}: ${p.error || "no error detail"}`
        );
      }
      return undefined;
    };

    let text = terminal(prediction);
    if (text === undefined) {
      const getUrl = prediction.urls?.get;
      if (!getUrl) throw new Error(`Replicate returned no polling URL for model ${refText}`);
      for (let polls = 1; ; polls++) {
        // The caller's signal is the single bound: sleep rejects with AbortError when it fires.
        await sleep(pollIntervalMs, undefined, { signal: o.signal });
        const pollResponse = await fetch(getUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: o.signal,
        });
        if (!pollResponse.ok) {
          throw new Error(`Replicate API error (${pollResponse.status}) polling model ${refText}`);
        }
        prediction = (await readJsonBestEffort(pollResponse)) as ReplicatePrediction;
        text = terminal(prediction);
        if (text !== undefined) break;
        if (polls % 15 === 0) {
          console.error(
            `[Replicate] still waiting on ${refText} (status: ${prediction.status ?? "unknown"}, polls: ${polls})`
          );
        }
      }
    }

    return {
      content: assertNonEmpty("Replicate", stripThinkTags(text)),
      model: refText,
      provider: "replicate",
      usage: undefined,
    };
  };
}

export const callReplicate: ProviderCall = createReplicateCall();

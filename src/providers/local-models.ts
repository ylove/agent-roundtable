export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export type ModelSize = "small" | "large" | "unknown";
export interface LocalModelSize { size: ModelSize; parameters?: string }
export interface OllamaDiscovery {
  reachable: boolean;
  models: readonly { name: string; size: ModelSize; parameters?: string }[];
}

/** Ollama reports the total parameter count, in billions or millions. */
export function parseParameterSize(value: unknown): LocalModelSize {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)\s*([BM])$/i.exec(value.trim()) : null;
  if (!match) return { size: "unknown" };
  const billions = Number(match[1]) / (match[2].toUpperCase() === "M" ? 1000 : 1);
  if (!Number.isFinite(billions) || billions <= 0) return { size: "unknown" };
  return { size: billions < 30 ? "small" : "large", parameters: `${match[1]}${match[2].toUpperCase()}` };
}

/** A size in a compatible model id must occupy a whole token. */
export function modelIdSize(model: string): LocalModelSize {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?=$|[^a-z0-9])/i.exec(model);
  return parseParameterSize(match ? `${match[1]}B` : undefined);
}

/** Bare names select only the :latest tag, never another tag with the same prefix. */
export function ollamaModel(discovery: OllamaDiscovery | undefined, model: string): OllamaDiscovery["models"][number] | undefined {
  const name = model.slice(model.lastIndexOf("/") + 1).includes(":") ? model : `${model}:latest`;
  return discovery?.models.find(entry => entry.name === name);
}

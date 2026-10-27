import { readUserConfig } from "../user-config.js";
import { validateRuntimeConfig, validateRuntimeSpec, type RuntimeSpec } from "./spec.js";

export const BUILTIN_RUNTIMES: Readonly<Record<string, RuntimeSpec>> = {
  hermes: { argv: ["hermes", "chat", "-q", "{prompt}"], output: { mode: "text", stripDecoration: true }, modelFlag: "--model", versionArgv: ["--version"] },
  openclaw: { argv: ["openclaw", "agent", "--message", "{prompt}"], output: { mode: "text" }, modelFlag: "--model", versionArgv: ["--version"] },
  gemini: { argv: ["gemini", "-p", "{prompt}", "--output-format", "json"], output: { mode: "json", path: "response" }, modelFlag: "--model", usage: { inputTokens: ["stats.tokens.input", "stats.models.*.tokens.input", "stats.models.*.tokens.prompt"], outputTokens: ["stats.tokens.output", "stats.models.*.tokens.candidates"], costUsd: "stats.cost" }, versionArgv: ["--version"] },
  agy: {
    // In agy 1.4.7 plan is a no-op with slash expansion disabled (the stderr warning is harmless).
    // Headless print mode's default permission denial keeps seats from editing; never bypass it.
    // -p requires its next argv element; raw stdin is not supported (only NDJSON envelopes are).
    argv: ["agy", "-p", "{prompt}", "--output-format", "json", "--mode", "plan", "--disable-slash-commands"],
    output: { mode: "json", path: "response", status: { path: "status", success: "SUCCESS", errorPath: "error" } },
    modelFlag: "--model",
    // Usage path arrays are alternatives, not sums: keep thinking_tokens separate from output_tokens.
    // Antigravity bills credits and reports no USD cost, so no cost path is configured.
    usage: { inputTokens: "usage.input_tokens", outputTokens: "usage.output_tokens" },
    versionArgv: ["--version"],
  },
  codex: {
    argv: ["codex", "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", "shell_environment_policy.inherit=core", "-"],
    output: { mode: "jsonl", path: "item.text", filter: { type: "item.completed", "item.type": ["agent_message", "assistant_message"] } },
    modelFlag: "-m", usage: { inputTokens: "usage.input_tokens", outputTokens: "usage.output_tokens" }, env: ["CODEX_HOME"], versionArgv: ["--version"],
  },
};
export function runtimeRegistry(overrides: unknown = readUserConfig().runtimes ?? {}): Record<string, RuntimeSpec> {
  const config = validateRuntimeConfig(overrides);
  const out: Record<string, RuntimeSpec> = Object.fromEntries(Object.entries(BUILTIN_RUNTIMES).map(([k, v]) => [k, structuredClone(v)]));
  for (const [name, spec] of Object.entries(config)) {
    const merged = { ...(Object.hasOwn(out, name) ? out[name] : {}), ...spec };
    validateRuntimeSpec(merged);
    out[name] = merged;
  }
  return out;
}
export function getRuntime(name: string): RuntimeSpec | undefined {
  const registry = runtimeRegistry();
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

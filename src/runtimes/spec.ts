import { isAbsolute, basename } from "node:path";
import { PROVIDER_IDS } from "../provider-ids.js";

export type UsagePath = string | string[];
export interface RuntimeUsage { inputTokens?: UsagePath; outputTokens?: UsagePath; costUsd?: UsagePath }
export type RuntimeOutput =
  | { mode: "text"; stripDecoration?: boolean }
  | { mode: "json"; path: string; status?: { path: string; success: string; errorPath?: string; deniedPath?: string } }
  | { mode: "jsonl"; path: string; filter: Record<string, string | string[]> };
export interface RuntimeSpec {
  argv: string[];
  output: RuntimeOutput;
  modelFlag?: string;
  usage?: RuntimeUsage;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  versionArgv?: string[];
  env?: string[];
  cwd?: string;
}
export const RUNTIME_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const RUNTIME_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const safeString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\0-\x1f\x7f]/.test(v);
const path = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(v) && !v.split(".").some(p => ["__proto__", "prototype", "constructor"].includes(p));
function argv(v: unknown, binary: boolean): v is string[] {
  return Array.isArray(v) && v.length >= (binary ? 1 : 0) && v.length <= 64 && v.every(safeString)
    && (!binary || !/^(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|cmd|powershell|pwsh)(?:\.exe)?$/i.test(basename(v[0])))
    && (!binary || (isAbsolute(v[0]) || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v[0])))
    && v.every((s, i) => !s.includes("{prompt}") || (binary && i > 0 && s === "{prompt}"))
    && v.filter(s => s === "{prompt}").length <= 1;
}
/** Reject unknown fields too: configuration can never opt into a shell. */
export function validateRuntimeSpec(value: unknown, partial = false): asserts value is RuntimeSpec {
  if (!record(value) || !keys(value, ["argv", "output", "modelFlag", "usage", "timeoutMs", "stdoutMaxBytes", "stderrMaxBytes", "versionArgv", "env", "cwd"])) throw new Error("Invalid runtime spec fields.");
  if ((!partial || value.argv !== undefined) && !argv(value.argv, true)) throw new Error("Invalid runtime argv; use a binary and separate arguments.");
  if (value.output !== undefined || !partial) {
    const o = value.output;
    if (!record(o) || !keys(o, ["mode", "path", "filter", "stripDecoration", "status"]) || !["text", "json", "jsonl"].includes(String(o.mode))) throw new Error("Invalid runtime output.");
    if (o.status !== undefined && (o.mode !== "json" || !record(o.status) || !keys(o.status, ["path", "success", "errorPath", "deniedPath"]) || !path(o.status.path) || !safeString(o.status.success) || (o.status.errorPath !== undefined && !path(o.status.errorPath)) || (o.status.deniedPath !== undefined && !path(o.status.deniedPath)))) throw new Error("Invalid runtime output status.");
    if (o.mode === "text" ? (o.path !== undefined || o.filter !== undefined || (o.stripDecoration !== undefined && typeof o.stripDecoration !== "boolean")) : (!path(o.path) || o.stripDecoration !== undefined)) throw new Error("Invalid runtime output path.");
    if (o.mode === "json" && o.filter !== undefined) throw new Error("Invalid runtime output filter.");
    if (o.mode === "jsonl" && (!record(o.filter) || !Object.keys(o.filter).length || Object.keys(o.filter).length > 8 || Object.entries(o.filter).some(([k, v]) => !path(k) || !(safeString(v) || (Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every(safeString)))))) throw new Error("Invalid runtime event filter.");
  }
  if (value.modelFlag !== undefined && (typeof value.modelFlag !== "string" || !/^--?[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(value.modelFlag))) throw new Error("Invalid runtime model flag.");
  if (value.usage !== undefined && (!record(value.usage) || !keys(value.usage, ["inputTokens", "outputTokens", "costUsd"]) || Object.values(value.usage).some(v => {
    const paths = Array.isArray(v) ? v : [v];
    return !paths.length || paths.length > 8 || paths.some(p => typeof p !== "string" || p.length > 256 || !p.split(".").every(part => part === "*" || path(part)));
  }))) throw new Error("Invalid runtime usage paths.");
  for (const [k, max] of [["timeoutMs", 3_600_000], ["stdoutMaxBytes", 16_777_216], ["stderrMaxBytes", 1_048_576]] as const) {
    if (value[k] !== undefined && (!Number.isSafeInteger(value[k]) || Number(value[k]) < 1 || Number(value[k]) > max)) throw new Error("Invalid runtime limit.");
  }
  if (value.versionArgv !== undefined && !argv(value.versionArgv, false)) throw new Error("Invalid runtime version arguments.");
  if (value.env !== undefined && (!Array.isArray(value.env) || value.env.length > 64 || value.env.some(v => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v)))) throw new Error("Invalid runtime environment names.");
  if (value.cwd !== undefined && (!safeString(value.cwd) || !isAbsolute(value.cwd))) throw new Error("Runtime cwd must be absolute.");
}
export function validateRuntimeConfig(value: unknown): Record<string, Partial<RuntimeSpec>> {
  if (!record(value) || Object.keys(value).length > 64) throw new Error("Invalid runtimes configuration.");
  for (const [name, spec] of Object.entries(value)) {
    if (!RUNTIME_NAME.test(name) || (PROVIDER_IDS as readonly string[]).includes(name)) throw new Error("Runtime name is invalid or shadows a provider.");
    const builtin = ["hermes", "openclaw", "gemini", "agy", "codex"].includes(name);
    if (builtin && record(spec) && !keys(spec, ["argv", "output", "timeoutMs", "stdoutMaxBytes", "stderrMaxBytes", "env"])) throw new Error("Built-in runtime overrides accept only argv, output, limits and env.");
    validateRuntimeSpec(spec, builtin);
  }
  return value as Record<string, Partial<RuntimeSpec>>;
}
/** Own properties only; numeric components naturally address array elements. */
export function runtimePath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => v !== null && typeof v === "object" && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined, value);
}

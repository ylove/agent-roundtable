// ============================================================================
// Private operator configuration and credential references
// ============================================================================

import { closeSync, fstatSync, openSync, readFileSync, statSync, constants, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import { PROVIDER_IDS, type LLMProvider } from "./provider-ids.js";
import { ensureStateHome } from "./security/fs-safe.js";

import { validateRuntimeConfig, type RuntimeSpec } from "./runtimes/spec.js";
import { validateConnectors, ENV_NAME, type ConnectorSpec } from "./connectors/config.js";
import { findExecutable, isExecutableFile } from "./executables.js";
import { childEnv } from "./security/child-env.js";
import { parseSecretRef } from "./secrets/ref.js";
import { resolveSecretSync } from "./secrets/broker.js";
import { secretReason } from "./secrets/backends.js";

import { validateNotifyConfig, type NotifyConfig } from "./serve/config.js";

export type RoutingTier = "builder" | "judge" | "balanced";
export interface RoutingModel { model: string; reasoning?: boolean; maxOutputTokens?: number }
export type RoutingConfig = Partial<Record<LLMProvider, Partial<Record<RoutingTier, RoutingModel>>>>;

/** Operator configuration only: no endpoints, credentials, health or price overrides. */
export function validateRoutingConfig(raw: unknown): RoutingConfig {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(raw)) throw new Error("Invalid routing configuration.");
  for (const [provider, tiers] of Object.entries(raw)) {
    if (!(PROVIDER_IDS as string[]).includes(provider) || !record(tiers)) throw new Error("Invalid routing provider.");
    for (const [tier, spec] of Object.entries(tiers)) {
      if (!["builder", "judge", "balanced"].includes(tier) || !record(spec) ||
          Object.keys(spec).some(k => !["model", "reasoning", "maxOutputTokens"].includes(k)) ||
          typeof spec.model !== "string" || !/^[\x21-\x7e]{1,200}$/.test(spec.model) ||
          (spec.reasoning !== undefined && typeof spec.reasoning !== "boolean") ||
          (spec.maxOutputTokens !== undefined && (typeof spec.maxOutputTokens !== "number" || !Number.isSafeInteger(spec.maxOutputTokens) || spec.maxOutputTokens < 1))) throw new Error("Invalid routing model.");
    }
  }
  return raw as RoutingConfig;
}

export interface UserConfig {
  notify?: NotifyConfig;
  routing?: RoutingConfig; envFile?: string; agentsDir?: string; runtimes?: Record<string, Partial<RuntimeSpec>>;
  secrets?: Record<string, string>; connectors?: Record<string, ConnectorSpec>;
}
type Environment = Record<string, string | undefined>;
const allowedKeys = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN"]);
// The endpoint and its key travel together, and only when the launcher set neither.
const endpointPair = ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"];
// Settings the package .env honours in addition to the pointed file's keys.
const packageKeys = new Set([
  "OLLAMA_URL", "ROUNDTABLE_AGENTS_DIR", "ROUNDTABLE_MAX_TOKENS", "ROUNDTABLE_LLM_TIMEOUT_MS", "ROUNDTABLE_PUBLISHER",
  "ROUNDTABLE_NTFY_URL", "ROUNDTABLE_PUBLIC_TOPIC_PREFIX", "ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS",
]);
export function allowedEnvKey(key: string): boolean {
  return allowedKeys.has(key) || key === "OPENAI_COMPATIBLE_API_KEY" || key === "OPENAI_COMPATIBLE_MODEL" || /^ROUNDTABLE_(?:ANTHROPIC|OPENAI|TOGETHER|REPLICATE|OLLAMA|EXECUTION)_MODEL$/.test(key);
}
/** Keys the pointed env file may set: the secret-bearing set plus the documented endpoint. */
function pointedEnvKey(key: string): boolean { return allowedEnvKey(key) || key === "OPENAI_COMPATIBLE_BASE_URL"; }
/** Keys an untracked package .env may set. */
function packageEnvKey(key: string): boolean { return pointedEnvKey(key) || packageKeys.has(key); }
export function userConfigHome(env: Environment = process.env): string {
  return env.ROUNDTABLE_HOME || join(homedir(), ".agent-roundtable");
}

/** Validate before opening (including FIFOs); diagnostics deliberately contain no paths. */
function readRegular(path: string, owned = false): { text: string; mode: number } {
  if (!isAbsolute(path)) throw new Error("The env file must be an absolute path to a regular file.");
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error();
    // Credentials and settings are read only from files that only their owner can change.
    if (owned && ((typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o022))) throw new Error("untrusted");
    return { text: readFileSync(fd, "utf8"), mode: st.mode };
  } catch {
    throw new Error("The env file must be an accessible regular file.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

const warnedSecrets = new Set<string>();
function secretNameAllowed(name: string, connectors: Record<string, ConnectorSpec>): boolean {
  return ENV_NAME.test(name) && (allowedEnvKey(name) || Object.values(connectors).some(c => Object.hasOwn(c.env, name)));
}
export function readUserConfig(home = userConfigHome(), warn: (message: string) => void = console.error): UserConfig {
  try {
    const data: unknown = JSON.parse(readRegular(join(home, "config.json"), true).text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    const config = data as Record<string, unknown>;
    for (const key of ["envFile", "agentsDir"]) {
      if (config[key] !== undefined && (typeof config[key] !== "string" || !isAbsolute(config[key] as string))) throw new Error();
    }
    const notify = config.notify === undefined ? undefined : validateNotifyConfig(config.notify);
    const routing = config.routing === undefined ? undefined : validateRoutingConfig(config.routing);
    const runtimes = config.runtimes === undefined ? undefined : validateRuntimeConfig(config.runtimes);
    const connectors = config.connectors === undefined ? undefined : validateConnectors(config.connectors);
    const secrets: Record<string, string> = {};
    if (config.secrets !== undefined) {
      if (!config.secrets || typeof config.secrets !== "object" || Array.isArray(config.secrets)) throw new Error();
      for (const [name, ref] of Object.entries(config.secrets)) {
        try {
          if (!secretNameAllowed(name, connectors ?? {})) throw new Error();
          parseSecretRef(ref);
          secrets[name] = ref as string;
        } catch {
          const safeName = ENV_NAME.test(name) ? name : "(invalid name)";
          const key = `${home}:${name}`;
          if (!warnedSecrets.has(key)) { warnedSecrets.add(key); warn(`${safeName}: invalid secret reference; ignored`); }
        }
      }
    }
    return { ...(notify && { notify }), ...(routing && { routing }), ...(runtimes && { runtimes }), ...(connectors && { connectors }), ...(config.secrets !== undefined && { secrets }), ...(typeof config.envFile === "string" && { envFile: config.envFile }), ...(typeof config.agentsDir === "string" && { agentsDir: config.agentsDir }) };
  } catch {
    try { statSync(join(home, "config.json")); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    }
    throw new Error("Unable to read user configuration.");
  }
}

export function setUserConfig(key: "envFile" | "agentsDir", path: string, home = userConfigHome()): void {
  if (!isAbsolute(path)) throw new Error("Configuration requires an absolute path.");
  if (key === "envFile") readRegular(path);
  else {
    try { if (!statSync(path).isDirectory()) throw new Error(); }
    catch { throw new Error("The agents directory must be an accessible directory."); }
  }
  const config = { ...readUserConfig(home), [key]: path };
  saveUserConfig(config, home);
}

function saveUserConfig(config: UserConfig, home: string): void {
  const temp = join(home, `.config-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    ensureStateHome(home);
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, join(home, "config.json"));
  } catch { throw new Error("Unable to save user configuration."); }
  finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the path-free diagnostic. */ } }
}

export function setSecretConfig(name: string, ref: string, home = userConfigHome()): void {
  const config = readUserConfig(home);
  if (!secretNameAllowed(name, config.connectors ?? {})) throw new Error("Secret name must be an allowed provider variable or a connector environment name.");
  parseSecretRef(ref);
  saveUserConfig({ ...config, secrets: { ...config.secrets, [name]: ref } }, home);
}
export function setConnectorConfig(name: string, spec: ConnectorSpec, home = userConfigHome()): void {
  validateConnectors({ [name]: spec });
  if (!isExecutableFile(spec.command)) throw new Error(`Connector ${name} is unavailable.`);
  const config = readUserConfig(home);
  saveUserConfig({ ...config, connectors: { ...config.connectors, [name]: spec } }, home);
}
export function unsetConfigEntry(kind: "secrets" | "connectors", name: string, home = userConfigHome()): void {
  const config = readUserConfig(home);
  const entries: Record<string, string | ConnectorSpec> = { ...config[kind] };
  delete entries[name];
  saveUserConfig({ ...config, [kind]: entries }, home);
}

let warnedTrackedPackageEnv = false;

/** Whether git tracks the package env file; false when git or the repository is unavailable. */
function packageEnvTracked(file: string, source: Environment): boolean {
  const env = childEnv("git", {}, source);
  const git = findExecutable("git", env.PATH);
  if (!git) return false;
  try {
    execFileSync(git, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", "--error-unmatch", "--", basename(file)], {
      cwd: dirname(file), env, timeout: 2000, maxBuffer: 4096, stdio: "ignore",
    });
    return true;
  } catch { return false; }
}

/** Preserve shell values; each env file fills only its own allowed keys. */
export function loadUserEnvironment(options: {
  env?: Environment; home?: string; packageEnvFile?: string; warn?: (message: string) => void;
} = {}): void {
  const env = options.env ?? process.env;
  const shell = { ...env };
  const referenced = new Set<string>();
  const warn = options.warn ?? ((message: string) => console.error(message));
  const enabled = (env.ROUNDTABLE_DOTENV ?? "").trim().toLowerCase() !== "off";
  const apply = (data: Record<string, string>, allowed: (key: string) => boolean) => {
    const pairFree = endpointPair.every(key => shell[key] === undefined && (env[key] === undefined || referenced.has(key)));
    for (const [key, value] of Object.entries(data)) {
      if (!allowed(key) || referenced.has(key)) continue;
      if (endpointPair.includes(key)) { if (pairFree) env[key] = value; continue; }
      if (env[key] === undefined) env[key] = value;
    }
  };
  if (enabled && options.packageEnvFile) {
    try {
      const file = readRegular(options.packageEnvFile, true);
      if (packageEnvTracked(options.packageEnvFile, env)) {
        // A tracked file can change with a checkout, so it supplies nothing.
        if (!warnedTrackedPackageEnv) {
          warnedTrackedPackageEnv = true;
          warn("The package env file is tracked by git and was ignored; keep settings in an untracked private file.");
        }
      } else apply(parse(file.text), packageEnvKey);
    }
    catch { /* The package .env is optional. */ }
  }
  let config: UserConfig = {};
  try { config = readUserConfig(options.home ?? userConfigHome(env), warn); }
  catch { warn("Unable to read user configuration."); }
  if (env.ROUNDTABLE_AGENTS_DIR === undefined && config.agentsDir) env.ROUNDTABLE_AGENTS_DIR = config.agentsDir;
  if ((env.ROUNDTABLE_SECRETS ?? "").trim().toLowerCase() !== "off") {
    const deadline = Date.now() + 20_000;
    for (const [name, ref] of Object.entries(config.secrets ?? {})) {
      if (!allowedEnvKey(name)) continue;
      referenced.add(name);
      if (shell[name] !== undefined) { env[name] = shell[name]; continue; }
      delete env[name];
      try { env[name] = resolveSecretSync(ref, deadline - Date.now(), env); }
      catch (e) { warn(`${name}: secret unavailable (${secretReason(e)})`); }
    }
  }
  if (!enabled) return;
  const envFile = env.ROUNDTABLE_ENV_FILE ?? config.envFile;
  if (envFile !== undefined) {
    try {
      const file = readRegular(envFile, true);
      if (file.mode & 0o044) warn("The configured env file allows group or world read; restrict its permissions to 0600.");
      apply(parse(file.text), pointedEnvKey);
    } catch { warn("Unable to load the configured env file; it must be an absolute path to a regular file that you own and that others cannot modify."); }
  }
}

/** Allowlisted dotted check-in keys; credentials are references only. */
export function setNotifyConfig(key: string, value: string, home = userConfigHome()): void {
  const parts = key.split(".");
  const config = readUserConfig(home);
  const notify = structuredClone(config.notify ?? {}) as Record<string, unknown>;
  if (parts[0] !== "notify") throw new Error("Invalid notify key.");
  if (parts.length === 2 && parts[1] === "desktop") {
    if (!["true", "false"].includes(value)) throw new Error("notify.desktop must be true or false.");
    notify.desktop = value === "true";
  } else if (parts.length === 2 && parts[1] === "events") {
    notify.events = value.startsWith("[") ? JSON.parse(value) : value.split(",").filter(Boolean);
  } else if (parts.length === 3 && ["ntfy", "webhook"].includes(parts[1])) {
    notify[parts[1]] = { ...(notify[parts[1]] as object), [parts[2]]: value };
  } else throw new Error("Invalid notify key.");
  saveUserConfig({ ...config, notify: validateNotifyConfig(notify) }, home);
}

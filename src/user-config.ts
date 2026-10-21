import { closeSync, fstatSync, openSync, readFileSync, statSync, constants, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "dotenv";

import { validateRuntimeConfig, type RuntimeSpec } from "./runtimes/spec.js";

export interface UserConfig { envFile?: string; agentsDir?: string; runtimes?: Record<string, Partial<RuntimeSpec>> }
type Environment = Record<string, string | undefined>;
const allowedKeys = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN"]);
export function allowedEnvKey(key: string): boolean {
  return allowedKeys.has(key) || /^OPENAI_COMPATIBLE_\w+$/.test(key) || /^ROUNDTABLE_\w+_MODEL$/.test(key);
}
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

export function readUserConfig(home = userConfigHome()): UserConfig {
  try {
    const data: unknown = JSON.parse(readRegular(join(home, "config.json"), true).text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    const config = data as Record<string, unknown>;
    for (const key of ["envFile", "agentsDir"]) {
      if (config[key] !== undefined && (typeof config[key] !== "string" || !isAbsolute(config[key] as string))) throw new Error();
    }
    const runtimes = config.runtimes === undefined ? undefined : validateRuntimeConfig(config.runtimes);
    return { ...(runtimes && { runtimes }), ...(typeof config.envFile === "string" && { envFile: config.envFile }), ...(typeof config.agentsDir === "string" && { agentsDir: config.agentsDir }) };
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
  const temp = join(home, `.config-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, join(home, "config.json"));
  } catch { throw new Error("Unable to save user configuration."); }
  finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the path-free diagnostic. */ } }
}

/** Keep package overrides for compatibility; the pointed file fills only allowed gaps. */
export function loadUserEnvironment(options: {
  env?: Environment; home?: string; packageEnvFile?: string; warn?: (message: string) => void;
} = {}): void {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const enabled = (env.ROUNDTABLE_DOTENV ?? "").trim().toLowerCase() !== "off";
  const apply = (data: Record<string, string>, filtered: boolean, override = false) => {
    // The endpoint and its key travel together, and only when the shell set neither.
    const pair = ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"];
    const pairFree = pair.every(key => env[key] === undefined);
    for (const [key, value] of Object.entries(data)) {
      if (filtered && pair.includes(key)) { if (pairFree && allowedEnvKey(key)) env[key] = value; continue; }
      if ((!filtered || allowedEnvKey(key)) && (override || env[key] === undefined)) env[key] = value;
    }
  };
  if (enabled && options.packageEnvFile) {
    try { apply(parse(readRegular(options.packageEnvFile).text), false, true); }
    catch { /* The package .env is optional. */ }
  }
  let config: UserConfig = {};
  try { config = readUserConfig(options.home ?? userConfigHome(env)); }
  catch { warn("Unable to read user configuration."); }
  if (env.ROUNDTABLE_AGENTS_DIR === undefined && config.agentsDir) env.ROUNDTABLE_AGENTS_DIR = config.agentsDir;
  if (!enabled) return;
  const envFile = env.ROUNDTABLE_ENV_FILE ?? config.envFile;
  if (envFile !== undefined) {
    try {
      const file = readRegular(envFile, true);
      if (file.mode & 0o044) warn("The configured env file allows group or world read; restrict its permissions to 0600.");
      apply(parse(file.text), true);
    } catch { warn("Unable to load the configured env file; it must be an absolute path to a regular file that you own and that others cannot modify."); }
  }
}

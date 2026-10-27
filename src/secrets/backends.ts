import { execFile, execFileSync } from "node:child_process";
import { findExecutable } from "../executables.js";
import { childEnv } from "../security/child-env.js";

export interface SecretOptions { signal?: AbortSignal; timeoutMs: number }
export interface SecretBackend {
  id: string;
  resolve(locator: string, options: SecretOptions): Promise<string>;
}

const registry = new Map<string, SecretBackend>();
export function registerSecretBackend(backend: SecretBackend): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(backend.id)) throw new Error("Invalid secret backend id.");
  registry.set(backend.id, backend);
}
export function secretBackend(id: string): SecretBackend {
  const backend = registry.get(id);
  if (!backend) throw new Error("not supported");
  return backend;
}
export function secretTimeout(id: string): number { return id === "op" ? 30_000 : 10_000; }

/** Only these locally generated reasons may leave the broker. */
export function secretReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return ["not found", "locked or denied", "timed out", "empty result", "output too large", "op not installed", "keychain CLI not installed", "not supported"].includes(message) ? message : "locked or denied";
}

function result(value: string, trim = true): string {
  const text = trim ? value.replace(/\r?\n$/, "") : value;
  if (!text) throw new Error("empty result");
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("output too large");
  return text;
}
function failure(error: unknown, lookup = false): Error {
  const e = error as { code?: string | number; killed?: boolean; signal?: string; stderr?: string | Buffer; name?: string };
  if (e.code === "ETIMEDOUT" || e.killed || e.name === "AbortError" || e.signal === "SIGTERM") return new Error("timed out");
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.code === "ENOBUFS") return new Error("output too large");
  if (e.code === 44 || /not found|could not be found|does not exist|no matching/i.test(String(e.stderr ?? ""))) return new Error("not found");
  if (lookup && e.code === 1 && !String(e.stderr ?? "").trim()) return new Error("not found");
  return new Error("locked or denied");
}
function command(id: string, locator: string, source: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const [service, account] = locator.split("/");
  if (id === "keychain" && platform !== "darwin" && platform !== "linux") throw new Error("not supported");
  const name = id === "op" ? "op" : platform === "darwin" ? "security" : "secret-tool";
  const file = findExecutable(name, source.PATH ?? "");
  if (!file) throw new Error(id === "op" ? "op not installed" : "keychain CLI not installed");
  const args = id === "op" ? ["read", "--no-newline", `op://${locator}`]
    : platform === "darwin" ? ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"]
    : ["lookup", "service", service, ...(account ? ["account", account] : [])];
  return { file, args, env: childEnv("secret-cli", {}, source) };
}

export function resolveBuiltinSync(id: string, locator: string, options: SecretOptions, source = process.env, platform = process.platform): string {
  options.signal?.throwIfAborted();
  if (id === "env") {
    if (source[locator] === undefined) throw new Error("not found");
    return result(source[locator]!, false);
  }
  const c = command(id, locator, source, platform);
  try { return result(execFileSync(c.file, c.args, { env: c.env, shell: false, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { if (e instanceof Error && ["empty result", "output too large"].includes(e.message)) throw e; throw failure(e, id === "keychain" && platform === "linux"); }
}

/** Exported for platform tests; production backends use the host platform. */
export async function resolveBuiltin(id: string, locator: string, options: SecretOptions, source = process.env, platform = process.platform): Promise<string> {
  options.signal?.throwIfAborted();
  if (id === "env") {
    if (source[locator] === undefined) throw new Error("not found");
    return result(source[locator]!, false);
  }
  const c = command(id, locator, source, platform);
  return new Promise((resolve, reject) => {
    execFile(c.file, c.args, { env: c.env, shell: false, signal: options.signal, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(failure({ ...error, name: error.name, stderr }, id === "keychain" && platform === "linux")); return; }
      try { resolve(result(stdout)); } catch (e) { reject(e); }
    });
  });
}

for (const id of ["env", "keychain", "op"]) registerSecretBackend({ id, resolve: (locator, options) => resolveBuiltin(id, locator, options) });

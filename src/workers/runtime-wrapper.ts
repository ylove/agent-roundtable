// ============================================================================
// The runtime worker wrapper (started by the output relay in the task worktree; see runtime.ts)
//
// Reads the prompt from stdin, runs the runtime profile's command with the environment the driver
// built (minus every ROUNDTABLE_* name: the runtime never sees the roundtable's own settings), and
// writes JSON lines for the monitor on stdout (the relay scrubs them into runs/<attempt>.jsonl):
//   roundtable.runtime.output     one line of the runtime's stdout or stderr, wrapped so it can never
//                                 be mistaken for a result
//   roundtable.runtime.heartbeat  while the runtime is alive (it may print nothing until it ends)
//   roundtable.runtime.result     once: ok, final text, usage (estimated from text lengths when the
//                                 runtime reports none), cost
// In submit "driver" mode it first consumes the worker's single-use token (so the runtime can never
// read it) and, when the runtime exits 0, calls submit_work with the final text as the summary.
// A stop (SIGTERM) is forwarded to the runtime and nothing is submitted.
// ============================================================================

import { installHttpStack } from "../http/fetch.js";
import { spawn, type ChildProcess } from "node:child_process";
import { parseRuntimeOutput } from "../runtimes/runner.js";
import { argvPrompt } from "../runtimes/spec.js";
import { scrubAndCap } from "../security/secrets.js";
import { SUBMIT_WORK } from "../tools/names.js";
import { bindWorkerIdentity, handleWorkerTool } from "../tools/worker.js";
import { estimateTokens, LINE_HEARTBEAT, LINE_OUTPUT, LINE_RESULT, type RuntimeResultLine, type RuntimeWrapperConfig } from "./runtime.js";
import { consumeWorkerToken } from "./token.js";

const MAX_ARG_BYTES = 100 * 1024;
const MAX_ARGV_BYTES = 128 * 1024;
const OUTPUT_LINE_MAX = 4000;
/** Wrapped output lines per run; the full stdout is still captured for parsing. */
const OUTPUT_BYTES_MAX = 2 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;
const HEARTBEAT_MS = 60_000;
const SUMMARY_MAX = 1500;

installHttpStack();
process.umask(0o077);

const emit = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");

/** The runtime's environment: the wrapper's own, without the roundtable's settings. */
function runtimeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === "string" && !k.startsWith("ROUNDTABLE_")) env[k] = v;
  return env;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => { text += c; });
    process.stdin.on("end", () => resolve(text));
  });
}

function finish(result: Omit<RuntimeResultLine, "type">, code: number): void {
  process.stdout.write(JSON.stringify({ type: LINE_RESULT, ...result }) + "\n", () => process.exit(code));
}

const failure = (message: string, usage: RuntimeResultLine["usage"]): Omit<RuntimeResultLine, "type"> =>
  ({ ok: false, text: scrubAndCap(message, 2000), usage, usage_estimated: true });

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "") as RuntimeWrapperConfig;
  if (config?.v !== 1 || typeof config.binary !== "string" || !Array.isArray(config.args)) throw new Error("bad runtime wrapper configuration");
  const prompt = await readStdin();
  const promptTokens = estimateTokens(prompt.length);
  let stopping = false;
  let child: ChildProcess | undefined;
  const onStop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);

  if (config.submit === "driver") {
    try {
      const id = await consumeWorkerToken({ execution: config.execution, agent: config.agent, tokenFile: config.tokenFile });
      bindWorkerIdentity({ store: id.store, execution: id.execution, agent: id.agent, tokenSha256: id.record.token_sha256 });
    } catch (e) {
      return finish(failure(`The worker could not start: ${e instanceof Error ? e.message : String(e)}`, { inputTokens: 0, outputTokens: 0 }), 1);
    }
  }
  if (stopping) return finish(failure("stopped before the runtime started", { inputTokens: 0, outputTokens: 0 }), 1);

  const onArgv = config.args.includes("{prompt}");
  const args = config.args.map((a) => (a === "{prompt}" ? argvPrompt(prompt) : a));
  const sizes = [config.binary, ...args].map((a) => Buffer.byteLength(a));
  if (sizes.some((n) => n > MAX_ARG_BYTES) || sizes.reduce((s, n) => s + n + 1, 0) > MAX_ARGV_BYTES) {
    return finish(failure(`${config.runtime}: the task prompt is too large for this profile's argv (100 KiB per argument); use a profile that reads the prompt on stdin`, { inputTokens: promptTokens, outputTokens: 0 }), 1);
  }

  const spec = { argv: [config.binary], output: config.output, ...(config.usage && { usage: config.usage }) };
  let stdout = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let wrapped = 0;
  let overflow = false;
  const lines = { stdout: "", stderr: "" };
  const relayLine = (stream: "stdout" | "stderr", text: string) => {
    if (!text.trim() || wrapped > OUTPUT_BYTES_MAX) return;
    const line = text.length > OUTPUT_LINE_MAX ? text.slice(0, OUTPUT_LINE_MAX) + "…" : text;
    wrapped += line.length;
    emit({ type: LINE_OUTPUT, stream, text: line });
  };
  const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
    lines[stream] += chunk.toString("utf8");
    const parts = lines[stream].split("\n");
    lines[stream] = parts.pop() ?? "";
    if (lines[stream].length > OUTPUT_LINE_MAX * 4) { relayLine(stream, lines[stream]); lines[stream] = ""; }
    for (const p of parts) relayLine(stream, p);
  };

  const proc = spawn(config.binary, args, { cwd: process.cwd(), env: runtimeEnv(process.env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child = proc;
  const heartbeat = setInterval(() => emit({ type: LINE_HEARTBEAT }), HEARTBEAT_MS);
  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (config.output.mode === "text") stdout = Buffer.concat([stdout, chunk]).subarray(-config.stdoutMaxBytes);
    else if (stdout.length < config.stdoutMaxBytes) stdout = Buffer.concat([stdout, chunk.subarray(0, config.stdoutMaxBytes - stdout.length)]);
    if (stdoutBytes > config.stdoutMaxBytes && config.output.mode !== "text" && !overflow) {
      overflow = true;
      proc.kill("SIGTERM");
    }
    feed("stdout", chunk);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_TAIL);
    feed("stderr", chunk);
  });
  proc.stdin.on("error", () => { /* the runtime may exit before reading its prompt; its exit says why */ });
  proc.stdin.end(onArgv ? undefined : prompt);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal }));
  }).catch((e: Error) => ({ code: null as number | null, signal: null as NodeJS.Signals | null, error: e.message }));
  clearInterval(heartbeat);
  for (const s of ["stdout", "stderr"] as const) relayLine(s, lines[s]);

  const raw = stdout.toString("utf8");
  const estimatedUsage = (text: string) => ({ inputTokens: promptTokens, outputTokens: estimateTokens(text.length || raw.length) });
  if ("error" in exit) return finish(failure(`${config.runtime} could not start: ${exit.error}`, estimatedUsage("")), 1);
  if (stopping || exit.signal) return finish(failure(stopping ? "stopped" : `killed by ${exit.signal}`, estimatedUsage("")), exit.code ?? 1);
  if (overflow) return finish(failure(`${config.runtime}: stdout exceeded the ${config.stdoutMaxBytes} byte cap`, estimatedUsage("")), 1);
  if (exit.code !== 0) {
    const tail = [`${config.runtime} exited with ${exit.code}`, config.output.mode === "text" ? raw.trim().slice(-1500) : "", stderr.toString("utf8").trim().slice(-1500)].filter(Boolean).join("\n");
    return finish(failure(tail, estimatedUsage("")), exit.code ?? 1);
  }

  // Exit 0: the final text, usage and cost from the profile's output mode.
  let text = "";
  let usage: RuntimeResultLine["usage"] | undefined;
  let costUsd: number | undefined;
  try {
    const parsed = parseRuntimeOutput(spec, raw, process.env, true);
    ({ text, usage } = parsed);
    costUsd = parsed.costUsd;
  } catch (error) {
    // Profiles with a result status must not submit a failed/empty result even when the CLI exits 0.
    if (config.output.mode === "json" && config.output.status) {
      return finish(failure(error instanceof Error ? error.message : "Runtime returned invalid output", estimatedUsage("")), 1);
    }
    /* no parseable final text: the run still ended cleanly */
  }
  const result: Omit<RuntimeResultLine, "type"> = {
    ok: true,
    text: scrubAndCap(text, OUTPUT_LINE_MAX),
    usage: usage ?? estimatedUsage(text),
    usage_estimated: usage === undefined,
    ...(costUsd !== undefined && { cost_usd: costUsd }),
    ...(config.model && { model: config.model }),
  };
  if (config.submit !== "driver") return finish(result, 0);

  const summary = scrubAndCap(text.trim(), SUMMARY_MAX) || `Work by runtime ${config.runtime}.`;
  try {
    const r = await handleWorkerTool(SUBMIT_WORK, { summary, ready: true }, { mode: "worker" });
    const body = r.content[0]?.type === "text" ? r.content[0].text : "";
    if (r.isError) return finish({ ...result, ok: false, text: scrubAndCap(`submit_work failed: ${body}`, OUTPUT_LINE_MAX), submitted: false }, 1);
    return finish({ ...result, submitted: true }, 0);
  } catch (e) {
    return finish({ ...result, ok: false, text: scrubAndCap(`submit_work failed: ${e instanceof Error ? e.message : String(e)}`, OUTPUT_LINE_MAX), submitted: false }, 1);
  }
}

main().catch((e) => finish(failure(`runtime wrapper: ${e instanceof Error ? e.message : String(e)}`, { inputTokens: 0, outputTokens: 0 }), 1));

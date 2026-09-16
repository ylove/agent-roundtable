// Minimal stdio JSON-RPC client for exercising dist/index.js in tests (no framework).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function startServer({ env = {}, timeoutMs = 120_000 } = {}) {
  const child = spawn(process.execPath, [resolve(here, "../dist/index.js")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const stderr = [];
  const noise = []; // stdout lines that are not JSON-RPC: any such line is a protocol violation

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        noise.push(line); // recorded so the smoke test can assert stdout is JSON-only
      }
    }
  });
  child.stderr.on("data", (d) => stderr.push(String(d)));

  function request(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = nextId++;
      pending.set(id, resolvePromise);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
        }
      }, timeoutMs).unref();
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async function init() {
    const r = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-roundtable-test", version: "0" },
    });
    if (r.error) throw new Error(`initialize failed: ${r.error.message}`);
    notify("notifications/initialized");
    return r.result;
  }

  async function listTools() {
    const r = await request("tools/list");
    if (r.error) throw new Error(r.error.message);
    return r.result.tools;
  }

  /** Returns { text, isError } — the tool's first text block and its error flag. */
  async function callTool(name, args = {}) {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = (r.result.content || []).map((c) => c.text ?? "").join("\n");
    return { text, isError: Boolean(r.result.isError), raw: r.result };
  }

  return {
    init,
    listTools,
    callTool,
    stderr: () => stderr.join(""),
    noise: () => noise.slice(),
    stop: () => child.kill(),
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

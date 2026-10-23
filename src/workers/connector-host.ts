// MCP clients merge server env into their own. Strip that inherited environment before exec.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { childEnv } from "../security/child-env.js";

const [rawNames, command, ...args] = process.argv.slice(2);
const names: unknown = JSON.parse(rawNames);
if (!Array.isArray(names) || names.some(n => typeof n !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n)) || !isAbsolute(command)) throw new Error("Invalid connector launch.");
const extra = Object.fromEntries(names.map(n => [n, process.env[n]]));
const child = spawn(command, args, { env: childEnv("connector", extra), shell: false, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.once("error", () => { console.error("Connector unavailable."); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });

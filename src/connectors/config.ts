import { isAbsolute, basename } from "node:path";
import { SECRET_NAME_RE } from "../security/secrets.js";
import { parseSecretRef } from "../secrets/ref.js";

export interface ConnectorSpec { command: string; args: string[]; env: Record<string, string> }
export const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateConnectors(raw: unknown): Record<string, ConnectorSpec> {
  if (!record(raw)) throw new Error("Invalid connectors configuration.");
  for (const [name, spec] of Object.entries(raw)) {
    if (!CONNECTOR_NAME.test(name) || name === "roundtable") throw new Error("Invalid connector name.");
    if (!record(spec) || Object.keys(spec).some(k => !["command", "args", "env"].includes(k))) throw new Error("Invalid connector fields.");
    if (typeof spec.command !== "string" || !isAbsolute(spec.command) || /[\0-\x1f\x7f]/.test(spec.command)
      || /^(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|cmd|powershell|pwsh)(?:\.exe)?$/i.test(basename(spec.command))) throw new Error("Connector command must be an absolute executable path.");
    if (!Array.isArray(spec.args) || spec.args.length > 16 || spec.args.some(v => typeof v !== "string" || Buffer.byteLength(v) > 4096 || /[\0-\x1f\x7f]/.test(v))) throw new Error("Invalid connector arguments.");
    if (!record(spec.env) || Object.keys(spec.env).length > 32) throw new Error("Invalid connector environment.");
    for (const [key, value] of Object.entries(spec.env)) {
      if (!ENV_NAME.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid connector environment.");
      if (value.startsWith("secret://")) parseSecretRef(value);
      else if (SECRET_NAME_RE.test(key)) throw new Error("Connector credentials require a secret:// reference.");
    }
  }
  return raw as Record<string, ConnectorSpec>;
}

// ============================================================================
// Canonical JSON and hash chaining (event log and audit log)
// ============================================================================

import { createHash } from "node:crypto";
import type { EventEnvelope } from "./types.js";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively (UTF-16 order), no whitespace. Undefined
 * object values are omitted, as JSON.stringify does. Rejects non-finite numbers, undefined array
 * items, cycles and anything that is not a plain object, array, string, finite number, boolean
 * or null, so the result always parses back to a value with the same canonical form.
 */
export function canonicalJSON(value: unknown): string {
  return encode(value, new Set(), "$");
}

function encode(v: unknown, seen: Set<object>, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJSON: ${path} is not a finite number`);
      return JSON.stringify(v);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJSON: ${path} has unsupported type ${typeof v}`);
  }
  const obj = v as object;
  if (seen.has(obj)) throw new TypeError(`canonicalJSON: ${path} is cyclic`);
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    out = "[" + obj.map((item, i) => {
      if (item === undefined) throw new TypeError(`canonicalJSON: ${path}[${i}] is undefined`);
      return encode(item, seen, `${path}[${i}]`);
    }).join(",") + "]";
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJSON: ${path} is not a plain object`);
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      if (rec[key] === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + encode(rec[key], seen, `${path}.${key}`));
    }
    out = "{" + parts.join(",") + "}";
  }
  seen.delete(obj);
  return out;
}

/** sha256 hex of prev + canonicalJSON(record without its `hash` field). */
export function chainHash(prevHash: string, record: object): string {
  const { hash: _ignored, ...rest } = record as Record<string, unknown>;
  return sha256Hex(prevHash + canonicalJSON(rest));
}

/** The event hash: sha256(prev + canonicalJSON(envelope without hash)), lowercase hex. */
export function hashEvent(prevHash: string, envelope: Omit<EventEnvelope, "hash"> | EventEnvelope): string {
  return chainHash(prevHash, envelope);
}

// ============================================================================
// Content-addressed blobs: <blobsDir>/sha256/<2-char prefix>/<hex>, files 0600, written atomically
//
// Diffs, command output, huddle turns, prompts and contracts. Text is scrubbed of secrets before
// it is hashed, so the ref names the redacted content and the raw secret never touches disk.
// ============================================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir, mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { redactSecretTokens } from "../security/redaction-rules.js";
import { scrub, scrubConfiguredSecrets } from "../security/secrets.js";
import { canonicalJSON, sha256Hex } from "./chain.js";
import { preview } from "./events.js";

const REF_RE = /^sha256:([0-9a-f]{64})$/;

/** The hex digest of a "sha256:<hex>" ref; throws on anything else. */
export function blobHex(ref: string): string {
  const m = typeof ref === "string" ? REF_RE.exec(ref) : null;
  if (!m) throw new Error(`Not a blob ref: ${preview(ref, 80)} (expected "sha256:<64 hex>")`);
  return m[1];
}

/** mkdir with mode 0700, fsyncing the parent when the directory is new (so a stored blob survives power loss). */
function ensureDir(dir: string): void {
  if (existsSync(dir)) return mkdirPrivate(dir);
  mkdirPrivate(dir);
  fsyncDir(dirname(dir));
}

export function blobPath(blobsDir: string, ref: string): string {
  const hex = blobHex(ref);
  return join(blobsDir, "sha256", hex.slice(0, 2), hex);
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Store content and return its "sha256:<hex>" ref. With redact (the default) the content is
 * scrubbed first; a Buffer must then be valid UTF-8, since binary data cannot be scrubbed (store
 * it with { redact: false }). Storing the same content twice is a no-op.
 */
export function putBlob(blobsDir: string, content: string | Buffer, opts: { redact?: boolean } = {}): string {
  const redact = opts.redact !== false;
  let buf: Buffer;
  if (typeof content === "string") {
    buf = Buffer.from(redact ? scrub(content) : content, "utf8");
  } else if (!Buffer.isBuffer(content)) {
    throw new TypeError("putBlob: content must be a string or a Buffer");
  } else if (!redact) {
    buf = content;
  } else {
    let text: string;
    try {
      text = utf8.decode(content);
    } catch {
      throw new Error("putBlob: binary content cannot be scrubbed of secrets; pass { redact: false } for non-text data");
    }
    buf = Buffer.from(scrub(text), "utf8");
  }
  const ref = `sha256:${sha256Hex(buf)}`;
  const path = blobPath(blobsDir, ref);
  try {
    // Already stored, unless a damaged copy sits there: same size is not enough, the hash must match.
    if (statSync(path).size === buf.length && sha256Hex(readFileSync(path)) === blobHex(ref)) return ref;
  } catch {
    /* not stored yet */
  }
  if (!existsSync(blobsDir)) throw new Error(`Blob directory ${blobsDir} does not exist`); // never recreate a purged execution
  ensureDir(join(blobsDir, "sha256"));
  ensureDir(dirname(path));
  writeFileAtomic(path, buf); // fsyncs the file and its directory
  return ref;
}

/** Read a blob and check its hash. Throws when it is missing or its content does not match the ref. */
export function getBlob(blobsDir: string, ref: string): Buffer {
  const path = blobPath(blobsDir, ref);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Blob ${ref} not found`);
    throw e;
  }
  if (`sha256:${sha256Hex(buf)}` !== ref) throw new Error(`Blob ${ref} is corrupt: its content does not match its hash`);
  return buf;
}

function credentialField(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /(?:^|_)(?:password|passwd|secret|token|api_?key|access_key|private_key|authorization|credentials?|client_secret|bearer)(?:_|$)/.test(normalized);
}

/** Scrub token-shaped keys and credential leaves, preserving identifier maps and structure. */
export function scrubDeep<T>(value: T, key?: string): T {
  if ((typeof value === "string" || typeof value === "number") && key !== undefined && credentialField(key)) return "[redacted:secret]" as T;
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, key)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [
      redactSecretTokens(scrubConfiguredSecrets(k).text).text, scrubDeep(v, k),
    ]));
    return out as T;
  }
  return value;
}

/**
 * Canonical JSON with every string scrubbed: the way to blob structured data such as a contract.
 * Store it with { redact: false }, because scrubbing serialized JSON as text can break its syntax
 * (a "…token…": 1234 pair would lose its number).
 */
export function scrubbedJSON(value: unknown): string {
  return canonicalJSON(scrubDeep(value));
}

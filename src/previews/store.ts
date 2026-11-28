// ============================================================================
// Preview records: one private JSON file per running preview
//
// ROUNDTABLE_HOME/previews/<id>.json, written atomically. Every process (the CLI, the MCP server,
// serve, the dashboard) reads the same files, so the pages can embed what another process started.
// A file is only trusted when its shape is exactly what startPreview writes: ids, origins and labels
// are checked on read because they end up in a CSP and in HTML.
// ============================================================================

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { ensureStateHome, mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { PREVIEW_ID_RE } from "./args.js";

export interface PreviewSource {
  kind: "task" | "prototype";
  execution?: string;
  task?: string;
  /** The prototype directory's name (never its path). */
  prototype?: string;
  /** The duel the prototype belongs to, as its session directory spells the duel id. */
  duel?: string;
}

export interface PreviewCheckRecord {
  loaded: boolean;
  consoleErrors: string[];
  exceptions: string[];
  failedRequests: number;
  reason?: string;
}

export interface PreviewRecord {
  id: string;
  display: PreviewDisplay;
  container: string;
  /** http://127.0.0.1:<host port> */
  origin: string;
  host_port: number;
  container_port: number;
  script: string;
  source: PreviewSource;
  started_at: string;
  last_seen: string;
  ttl_ms: number;
  host: string;
  check?: PreviewCheckRecord;
}

export const ORIGIN_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
export const PREVIEW_DISPLAYS = ["live", "click", "screenshot"] as const;
export type PreviewDisplay = typeof PREVIEW_DISPLAYS[number];
export const isPreviewDisplay = (value: unknown): value is PreviewDisplay => PREVIEW_DISPLAYS.some(mode => mode === value);

export const previewsDir = (): string => join(ROUNDTABLE_HOME, "previews");
const recordPath = (id: string): string => join(previewsDir(), `${id}.json`);
const screenshotPath = (id: string): string => join(previewsDir(), `${id}.png`);

/** Page-check PNGs stay beside the record, outside event logs and archives. */
export function writePreviewScreenshot(id: string, bytes: Buffer): void {
  if (!PREVIEW_ID_RE.test(id)) throw new Error("Invalid preview id");
  ensureStateHome(ROUNDTABLE_HOME);
  mkdirPrivate(previewsDir());
  writeFileAtomic(screenshotPath(id), bytes);
}

export function readPreviewScreenshot(id: string): Buffer | undefined {
  if (!PREVIEW_ID_RE.test(id)) return undefined;
  try { return readFileSync(screenshotPath(id)); } catch { return undefined; }
}

/** The record when `value` has exactly the shape startPreview writes, else undefined. */
export function parseRecord(value: unknown): PreviewRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<PreviewRecord>;
  const originPort = typeof r.origin === "string" ? Number(ORIGIN_RE.exec(r.origin)?.[1]) : NaN;
  const ok =
    (r.display === undefined || isPreviewDisplay(r.display)) &&
    typeof r.id === "string" && PREVIEW_ID_RE.test(r.id) &&
    typeof r.container === "string" && /^rt-preview-[a-z0-9]{8}$/.test(r.container) &&
    originPort >= 1 && originPort <= 65_535 && r.host_port === originPort &&
    Number.isInteger(r.container_port) && typeof r.script === "string" && /^[a-z]{1,16}$/.test(r.script) &&
    !!r.source && (r.source.kind === "task" || r.source.kind === "prototype") &&
    (r.source.duel === undefined || (typeof r.source.duel === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(r.source.duel))) &&
    typeof r.started_at === "string" && typeof r.last_seen === "string" && Number.isFinite(Date.parse(r.last_seen)) &&
    Number.isFinite(r.ttl_ms) && typeof r.host === "string";
  // Records created before display modes retain their existing live behaviour.
  return ok ? { ...r, display: r.display ?? "live" } as PreviewRecord : undefined;
}

export function writeRecord(record: PreviewRecord): void {
  ensureStateHome(ROUNDTABLE_HOME);
  mkdirPrivate(previewsDir());
  writeFileAtomic(recordPath(record.id), JSON.stringify(record) + "\n");
}

export function removeRecord(id: string): void {
  if (PREVIEW_ID_RE.test(id)) {
    rmSync(recordPath(id), { force: true });
    rmSync(screenshotPath(id), { force: true });
  }
}

/** Every valid record on this host (a malformed or foreign file is ignored). Never throws. */
export function readRecords(): PreviewRecord[] {
  let names: string[];
  try { names = readdirSync(previewsDir()); } catch { return []; }
  const out: PreviewRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !PREVIEW_ID_RE.test(name.slice(0, -5))) continue;
    try {
      const record = parseRecord(JSON.parse(readFileSync(join(previewsDir(), name), "utf8")));
      if (record && record.id === name.slice(0, -5) && record.host === hostname()) out.push(record);
    } catch { /* unreadable: the sweep removes its container */ }
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function readRecord(id: string): PreviewRecord | undefined {
  return PREVIEW_ID_RE.test(id) ? readRecords().find((r) => r.id === id) : undefined;
}

/** Mark a preview as just viewed (restarts its idle time). Best effort. */
export function touchRecord(id: string, now = Date.now()): void {
  try {
    const record = readRecord(id);
    if (record) writeRecord({ ...record, last_seen: new Date(now).toISOString() });
  } catch { /* a failed touch only shortens the preview's life */ }
}

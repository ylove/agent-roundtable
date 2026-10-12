// Types shared by the prototype modules (kept separate so render/board/session never import each other in a cycle).
import type { Decision, PrototypeFile, PrototypeKind, Verdict } from "./parse.js";

export type { Decision, PrototypeFile, PrototypeKind, Verdict } from "./parse.js";

export type PrototypeStatus =
  | "live"
  | "awaiting_decision"
  | "shortlisted"
  | "scrapped"
  | "revised"
  | "expired"
  | "closed";

export interface VerdictEntry {
  assessor: string;
  verdict: Verdict;
  reason: string;
}

/** A prototype version as the renderers see it. */
export interface PrototypeRecord {
  /** "P1" */
  id: string;
  version: number;
  /** "P1 v1" */
  label: string;
  /** "P1v1": the board route and sandbox directory name. */
  key: string;
  title: string;
  kind: PrototypeKind;
  /** Display name of the proposer. */
  proposer: string;
  /** Source as materialized (redacted in public sessions). Emptied once no longer needed. */
  files: PrototypeFile[];
  fileCount: number;
  entry?: string;
  demo: string;
  status: PrototypeStatus;
  verdicts: VerdictEntry[];
  decision?: { decision: Decision; reason: string };
  /** Label of the version that replaced this one. */
  supersededBy?: string;
}

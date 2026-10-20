// ============================================================================
// Postmortem mode: shared types and limits (docs/design/postmortem.md)
// ============================================================================

import type { DissentRuntime, PostmortemArtifactKind, PostmortemCategory, PostmortemFinding, PostmortemFormat } from "../execution/types.js";

export const ARTIFACT_KINDS: readonly PostmortemArtifactKind[] = ["fix", "rule", "persona_addendum", "agent_rule", "contract_rule", "memory", "dissent_score"];
export const CATEGORIES: readonly PostmortemCategory[] = ["prompt_misread", "project_misread", "contract_ambiguity", "implementation", "test_gap", "process"];
/** Findings in these categories are flagged: the meeting records what was misread (§6). */
export const FLAG_CATEGORIES: readonly PostmortemCategory[] = ["prompt_misread", "project_misread", "contract_ambiguity"];

export const PM_ID_RE = /^pm-[0-9a-hjkmnp-tv-z]{8}$/;
export const PROJECT_KEY_RE = /^[0-9a-f]{16}$/;
export const FINDING_ID_RE = /^pmf-[0-9a-z]{8,16}$/;

export const LIMITS = {
  summary: 600,
  detectedBy: 300,
  responsible: 20,
  responsibleName: 200,
  evidence: 20,
  evidenceRef: 300,
  work: 200,
  reason: 2000,
  opening: 8000,
  closing: 4000,
  /** Artifacts per postmortem and characters per artifact (§6). */
  artifacts: 20,
  artifactText: 600,
  seats: 12,
  rounds: { min: 1, max: 4, default: 2 },
} as const;

/** The two ways a draft is scoped: a heads-down execution, or at-the-table work with a short label. */
export interface PostmortemScope {
  execution_id?: string;
  work?: string;
}

export interface ProjectFile {
  v: 1;
  key: string;
  repo_root: string;
  created: string;
  postmortem: { enabled: boolean; since?: string; reason_sha256?: string; by?: string };
}

export interface DraftFile {
  v: 1;
  pm: string;
  project: string;
  scope: PostmortemScope;
  created: string;
  /** At-the-table drafts hold their findings; an execution's draft is rebuilt from its events. */
  findings: PostmortemFinding[];
}

export interface Turn {
  seat: string;
  content: string;
}

export interface Artifact {
  id: string;
  kind: PostmortemArtifactKind;
  /** A path or task id (fix), dissent id (dissent_score), "project", or an agent name. */
  target: string;
  findings: string[];
  text: string;
  /** For dissent_score only; text carries the supporting evidence. */
  outcome?: DissentRuntime["score"];
  /** sha256 of the artifact's kind, target, text and outcome (when present). */
  hash: string;
}

export interface AppliedArtifact {
  id: string;
  kind: PostmortemArtifactKind;
  target: string;
  hash: string;
  /** The file the effect landed in, when there is one. */
  path?: string;
  note?: string;
  /** The effect succeeded, but its per-write audit must be retried before publication. */
  audit_pending?: boolean;
}

export interface FlagRecord {
  finding: string;
  category: PostmortemCategory;
  /** What was misread: the finding's summary. */
  misread: string;
  /** The clearer wording the meeting proposed, from the accepted artifacts that name the finding. */
  clearer?: string;
}

export interface PostmortemRecord {
  v: 1;
  pm: string;
  project: string;
  scope: PostmortemScope;
  /** held: the meeting ran and waits for the orchestrator's conclusion. */
  status: "held" | "concluded";
  created: string;
  held_at: string;
  concluded_at?: string;
  format: PostmortemFormat;
  rounds: number;
  seats: string[];
  /** The persona refs the meeting loaded, by seat key: the file an accepted addendum is written to. */
  refs?: Record<string, string>;
  /** The collaboration session the meeting ran in. */
  session: string;
  memory_target?: "claude";
  opening: string;
  closing?: string;
  findings: PostmortemFinding[];
  /** Scrubbed snapshot from the reviewed run's WS16 projection, taken when held. */
  dissents?: Record<string, DissentRuntime>;
  transcript: Turn[];
  proposed: Artifact[];
  rejected_lines: string[];
  accepted?: string[];
  rejected?: Array<{ id: string; why: string }>;
  applied?: AppliedArtifact[];
  flagged?: FlagRecord[];
  summary?: string;
}

export type LessonKind = "rule" | "agent_rule" | "contract_rule" | "flag";

export interface Lesson {
  id: string;
  kind: LessonKind;
  /** "project", or the agent an agent_rule is scoped to. */
  target: string;
  text: string;
  pm: string;
  findings: string[];
  at: string;
  flag?: true;
  superseded_by?: string;
}

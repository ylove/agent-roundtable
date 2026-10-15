// ============================================================================
// Tool names and the human-facing mode labels
// ============================================================================

import type { Mode } from "../execution/types.js";

// Human-facing labels for the two modes. Code enums say "deliberation" and "execution"; these are what
// people read. "At the table" always goes with a format ("a debate at the table").
export const AT_THE_TABLE = "at the table";
export const HEADS_DOWN = "heads-down";

export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  deliberation: AT_THE_TABLE,
  execution: HEADS_DOWN,
};

// === Deliberation (at the table) ===

// Meetings
export const START_MEETING = "start_meeting";
export const SAY = "say";
export const END_MEETING = "end_meeting";
export const LIST_MEETINGS = "list_meetings";

// Local meetings (Claude CLI)
export const START_LOCAL_MEETING = "start_local_meeting";
export const SAY_LOCAL = "say_local";
export const END_LOCAL_MEETING = "end_local_meeting";
export const LIST_LOCAL_MEETINGS = "list_local_meetings";

// LLM completion
export const CHAT_COMPLETION = "chat_completion";

// Collaborations
export const START_COLLABORATION = "start_collaboration";
export const CONTINUE_COLLABORATION = "continue_collaboration";
export const NUDGE_COLLABORATION = "nudge_collaboration";
export const PAUSE_COLLABORATION = "pause_collaboration";
export const END_COLLABORATION = "end_collaboration";
export const GET_COLLABORATION_TRANSCRIPT = "get_collaboration_transcript";
export const LIST_COLLABORATIONS = "list_collaborations";

// Ultraplan
export const START_ULTRAPLAN = "start_ultraplan";
export const SUBMIT_PLAN = "submit_plan";
export const END_ULTRAPLAN = "end_ultraplan";

// Agent workshops
export const CREATE_AGENT = "create_agent";
export const IMPROVE_AGENT = "improve_agent";

// Diagnostics
export const DEBUG_ENV = "debug_env";

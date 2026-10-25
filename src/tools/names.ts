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

// Duel
export const START_DUEL = "start_duel";
export const CASTING_CALL = "casting_call";

// Ultraplan
export const START_ULTRAPLAN = "start_ultraplan";
export const SUBMIT_PLAN = "submit_plan";
export const END_ULTRAPLAN = "end_ultraplan";

// Agent workshops
export const CREATE_AGENT = "create_agent";
export const IMPROVE_AGENT = "improve_agent";

// Diagnostics
export const DEBUG_ENV = "debug_env";

// === Execution (heads-down) ===

// Contracts
export const PROPOSE_CONTRACT = "propose_contract";
export const AMEND_CONTRACT = "amend_contract";
export const FREEZE_CONTRACT = "freeze_contract";
export const FILE_DISSENT = "file_dissent";
export const SCORE_DISSENT = "score_dissent";

// Run (orchestrator server only)
export const EXECUTE = "execute";
export const EXECUTION_STATUS = "execution_status";
export const CONTROL_EXECUTION = "control_execution";
export const RESOLVE_ESCALATION = "resolve_escalation";
export const JOIN_EXECUTION = "join_execution";

// Usage (orchestrator server only)
export const USAGE = "usage";
// Postmortem mode (orchestrator server only)
export const POSTMORTEM = "postmortem";
export const HOLD_POSTMORTEM = "hold_postmortem";

// Worker tools: bound to the token on the worker server; on the orchestrator server they take agent_token
export const READ_BLACKBOARD = "read_blackboard";
export const CLAIM_TASK = "claim_task";
export const LEASE = "lease";
export const POST_UPDATE = "post_update";
export const RUN_COMMAND = "run_command";
export const SUBMIT_WORK = "submit_work";
export const ESCALATE = "escalate";
export const SPAWN_SUBTASKS = "spawn_subtasks";
export const AWAIT_SUBTASKS = "await_subtasks";

/** Execution tools authenticated with agent_token. Draft FILE_DISSENT also supports worker mode. */
export const WORKER_TOOL_NAMES = [READ_BLACKBOARD, CLAIM_TASK, LEASE, POST_UPDATE, RUN_COMMAND, SUBMIT_WORK, ESCALATE, SPAWN_SUBTASKS, AWAIT_SUBTASKS] as const;

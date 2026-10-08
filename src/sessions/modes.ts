// ============================================================================
// Session modes: debate (meetings + collaborations), waffle-house and conversation
// ============================================================================

export type MeetingMode = "standard" | "debate";
export type CollaborationMode = "collaborate" | "debate" | "waffle-house" | "conversation";
export type ConversationAngle = "recent-work" | "product" | "founder" | "open-problem" | "cross-team" | "theme";
export type CollaborationRole = "proponent" | "challenger" | "defender" | "attacker";

// Declared enums for the tool schemas. The low-level MCP Server does not enforce inputSchema enums,
// so the start* functions re-check against these lists (same idea as the Unknown provider guard).
export const MEETING_MODES: readonly MeetingMode[] = ["standard", "debate"];
export const COLLABORATION_MODES: readonly CollaborationMode[] = ["collaborate", "debate", "waffle-house", "conversation"];

export function assertMeetingMode(mode: string): asserts mode is MeetingMode {
  if (!(MEETING_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Valid modes: ${MEETING_MODES.join(", ")}`);
  }
}

export function assertCollaborationMode(mode: string): asserts mode is CollaborationMode {
  if (!(COLLABORATION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Valid modes: ${COLLABORATION_MODES.join(", ")}`);
  }
}

// ----------------------------------------------------------------------------
// Conversation (collaborations only)
// ----------------------------------------------------------------------------

export function buildConversationDirective(): string {
  return "\n\n## Conversation mode\n" +
    "Have an unstructured conversation with colleagues, not a meeting or debate. There is no agenda or deliverable. " +
    "React, share specifics from your own work, ask real questions, disagree when you disagree, and move to a new thread when one runs out. " +
    "Draw on your situation: the product you're building, recent work, the people you work with including the founder or whoever you report to, and open problems.\n\n" +
    "TRUTHFULNESS: Only state as fact what your persona or your \"Your context\" notes establish. " +
    "Say when you don't know and mark guesses as guesses. Never invent past events, metrics or decisions.\n\n" +
    "Usually 2-6 sentences. No headings, no bullet lists, no summaries, and no action-item lists unless asked.";
}

export function pickOpeningAngle(
  available: { activity: boolean; memory: boolean; workspace: boolean },
  topic?: string,
  rand: () => number = Math.random
): ConversationAngle {
  if (topic?.trim()) return "theme";
  const choices: Array<[ConversationAngle, number]> = [
    ["recent-work", available.activity || available.memory ? 3 : 0],
    ["product", available.workspace ? 2 : 1],
    ["founder", 1],
    ["open-problem", 2],
    ["cross-team", 1],
  ];
  let remaining = rand() * choices.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [angle, weight] of choices) {
    if (remaining < weight) return angle;
    remaining -= weight;
  }
  return "cross-team";
}

export function buildConversationOpeningPrompt(angle: ConversationAngle, participants: string[], topic?: string): string {
  const phrases: Record<ConversationAngle, string> = {
    "recent-work": "something you worked on recently or something that happened in your recent work",
    product: "something about the product you're building: where it is, where it's heading, or what's been on your mind about it",
    founder: "something about the founder or the person you work for: a decision they made, how they're shaping the product, or what working with them is like",
    "open-problem": "an open problem in your area that you keep coming back to",
    "cross-team": "something another participant's area is doing that affects your work",
    theme: "your honest take on the theme, from your own context",
  };
  return `You're starting a conversation with: ${participants.join(", ")}.\n\n` +
    (angle === "theme" && topic?.trim() ? `Loose theme: ${topic}. It's a starting point, not an agenda.\n\n` : "") +
    `Open the way a colleague would, with ${phrases[angle]}.`;
}

export function buildConversationTurnPrompt(): string {
  return "It's your turn. Respond to what was just said the way you would in a real conversation: " +
    "react, add something from your own context, or ask a question, or move to a new thread if this one has run its course. Usually 2-6 sentences.";
}

export function buildConversationSummaryPrompt(topic?: string): string {
  return "Give a short recap of the conversation" + (topic?.trim() ? ` (loose theme: ${topic})` : "") + ":\n" +
    "1. Threads that came up\n" +
    "2. Ideas or concerns worth following up, and who raised them\n" +
    "3. Anything the founder (or whoever you report to) should hear\n\n";
}

// ----------------------------------------------------------------------------
// Debate
// ----------------------------------------------------------------------------

/** Appended to a challenger's system prompt in debate mode. Never applied to the proponent. */
export function buildChallengerDirective(focus?: string): string {
  let directive = "\n\n## Debate role: challenger\n";
  directive +=
    "You remain fully in persona, but in this session your job is to stress-test the position being presented, not to help build it. " +
    "Attack the weakest assumption first. Ask for the evidence and the numbers behind every claim. " +
    "Name the failure modes and second-order effects the proponent has not addressed.\n\n";
  directive +=
    "Do not concede for the sake of harmony, and do not manufacture objections you do not believe: " +
    "when a point is sound, say so explicitly and move to the next weakest point. " +
    "End every turn by naming the single objection you consider most important that is still unresolved.";
  if (focus) {
    directive += ` Focus your challenge on: ${focus}.`;
  }
  return directive;
}

/** User-turn text for the proponent in debate mode. Never appended to a system prompt. */
export function buildProponentDirective(focus?: string): string {
  let directive =
    "State the position and the strongest reasoning behind it. Treat every challenge seriously: " +
    "concede what is valid, rebut what is not, and restate your revised position at the end of each turn.";
  if (focus) {
    directive += ` The challenge is focused on: ${focus}.`;
  }
  return directive;
}

/** Appended to the user message of a debate-mode meeting. */
export const DEBATE_MEETING_USER_SUFFIX =
  "You are the challenger in this meeting: the agenda above is the position to stress-test.";

/** User-turn closing text for a challenger's turn in a debate-mode collaboration. */
export function buildChallengerTurnPrompt(focus?: string): string {
  return (
    "It's your turn. Press on the weakest point in the proponent's latest position. " +
    "Do not restate objections the proponent has already conceded. " +
    "Concede explicitly if the proponent has answered you. " +
    "End with the single most important unresolved objection." +
    (focus ? ` Focus on: ${focus}.` : "")
  );
}

// ----------------------------------------------------------------------------
// Waffle-house (collaborations only): agents[0] defends, everyone else attacks
// ----------------------------------------------------------------------------

/** Appended to every attacker's system prompt in waffle-house mode. Never applied to the defender. */
export function buildAttackerDirective(): string {
  let directive = "\n\n## Waffle-house role: attacker\n";
  directive +=
    "You remain fully in persona, but in this session you are an adversary of the idea being defended. " +
    "Be blunt and unsparing. Scorn, mockery and insult aimed at the IDEA are allowed when they are earned by a real flaw. " +
    "The purpose is to distill the idea to its optimal form, not to win: an attack you do not believe is worthless.\n\n";
  directive +=
    "Hard limits: never attack anyone's identity or protected traits, never make threats, never use slurs, " +
    "and never attack the defender as a person beyond the argument itself.\n\n";
  directive +=
    "Take a distinct angle rooted in your persona and stay on it. Never repeat a hit another attacker has already landed. " +
    "Press hardest wherever the defender dodged, deflected or answered a different question. " +
    "Acknowledge an attack as answered only when it truly is answered, then move on to the next weakest point. " +
    "End every turn with the single most damaging attack that is still open.";
  return directive;
}

/** Opening user-turn text for the defender (agents[0]) in waffle-house mode. */
export function buildDefenderOpeningPrompt(): string {
  return (
    "State the idea and make the strongest case for it. The other participants are attackers and will try to tear it apart; " +
    "afterwards you will answer them. End with \"Current position (v1):\" and state the idea in full."
  );
}

/** Per-turn user-turn text for the defender in waffle-house mode. `version` is the version this turn will produce. */
export function buildDefenderTurnPrompt(version: number): string {
  return (
    "It's your turn to defend. Answer EVERY attack made since your last turn. " +
    "For each attack, say explicitly whether you rebut it, concede it, or revise the idea because of it. " +
    "Yield to arguments, not to tone. You may change the idea if an argument earns it. " +
    `End with "Current position (v${version}):" and restate the idea in full as it now stands.`
  );
}

/** Per-turn user-turn text for an attacker in waffle-house mode. */
export function buildAttackerTurnPrompt(): string {
  return (
    "It's your turn to attack. Read the defender's latest position and the other attackers' hits. " +
    "Do not repeat an attack that has already been made. Press where the defender dodged. " +
    "Concede an attack only if it was truly answered, then move on. " +
    "End with the single most damaging open attack."
  );
}

/** Summary request the defender answers at the end of a waffle-house session. */
export function buildWaffleHouseSummaryPrompt(topic: string): string {
  return (
    `You were the defender in a waffle-house session (an adversarial gauntlet) on: ${topic}\n\n` +
    `Write:\n` +
    `1. The final form of the idea\n` +
    `2. What changed during the session, and which attack forced each change\n` +
    `3. Attacks that remain unanswered\n` +
    `4. Your confidence in the final form\n\n`
  );
}

/** Summary request the proponent answers at the end of a debate session. */
export function buildDebateSummaryPrompt(topic: string): string {
  return (
    `You were the proponent in a structured debate on: ${topic}\n\n` +
    `Summarize:\n` +
    `1. Points you conceded\n` +
    `2. Objections that remain unresolved\n` +
    `3. Your revised position and how confident you are in it\n\n`
  );
}

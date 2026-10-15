# Collaborations

At the table, two or more personas take turns on a topic using one provider and model. Start with `start_collaboration`, then continue, nudge, pause, inspect the transcript, or end it. `max_rounds` and requested continuation `rounds` are capped at 20. Nudges never count as agent turns.

> Run a collaboration via agent-roundtable between cfo and skeptic on “Should we raise now?”, three rounds max, and run the first round immediately.

## Formats

- **collaborate** (default): agents build on each other's ideas.
- **debate** (meetings, local meetings, collaborations): the agent, or every agent after `agents[0]`, acts as a challenger that stress-tests a position instead of helping build it. `agents[0]` is the proponent. `debate_focus` optionally narrows the challenge.
- **waffle-house** (collaborations only): an adversarial gauntlet. `agents[0]` defends an idea, every other agent attacks it. Each round every attacker attacks, then the defender answers the whole volley (rebut, concede or revise) and restates its "Current position (vN)". A session runs `1 + max_rounds x N` agent turns and always ends on the defender's rebuttal; the defender writes the summary (final form of the idea, what changed and which attack forced it, unanswered attacks, confidence). Needs 2+ agents. Attackers may be blunt about the idea; identity attacks, threats and slurs are out of bounds.

- **prototype** (a flag, not a mode): agents show proposals as prototypes; combines with the modes above except conversation. See [Prototype mode](prototype-mode.md).

- **conversation** (collaborations only): informal chat from the agents' own situation; optional topic and private grounding. See [Conversation mode](#conversation-mode).

Nudges from the caller never count as agent turns, so they do not shorten a session or change whose turn it is.

## Conversation mode

> Have cfo and product-lead have a conversation on agent-roundtable. No agenda. They just shipped the onboarding redesign; the CFO last reviewed the launch budget. Put that situation in their context and let them talk for two rounds.

> Let product-lead and skeptic chat loosely about where the product is heading. Use conversation mode with grounding disabled.

`start_collaboration` with `mode: "conversation"` produces informal colleague chat, usually 2–6 sentences per turn, with no agenda or deliverable. `topic` is an optional loose theme; every other collaboration mode requires it. Put what you know about the agents' current situation in `context`: what was just built, what each agent last did, and current problems. Agents are told to use facts established by their personas/context, mark guesses, and avoid invented events or metrics. Continue, nudge, inspect and end with the usual collaboration tools; an optional summary recaps threads, concerns and anything the founder should hear. Public conversations never open on the founder angle, and their directive does not ask agents to talk about the founder or whoever they report to.

Private conversations default to grounding: workspace excerpts (package metadata, project instructions, README and recent git history), agent-memory notes, and recent roundtable activity are sent to the session's provider. Set `grounding: false` to disable this. **Public conversations never receive grounding.** The activity log is stored locally. Private conversation grounding and private `improve_agent` contributor prompts send recent topics and outcomes from it to the session's provider. Public improve runs never include the target's recent activity in any prompt. `list_collaborations` reports the opening angle and grounding sources.

See [Conversation tool calls](../tools.md#conversation-tool-calls).

See [collaboration tool calls](../tools.md#tool-call-examples), [public sessions](public-sessions.md), and [session archives](../sessions.md).

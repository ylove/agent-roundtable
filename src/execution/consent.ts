// ============================================================================
// Consent: every participant answers `Consent: AGREE | OBJECT` before a contract is frozen
//
// The provider calls never run inside transact. contract.consent_requested is recorded first, in
// its own transaction (refused while another round is in flight), then every participant is asked
// (runVerdictRound, the same machinery as ultraplan sign-off), then the answers are recorded in one
// batch. An answer without a verdict line is re-asked once with a stricter prompt; still unclear,
// it is recorded as UNCLEAR, which counts as an objection.
// ============================================================================

import { hostname } from "node:os";
import { DEFAULT_MODELS, type LLMProvider } from "../config.js";
import { loadAgentPromptWithPath } from "../agents.js";
import { newId } from "../ids.js";
import type { CallLLMOptions } from "../providers/index.js";
import { runVerdictRound, truncate } from "../sessions/workshop.js";
import { consentHash, renderContractMarkdown } from "./contract.js";
import {
  beginConsentRound,
  contractRecord,
  endConsentRound,
  orchestratorSource,
  presentContract,
  summarizeConsent,
  writeContractFiles,
  type ConsentSummary,
  type ContractRecord,
} from "./contract-state.js";
import type { AnyEventDraft, Contract, ExecutionStore } from "./types.js";

export const CONSENT_LABEL = "Consent";
export const CONSENT_VERDICTS = ["AGREE", "OBJECT"] as const;

/** Largest reason recorded per answer (bytes of its JSON string), well inside the 8 KB payload limit. */
const REASON_BYTES = 3000;
const PROMPT_CONTRACT_LIMIT = 40_000;

export interface ConsentLLMOptions {
  provider?: LLMProvider;
  model?: string;
  baseUrl?: string;
}

/** Provider and model as the other engines resolve them: anthropic and its default model unless given. */
export function resolveConsentLLM(o: ConsentLLMOptions = {}): CallLLMOptions {
  const provider = o.provider || "anthropic";
  return { provider, model: o.model || DEFAULT_MODELS[provider], ...(o.baseUrl !== undefined && { baseUrl: o.baseUrl }) };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildConsentDirective(): string {
  return "\n\n## Contract consent\n" +
    "You are a participant in a heads-down run: once the contract is frozen, workers build it in parallel and coordinate only through " +
    "the event log and the blackboard. Read the contract as the one who will do your part. Agree when it is workable; object only to " +
    "something that would stop the work or make it fail, and say what change would fix it.";
}

/** The whole contract with the participant's own tasks marked, then the required answer format. */
export function buildConsentPrompt(c: Contract, agent: string): string {
  const own = c.tasks.filter((t) => t.persona === agent).map((t) => t.id);
  const p = c.participants.find((x) => x.agent === agent);
  return `The contract below (\`${c.id}\` v${c.version}) has been proposed for a heads-down run. Every participant must consent before it is frozen.\n\n` +
    `**You:** ${agent}${p?.role ? `, ${p.role}` : ""}${p?.team ? `, team ${p.team}` : ""}. ` +
    (own.length ? `Your tasks are marked (yours): ${own.join(", ")}.` : "You have no tasks of your own: judge the contract as a whole.") + "\n\n" +
    truncate(renderContractMarkdown(c, { mark: agent, omitConsent: true }), PROMPT_CONTRACT_LIMIT) + "\n\n" +
    "Check: completing every task meets the goal and the original request; your tasks can be done within their write paths, budget and checks; " +
    "dependencies, interfaces and decisions are right; the validation commands prove the acceptance criteria; the budget and the lead's authority are workable.\n\n" +
    "Answer `Consent: AGREE` or `Consent: OBJECT` on the first line, then your reason. When you object, name the change that would make you agree.";
}

export const CONSENT_REASK =
  "Your answer did not start with a verdict line. Reply again: the first line must be exactly `Consent: AGREE` or `Consent: OBJECT` and nothing else, " +
  "then your reason in one or two sentences.";

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function capBytes(text: string, max = REASON_BYTES): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid) + "…")) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** The answer without its verdict line. */
export function consentReason(content: string): string {
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((l) => /^[\s>#*_`\-+\d.)]*consent[*_`\s]*:/i.test(l));
  const rest = (at >= 0 ? [...lines.slice(0, at), ...lines.slice(at + 1)] : lines).join("\n").trim();
  return capBytes(rest);
}

export interface ConsentAnswer {
  agent: string;
  verdict: "AGREE" | "OBJECT" | "UNCLEAR";
  reason: string;
  reasked: boolean;
  error?: string;
}

export interface ConsentRoundResult {
  contract: string;
  /** The version asked about (a candidate's version when one was given). */
  version: number;
  /** The round's id (absent when nobody needed asking). */
  round?: string;
  /** The participants asked in this round (empty when nobody needed asking). */
  asked: string[];
  answers: ConsentAnswer[];
  /** Set when the answers were not recorded because the round stopped being current. */
  dropped?: string;
  summary: ConsentSummary;
  record: ContractRecord;
}

export interface RequestConsentOptions {
  /** The orchestrator (or lead) recording the round. */
  by: string;
  /** Participants to ask; default every participant of the version asked about. */
  participants?: string[];
  llm?: ConsentLLMOptions;
  /**
   * Ask about this version before it is stored (an amendment of a frozen contract that needs
   * everyone's consent first). It must be the next version, in its stored form; the answers are
   * recorded only while the contract is still at the version before it.
   */
  candidate?: Contract;
}

const mode = (status: string) => (status === "created" ? "deliberation" : "execution");

/**
 * Run one consent round on the latest version of `contractId` (or on a candidate next version):
 * record the request with a round id and the content hash, ask outside any transaction, then
 * record the answers, but only while the round is still current and the version unchanged; a
 * late answer is dropped. An objector who now agrees gets objection_resolved.
 */
export async function requestConsent(store: ExecutionStore, contractId: string, opts: RequestConsentOptions): Promise<ConsentRoundResult> {
  const before = await contractRecord(store, contractId);
  if (before.superseded) throw new Error(`Contract ${contractId} was superseded by ${before.superseded}`);
  const subject = opts.candidate ?? before.contract;
  if (opts.candidate && opts.candidate.version !== before.version + 1) {
    throw new Error(`A candidate for ${contractId} must be v${before.version + 1} (got v${opts.candidate.version})`);
  }
  const all = subject.participants.map((p) => p.agent);
  const asked = [...new Set(opts.participants ?? all)];
  const strangers = asked.filter((a) => !all.includes(a));
  if (strangers.length) throw new Error(`Not participants of ${contractId}: ${strangers.join(", ")}`);
  if (asked.length === 0) return { contract: contractId, version: subject.version, asked, answers: [], summary: summarizeConsent(before), record: before };

  const source = orchestratorSource(opts.by);
  const round = newId("rnd");
  const hash = consentHash(subject);
  const baseVersion = before.version;
  const roundVersion = subject.version;
  await store.transact(async ({ state }) => {
    const rec = await contractRecord(store, contractId);
    if (rec.round?.inFlight) {
      throw new Error(`A consent round for ${contractId} is already in flight (${rec.round.pending.length} answers pending). Wait for it to finish.`);
    }
    if (rec.version !== baseVersion) throw new Error(`Contract ${contractId} changed meanwhile (now v${rec.version}); ask about the latest version`);
    return {
      events: [{
        type: "contract.consent_requested", source, mode: mode(state.status), contract: contractId, contract_version: roundVersion,
        payload: { contract: contractId, version: roundVersion, participants: asked, round, hash, host: hostname() },
      }],
    };
  });
  let answers: ConsentAnswer[] = [];
  let dropped: string | undefined;
  beginConsentRound(round);
  try {
    const loaded: Array<{ name: string; systemPrompt: string } | { name: string; error: string }> = [];
    for (const name of asked) {
      try {
        const { content } = await loadAgentPromptWithPath(name);
        loaded.push({ name, systemPrompt: content + buildConsentDirective() });
      } catch (e) {
        loaded.push({ name, error: `the persona could not be loaded: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` });
      }
    }
    const agents = loaded.filter((a): a is { name: string; systemPrompt: string } => "systemPrompt" in a);
    const replies = await runVerdictRound(agents, (a) => buildConsentPrompt(subject, a.name), CONSENT_LABEL, {
      verdicts: CONSENT_VERDICTS, llm: resolveConsentLLM(opts.llm), reask: CONSENT_REASK, catchErrors: true,
    });
    const byName = new Map(replies.map((r) => [r.agent.name, r]));
    answers = loaded.map((a): ConsentAnswer => {
      if ("error" in a) return { agent: a.name, verdict: "UNCLEAR", reason: capBytes(`no answer: ${a.error}`), reasked: false, error: a.error };
      const r = byName.get(a.name)!;
      if (r.error !== undefined) return { agent: a.name, verdict: "UNCLEAR", reason: capBytes(`no answer: ${r.error}`), reasked: r.reasked, error: r.error };
      if (r.verdict === "UNCLEAR") {
        return {
          agent: a.name, verdict: "UNCLEAR", reasked: r.reasked,
          reason: capBytes(`no "Consent: AGREE" or "Consent: OBJECT" line, even after a stricter re-ask (counted as an objection). The answer: ${r.content.trim()}`),
        };
      }
      return { agent: a.name, verdict: r.verdict as "AGREE" | "OBJECT", reason: consentReason(r.content), reasked: r.reasked };
    });
    await store.transact(async ({ state }) => {
      const now = await contractRecord(store, contractId);
      if (now.round?.id !== round) {
        dropped = `the answers were not recorded: a newer consent round for ${contractId} started meanwhile`;
        return { events: [] };
      }
      if (now.version !== baseVersion) {
        dropped = `the answers were not recorded: ${contractId} moved on to v${now.version} meanwhile`;
        return { events: [] };
      }
      const events: AnyEventDraft[] = [];
      for (const a of answers) {
        if (!now.round.pending.includes(a.agent)) continue; // the first answer per participant wins (an abandoned round's UNCLEAR included)
        events.push({
          type: "contract.consent_recorded", source, mode: mode(state.status), contract: contractId, contract_version: roundVersion,
          payload: { contract: contractId, agent: a.agent, verdict: a.verdict, ...(a.reason && { reason: a.reason }), round },
        });
        const prior = Object.hasOwn(before.verdicts, a.agent) ? before.verdicts[a.agent] : undefined;
        if (a.verdict === "AGREE" && prior && (prior.verdict === "OBJECT" || prior.verdict === "UNCLEAR") && !prior.resolved) {
          const how = prior.version < roundVersion ? "amended" : "withdrawn";
          events.push({
            type: "contract.objection_resolved", source, mode: mode(state.status), contract: contractId, contract_version: roundVersion,
            payload: { contract: contractId, agent: a.agent, how, reason: how === "amended" ? `agreed to v${roundVersion}` : "withdrew the objection" },
          });
        }
      }
      return { events };
    });
  } finally {
    endConsentRound(round);
  }
  if (dropped) console.error(`[Contracts] ${dropped}`);
  const record = await contractRecord(store, contractId);
  if (!opts.candidate) {
    try {
      writeContractFiles(store, presentContract(record));
    } catch (e) {
      console.error(`[Contracts] could not update the files of ${contractId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { contract: contractId, version: roundVersion, round, asked, answers, ...(dropped && { dropped }), summary: summarizeConsent(record), record };
}

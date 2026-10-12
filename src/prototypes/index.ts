// Prototype mode: public API, the registry of open trackers, shutdown and diagnostics.
//   const tracker = await PrototypeTracker.create({ sessionId, mode, participants, assessorIsCaller, public })
//   const r = await tracker.onTurn(speakerIndex, text, turnKey)   // every turn, in order, before recording it publicly
//   tracker.statusPromptFor(i) / historyView(text, key) / publicView(text, key) / takeCallSummary()
//   tracker.outcomesMarkdown(); await tracker.close("ended")
import { PROTOTYPE_DIR, PROTOTYPE_OPEN, PROTOTYPE_SCREENSHOTS, PROTOTYPE_TTL_MS } from "../config.js";
import { registeredTrackers } from "./registry.js";
import { findChrome } from "./screenshot.js";
import type { PrototypeTracker } from "./session.js";

export {
  CALLER,
  NOTICE as PROTOTYPE_NOTICE,
  PrototypeTracker,
  type PrototypeAttachment,
  type TrackerOptions,
  type TurnResult,
} from "./session.js";
export type { Decision, PrototypeKind, PrototypeRecord, PrototypeStatus, Verdict, VerdictEntry } from "./types.js";
export {
  parsePrototypeBlock,
  parseVerdictFor,
  parseDecisionFor,
  replacePrototypeBlock,
  scrubPrototypeBlocks,
  validatePath,
  type ParsedPrototype,
  type ParseResult,
  type PrototypeFile,
} from "./parse.js";
export { buildPrototypeDirective, publicPrototypeAmendment } from "./directive.js";
export { mermaidLiveUrl, renderPublicPrototype, renderStub, renderOutcomesMarkdown } from "./render.js";
export {
  ensurePrototypeRoot,
  createSessionDir,
  materializeFiles,
  removeDir,
  removeDirSync,
  sweepStaleSessionDirs,
} from "./sandbox.js";
export { PrototypeBoard, openInBrowser, type BoardState, type BoardPrototype, type BoardMeta } from "./board.js";
export { findChrome, captureScreenshots, DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from "./screenshot.js";

/** Trackers that have been created and not closed yet. */
export function activePrototypeTrackers(): PrototypeTracker[] {
  return registeredTrackers() as PrototypeTracker[];
}

/** Close every open tracker (destroys live artifacts, stops boards, removes session dirs). Never throws. */
export async function destroyAllPrototypes(reason: "ended" | "completed" | "shutdown" = "shutdown"): Promise<void> {
  await Promise.all(registeredTrackers().map((t) => t.close(reason).catch(() => undefined)));
}

/** For debug_env and the startup banner. */
export function prototypeDiagnostics(): {
  dir: string;
  chrome: string | null;
  screenshots: boolean;
  open_browser: boolean;
  ttl_ms: number;
  active_boards: number;
} {
  return {
    dir: PROTOTYPE_DIR,
    chrome: findChrome(),
    screenshots: PROTOTYPE_SCREENSHOTS,
    open_browser: PROTOTYPE_OPEN,
    ttl_ms: PROTOTYPE_TTL_MS,
    active_boards: registeredTrackers().length,
  };
}

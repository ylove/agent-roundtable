// ============================================================================
// Runner supervision decisions: pid liveness is supplied by runner-launch
// ============================================================================

import type { RunnerLiveness } from "../execution/runner-launch.js";

export interface RelaunchHistory { attempts: number[]; capNotified?: boolean }
export interface SupervisedRun {
  id: string;
  status: string;
  runner: RunnerLiveness;
  /** Pid check for a recorded clean stop; unknown pids are protected. */
  alive?: boolean;
}
export interface SupervisorDecision { action: "none" | "relaunch" | "notify"; history: RelaunchHistory }

export function supervise(run: SupervisedRun, now: number, previous: RelaunchHistory = { attempts: [] }): SupervisorDecision {
  const attempts = previous.attempts.filter(at => at > now - 3_600_000);
  const history = { attempts, capNotified: attempts.length >= 6 && previous.capNotified === true };
  const dead = run.runner.state === "dead" || (run.runner.state === "stopped" && run.runner.pid !== undefined && run.alive === false);
  if (["completed", "failed", "aborted", "paused"].includes(run.status) || !dead) return { action: "none", history };
  if (attempts.length >= 6) return { action: history.capNotified ? "none" : "notify", history: { ...history, capNotified: true } };
  const delay = [15_000, 60_000, 300_000][Math.min(2, Math.max(0, attempts.length - 1))];
  if (attempts.length && now - attempts[attempts.length - 1] < delay) return { action: "none", history };
  return { action: "relaunch", history: { attempts: [...attempts, now], capNotified: false } };
}

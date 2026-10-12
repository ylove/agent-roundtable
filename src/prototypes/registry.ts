// Registry of open prototype trackers, so shutdown and process exit can destroy every live artifact.

export interface ClosableTracker {
  close(reason: "ended" | "completed" | "shutdown"): Promise<void>;
  closeSync(): void;
}

const trackers = new Set<ClosableTracker>();
let exitHookInstalled = false;

/** Register an open tracker; installs a single process 'exit' hook on first use. */
export function registerTracker(t: ClosableTracker): void {
  trackers.add(t);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const tr of trackers) {
        try {
          tr.closeSync();
        } catch {
          /* best effort */
        }
      }
    });
  }
}

export function unregisterTracker(t: ClosableTracker): void {
  trackers.delete(t);
}

export function registeredTrackers(): ClosableTracker[] {
  return [...trackers];
}

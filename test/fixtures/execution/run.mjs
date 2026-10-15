// A frozen, started heads-down run for the visibility tests (dashboard, GitHub sync).
import { scrubbedJSON } from "../../../dist/execution/blobs.js";
import { createExecutionStore } from "../../../dist/execution/store.js";
import { makeContract, taskSpec, src } from "./script.mjs";

export { makeContract, taskSpec, src };

/** Append one event (one transaction). */
export async function emit(store, type, payload, source = src()) {
  const { events } = await store.transact(() => ({ events: [{ type, payload, source }] }));
  return events[0];
}

/**
 * A new store with `contract` frozen; with `start`, execution.started too. Returns the store and the
 * contract blob ref.
 */
export async function frozenRun(contract = makeContract(), { start = true, github } = {}) {
  const store = await createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc123", agentsDir: "/srv/agents" });
  const blob = await store.putBlob(scrubbedJSON(contract), { redact: false });
  await emit(store, "execution.created", { repo_root: "/srv/repo", base_sha: "abc", contract: contract.id, contract_version: contract.version });
  await emit(store, "contract.frozen", { contract: contract.id, version: contract.version, by: "main", hash: "h1", blob }, src("main", "orchestrator"));
  if (start) {
    await emit(store, "execution.started", {
      confirmation: "go ahead",
      visibility: { dashboard: true, chat_only: false, ...(github && { github }) },
      budget: contract.budget,
      lead: "w1",
      sandbox: "docker",
      drivers: ["claude-code"],
    });
  }
  return { store, blob };
}

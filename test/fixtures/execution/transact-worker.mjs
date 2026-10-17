// Child process for the store concurrency test: <count> transactions against one execution.
// argv: <executionId> <workerName> <count>. ROUNDTABLE_HOME comes from the environment.
const [id, name, count] = process.argv.slice(2);
const { openExecutionStore } = await import("../../../dist/execution/store.js");

const store = await openExecutionStore(id);
for (let i = 0; i < Number(count); i++) {
  // The text records the seq this transaction saw, so the parent can prove every fn ran on fresh state.
  await store.transact(({ state }) => ({
    events: [
      {
        type: "note.posted",
        source: { kind: "agent", id: name, pid: process.pid },
        payload: { topic: "load", text: `${name}:${i}:${state.seq}`, refs: [] },
      },
    ],
  }));
}

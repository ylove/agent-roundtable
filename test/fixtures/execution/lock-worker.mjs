// Child process for the lock race test: <count> read-modify-write increments of a counter file,
// each under withLock, with a yield inside the critical section to invite interleaving.
// argv: <lockDir> <counterFile> <count>
import { readFileSync, writeFileSync } from "node:fs";

const [lockDir, counter, count] = process.argv.slice(2);
const { withLock } = await import("../../../dist/execution/lock.js");
// Shorter than the test's own timeout, so a stuck worker reports the lock and its owner on stderr.
const options = { staleMs: 10_000, timeoutMs: 60_000 };

// Finish module loading and the cached process-start lookup before joining the start barrier.
await withLock(`${lockDir}.warmup.${process.pid}`, options, () => {});
await new Promise((resolve, reject) => {
  process.once("message", (message) => (message === "start" ? resolve() : reject(new Error(`Unexpected message: ${message}`))));
  process.send("ready");
});
process.disconnect();
process.stderr.write(`started ${process.pid}\n`);

for (let i = 0; i < Number(count); i++) {
  await withLock(lockDir, options, async () => {
    const n = Number(readFileSync(counter, "utf8"));
    await new Promise((r) => setImmediate(r));
    writeFileSync(counter, String(n + 1));
  });
}

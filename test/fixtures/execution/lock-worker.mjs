// Child process for the lock race test: <count> read-modify-write increments of a counter file,
// each under withLock, with a yield inside the critical section to invite interleaving.
// argv: <lockDir> <counterFile> <count>
import { readFileSync, writeFileSync } from "node:fs";

const [lockDir, counter, count] = process.argv.slice(2);
const { withLock } = await import("../../../dist/execution/lock.js");

for (let i = 0; i < Number(count); i++) {
  await withLock(lockDir, { staleMs: 10_000, timeoutMs: 30_000 }, async () => {
    const n = Number(readFileSync(counter, "utf8"));
    await new Promise((r) => setImmediate(r));
    writeFileSync(counter, String(n + 1));
  });
}

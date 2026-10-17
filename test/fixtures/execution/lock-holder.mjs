// Child process that takes a lock, reports "held" on stdout, and keeps it until it is killed.
// argv: <lockDir>
const [lockDir] = process.argv.slice(2);
const { acquireLock } = await import("../../../dist/execution/lock.js");

const release = await acquireLock(lockDir, { staleMs: 50, timeoutMs: 5000 });
process.stdout.write(`held ${release.token}\n`);
setInterval(() => {}, 60_000);

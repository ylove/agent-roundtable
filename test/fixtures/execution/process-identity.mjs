// Controlled ps for process-lifecycle tests: deterministic start identities, including simulated
// pid reuse, without depending on a host's process-list permission. Actual liveness uses kill(0).
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let activeDir;

export function installProcessIdentity() {
  const dir = mkdtempSync(join(tmpdir(), "rt-process-identity-"));
  activeDir = dir;
  const path = join(dir, "ps");
  writeFileSync(path, `#!/bin/sh
if [ -f "${dir}/$4" ]; then /bin/cat "${dir}/$4"; else printf "%s\\n" "fixture-start-$4"; fi
`);
  chmodSync(path, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}

export function setProcessIdentity(pid, identity) {
  const path = join(activeDir, String(pid));
  if (identity === undefined) rmSync(path, { force: true });
  else writeFileSync(path, identity);
}

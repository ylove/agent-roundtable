// ============================================================================
// Process HTTP stack: the pinned package supplies fetch and its companion types
// ============================================================================

import { fetch, Headers, Request, Response, FormData } from "undici";

let installed = false;

/** Install once at startup; callers continue to read globalThis.fetch, including test stubs. */
export function installHttpStack(): void {
  if (installed) return;
  Object.assign(globalThis, { fetch, Headers, Request, Response, FormData });
  installed = true;
}

/** Whether the bundled version calls for an informational GHSA-xjj6-f33q-929c update notice. */
export function bundledUndiciNeedsUpdate(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version ?? "");
  if (!m) return false;
  const [, major, minor, patch, suffix] = m;
  const before = (floorMinor: number, floorPatch: number) =>
    Number(minor) < floorMinor || (Number(minor) === floorMinor && (Number(patch) < floorPatch || (Number(patch) === floorPatch && suffix.startsWith("-"))));
  return (major === "6" && Number(minor) >= 23 && before(29, 1)) ||
    (major === "7" && Number(minor) >= 18 && before(30, 1)) ||
    (major === "8" && before(12, 2));
}

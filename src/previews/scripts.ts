// ============================================================================
// Preview scripts: which package script runs the dev server, and on which port
//
// A preview never runs a free-form command. The server is `npm run <name>` where <name> is one of
// three known script names that the package actually defines; the container port is the spec's, or
// the usual default of the dev server the package depends on.
// ============================================================================

/** The only scripts a preview may run, in the order they are tried when none is requested. */
export const PREVIEW_SCRIPTS = ["dev", "start", "preview"] as const;
export type PreviewScript = (typeof PREVIEW_SCRIPTS)[number];

export const DEFAULT_PREVIEW_PORT = 3000;
export const MIN_PREVIEW_PORT = 1024;

export class PreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

export interface PackageLike {
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The package.json object, or a PreviewError for text that is not one. */
export function parsePackageJson(text: string): PackageLike {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PreviewError("package.json is not valid JSON");
  }
  if (!isRecord(value)) throw new PreviewError("package.json is not an object");
  return value as PackageLike;
}

/** The script to run: the requested one (it must be a known name the package defines), else the first of dev, start, preview. */
export function pickScript(pkg: PackageLike, requested?: unknown): PreviewScript {
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  const defined = (name: string) => typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "";
  if (requested !== undefined) {
    if (typeof requested !== "string" || !(PREVIEW_SCRIPTS as readonly string[]).includes(requested)) {
      throw new PreviewError(`a preview runs one of the package scripts ${PREVIEW_SCRIPTS.join(", ")}, not ${JSON.stringify(String(requested).slice(0, 40))}`);
    }
    if (!defined(requested)) throw new PreviewError(`package.json has no "${requested}" script`);
    return requested as PreviewScript;
  }
  const found = PREVIEW_SCRIPTS.find(defined);
  if (!found) throw new PreviewError(`package.json defines none of the scripts ${PREVIEW_SCRIPTS.join(", ")}`);
  return found;
}

/** Usual default ports of common dev servers, by dependency name. */
const DEV_SERVER_PORTS: ReadonlyArray<readonly [string, number]> = [
  ["vite", 5173],
  ["astro", 4321],
  ["parcel", 1234],
  ["@angular/cli", 4200],
  ["next", 3000],
  ["react-scripts", 3000],
];

/** A valid container port: an integer from 1024 to 65535 (the container never runs as root). */
export function validatePort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < MIN_PREVIEW_PORT || port > 65_535) {
    throw new PreviewError(`port must be an integer from ${MIN_PREVIEW_PORT} to 65535`);
  }
  return port;
}

/** The port to publish: the requested one, else the default of the first known dev server the package depends on, else 3000. */
export function defaultPort(pkg: PackageLike, requested?: unknown): number {
  if (requested !== undefined) return validatePort(requested);
  const deps = { ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}) };
  for (const [name, port] of DEV_SERVER_PORTS) if (Object.hasOwn(deps, name)) return port;
  return DEFAULT_PREVIEW_PORT;
}

/** The argv a preview runs: always `npm run <script>`. */
export function previewArgv(script: PreviewScript): string[] {
  return ["npm", "run", script];
}

// ============================================================================
// Dev servers that only listen on all interfaces when told to (vite)
// ============================================================================

/** A script that is one plain `vite` command: optional npx, optional subcommand, plain flags, no shell syntax. */
const PLAIN_VITE_RE = /^(?:npx\s+)?vite(?:\s+(?:dev|serve|preview))?(?:\s+--?[A-Za-z][\w-]*(?:[= ][\w./:@-]+)?)*$/;

/**
 * Whether the script needs `--host 0.0.0.0` to be reachable from the forwarder. A script that does not
 * run vite, or already passes --host, needs nothing. A single plain vite command gets the flag
 * (the caller appends the fixed pair after `--`). Anything more complex that runs vite without
 * --host is refused with a message telling the person to add the flag to the script.
 */
export function viteHostFlag(pkg: PackageLike, script: PreviewScript): boolean {
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  const body = typeof scripts[script] === "string" ? (scripts[script] as string).trim() : "";
  if (!/(?:^|[\s;&|(`])vite(?![\w.-])/.test(body)) return false;
  if (/(?:^|\s)--host(?:[=\s]|$)/.test(body)) return false;
  if (PLAIN_VITE_RE.test(body)) return true;
  throw new PreviewError(
    `the "${script}" script runs vite without --host, so the preview cannot reach it. Add --host to the script (for example "vite --host") and start the preview again.`
  );
}

// ============================================================================
// Preview containers: the pure `docker run` argv builders
//
// A preview container is a throwaway: read-only root, every capability dropped, no-new-privileges,
// pid, memory and CPU limits, a non-root uid, no container log. The source is never mounted: a tar
// snapshot arrives on stdin and is unpacked into a tmpfs, so the container cannot write the host.
//
// The dev server sits alone on a per-preview --internal network, so it has no route out. Docker
// cannot publish a port from an internal network, so a small forwarder container (fixed code, same
// hardening) joins that network and the default bridge and carries the one published port, bound to
// 127.0.0.1 and nothing else (never 0.0.0.0, never host networking).
// ============================================================================

import { hostname } from "node:os";
import { hardeningArgs, IMAGE_RE, validCpus, validMemory, validPids, type DockerLimits } from "../sandbox/docker.js";
import { SandboxRequestError } from "../sandbox/common.js";
import { PreviewError, validatePort, type PreviewScript } from "./scripts.js";

export const PREVIEW_LABEL = "roundtable.preview";
export const PREVIEW_HOST_LABEL = "roundtable.preview-host";
/** Where the snapshot is unpacked, and the working directory of the dev server. */
export const APP_DIR = "/app";
/** The name the forwarder reaches the dev server by, on the preview's internal network. */
export const SERVER_ALIAS = "app";
export const PREVIEW_NET_LABEL = "roundtable.preview-net";

export const PREVIEW_NAME_RE = /^rt-preview-[a-z0-9]{8}$/;
export const PREVIEW_ID_RE = /^prv-[0-9a-hjkmnp-tv-z]{8}$/;
const LABEL_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Unpack stdin into /app, then replace the shell with the validated argv. The text is fixed; nothing is interpolated. */
const UNPACK_THEN_EXEC = `tar -xf - -C ${APP_DIR} && exec "$@"`;
/** Unpack, install without lifecycle scripts, and write the whole tree back on stdout. */
const INSTALL_SCRIPT =
  `tar -xf - -C ${APP_DIR} && cd ${APP_DIR} && npm "$1" --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error >&2 && tar -cf - -C ${APP_DIR} .`;

export interface PreviewLabels {
  /** Where the preview came from, for the sweep and the pages. Each value is a short safe token. */
  execution?: string;
  task?: string;
  prototype?: string;
}

interface Common {
  id: string;
  uid: number;
  gid: number;
  image: string;
  limits: DockerLimits;
}

function checkCommon(o: Common): void {
  if (!PREVIEW_ID_RE.test(o.id)) throw new PreviewError(`invalid preview id ${JSON.stringify(o.id)}`);
  if (!IMAGE_RE.test(o.image)) throw new SandboxRequestError(`invalid image reference ${JSON.stringify(o.image)}`);
  for (const n of [o.uid, o.gid]) if (!Number.isInteger(n) || n < 0) throw new SandboxRequestError("uid and gid must be non-negative integers");
  if (o.uid === 0) throw new SandboxRequestError("a preview never runs as root");
  if (!validMemory(o.limits.memory) || !validCpus(o.limits.cpus) || !validPids(o.limits.pids)) throw new SandboxRequestError("invalid docker resource limits");
}

/** Container name for a preview id. */
export function previewContainerName(id: string): string {
  const name = `rt-preview-${id.slice(4)}`;
  if (!PREVIEW_NAME_RE.test(name)) throw new PreviewError(`invalid preview id ${JSON.stringify(id)}`);
  return name;
}

/** The forwarder container and the internal network of a preview. */
export const forwarderName = (id: string): string => `${previewContainerName(id)}-fwd`;
export const previewNetworkName = (id: string): string => `rt-pvnet-${previewContainerName(id).slice(11)}`;

/** `docker network create` argv: internal, so nothing on it can reach beyond it. */
export function buildNetworkCreateArgs(id: string): string[] {
  return ["network", "create", "--internal", "--label", `${PREVIEW_NET_LABEL}=${id}`, previewNetworkName(id)];
}

function appTmpfs(o: Common, size: string): string {
  return `${APP_DIR}:rw,nosuid,nodev,size=${size},uid=${o.uid},gid=${o.gid},mode=0755`;
}

export interface PreviewRunOptions extends Common {
  script: PreviewScript;
  port: number;
  labels?: PreviewLabels;
  /** Size of the tmpfs the snapshot is unpacked into. */
  appSize?: string;
}

/**
 * The `docker run` argv of a dev-server container. Stdin carries the tar snapshot (-i). It joins the
 * preview's internal network only and publishes nothing; the server is told to listen on all
 * interfaces inside the container through HOST and PORT.
 */
export function buildPreviewRunArgs(o: PreviewRunOptions): string[] {
  checkCommon(o);
  const port = validatePort(o.port);
  const args = [
    "run", "--rm", "-i", "--init",
    "--log-driver", "none",
    "--name", previewContainerName(o.id),
    "--label", `${PREVIEW_LABEL}=${o.id}`,
    "--label", `${PREVIEW_HOST_LABEL}=${hostname()}`,
  ];
  for (const [key, value] of Object.entries({ execution: o.labels?.execution, task: o.labels?.task, prototype: o.labels?.prototype })) {
    if (value === undefined) continue;
    if (!LABEL_VALUE_RE.test(value)) throw new PreviewError(`invalid ${key} label ${JSON.stringify(value.slice(0, 40))}`);
    args.push("--label", `${PREVIEW_LABEL}-${key}=${value}`);
  }
  args.push(
    ...hardeningArgs({ network: previewNetworkName(o.id), uid: o.uid, gid: o.gid, limits: o.limits, extraTmpfs: [appTmpfs(o, o.appSize ?? "1g")] }),
    "--network-alias", SERVER_ALIAS,
    "-e", `PORT=${port}`,
    "-e", "HOST=0.0.0.0",
    "-e", "HOSTNAME=0.0.0.0",
    "-e", "NODE_ENV=development",
    "-w", APP_DIR,
    o.image,
    "sh", "-c", UNPACK_THEN_EXEC, "sh", "npm", "run", o.script
  );
  return args;
}

export interface InstallRunOptions extends Common {
  /** The egress network from ensureEgressNetwork, and the proxy URL on it. */
  network: string;
  proxyUrl: string;
  /** `ci` when the snapshot has a lockfile, else `install`. */
  command: "ci" | "install";
}

const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

/** The install step: only the egress proxy (npm registry) is reachable, lifecycle scripts are off, no port is published. */
export function buildInstallRunArgs(o: InstallRunOptions): string[] {
  checkCommon(o);
  if (o.command !== "ci" && o.command !== "install") throw new PreviewError("install command must be ci or install");
  const args = [
    "run", "--rm", "-i", "--init",
    "--log-driver", "none",
    "--name", `rt-preview-install-${o.id.slice(4)}`,
    "--label", `${PREVIEW_LABEL}=${o.id}`,
    "--label", `${PREVIEW_HOST_LABEL}=${hostname()}`,
    ...hardeningArgs({ network: o.network, uid: o.uid, gid: o.gid, limits: o.limits, extraTmpfs: [appTmpfs(o, "2g")] }),
  ];
  for (const k of PROXY_VARS) args.push("-e", `${k}=${o.proxyUrl}`);
  args.push("-w", APP_DIR, o.image, "sh", "-c", INSTALL_SCRIPT, "sh", o.command);
  return args;
}

/** The container name of an install step. */
export const installContainerName = (id: string): string => `rt-preview-install-${id.slice(4)}`;

/** What the forwarder runs: accept on PORT, pipe each connection to the dev server on the internal network. Fixed text. */
const FORWARDER_SCRIPT =
  `const net=require("net"),p=Number(process.env.FWD_PORT),a=process.env.FWD_TARGET;` +
  `net.createServer(c=>{const u=net.connect(p,a);c.pipe(u);u.pipe(c);const x=()=>{c.destroy();u.destroy()};c.on("error",x);u.on("error",x);c.on("close",x);u.on("close",x)}).listen(p,"0.0.0.0")`;

const FORWARDER_LIMITS: DockerLimits = { memory: "128m", cpus: "0.5", pids: 64 };

/**
 * The `docker create` argv of the forwarder. It starts on the default bridge, where Docker can
 * publish `127.0.0.1::<port>` (loopback only; Docker picks the host port); the caller then connects
 * it to the preview's internal network and starts it.
 */
export function buildForwarderCreateArgs(o: Common & { port: number }): string[] {
  checkCommon(o);
  const port = validatePort(o.port);
  return [
    "create", "--rm", "--init",
    "--log-driver", "none",
    "--name", forwarderName(o.id),
    "--label", `${PREVIEW_LABEL}=${o.id}`,
    "--label", `${PREVIEW_HOST_LABEL}=${hostname()}`,
    ...hardeningArgs({ network: "bridge", uid: o.uid, gid: o.gid, limits: FORWARDER_LIMITS }),
    "-e", `FWD_PORT=${port}`,
    "-e", `FWD_TARGET=${SERVER_ALIAS}`,
    "-p", `127.0.0.1::${port}`,
    o.image,
    "node", "-e", FORWARDER_SCRIPT,
  ];
}

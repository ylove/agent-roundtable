import { SecureServer, type Route } from "../http/secure-server.js";
import { sanitizeSessionId } from "../prototypes/sandbox.js";
import { livePreviews, previewLabel, previewOrigins, withFrameSrc } from "../previews/embed.js";
import { APP_CSP, openInBrowser } from "../prototypes/board.js";
import { MAX_FILES, MAX_TOTAL_BYTES, validatePath, type PrototypeFile } from "../prototypes/parse.js";
import type { Seat, TableEvent, TableObserver } from "./events.js";
import { getPrototypeFiles, getPrototypeScreenshot } from "./replay.js";
import { ROOM_CSP, ROOM_CSS, ROOM_HTML, ROOM_JS } from "./room-assets.js";

type EventOf<T extends TableEvent["type"]> = Extract<TableEvent, { type: T }>;
export interface RoomState {
  id?: string;
  topic: string;
  seats: Seat[];
  prototypes: (EventOf<"prototype"> & { version: number })[];
  history: (EventOf<"prototype"> & { version: number })[];
  browser?: { team: "A" | "B"; version: number };
  assessments: EventOf<"assessment">[];
  dissents: EventOf<"dissent">[];
  turns: EventOf<"turn">[];
  usage: EventOf<"usage">;
  end?: EventOf<"end">;
}

/** The previews that belong to this duel (their prototype directory carries the duel id); none before a duel starts. */
export function duelPreviewsOf<T extends { source: { duel?: string } }>(duelId: string | undefined, records: readonly T[]): T[] {
  if (!duelId) return [];
  const mine = sanitizeSessionId(duelId);
  return records.filter(r => r.source.duel === mine);
}

export function createRoomState(): RoomState {
  return { topic: "", seats: [], prototypes: [], history: [], assessments: [], dissents: [], turns: [], usage: { type: "usage", perSeat: [], totalCostUsd: 0 } };
}

export interface RoomOptions {
  state?: RoomState;
  open?: boolean;
  hold?: boolean;
  /** A live duel's controls: the room offers stop, resume and the human judge's choice through them. None for replays. */
  controls?: import("./events.js").DuelControls;
}
export interface DuelRoom {
  observer: TableObserver;
  url: string;
  state: RoomState;
  close(): Promise<void>;
  /** Supply prototype bytes when feeding events from another process. */
  setPrototypeFiles(team: "A" | "B", files: PrototypeFile[]): void;
}

/** Loopback capability room. No URL is ever used as a filesystem path. */
export async function startRoom({ state = createRoomState(), open = false, hold = true }: RoomOptions = {}): Promise<DuelRoom> {
  const files = new Map<"A" | "B", Map<string, string>>();
  const versions = new Map<string, Map<string, string>>();
  const shots = new Map<string, Buffer>();
  let keeper: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const setPrototypeFiles = (team: "A" | "B", input: PrototypeFile[]) => {
    const map = new Map<string, string>();
    let total = 0;
    if (input.length > MAX_FILES) throw new Error("Invalid room prototype file.");
    for (const file of input) {
      total += typeof file.content === "string" ? Buffer.byteLength(file.content) : 0;
      if (validatePath(file.path) || typeof file.content !== "string" || total > MAX_TOTAL_BYTES || map.has(file.path)) {
        throw new Error("Invalid room prototype file.");
      }
      map.set(file.path, file.content);
    }
    files.set(team, map);
  };
  const duelPreviews = () => duelPreviewsOf(state.id, livePreviews());
  const routes: Route[] = [
    { path: "/", handler: ctx => ctx.html(200, ROOM_HTML, withFrameSrc(ROOM_CSP, previewOrigins(duelPreviews()))) },
    { path: "/previews.json", handler: ctx => ctx.json(200, duelPreviews().map(r => ({ id: r.id, origin: r.origin, label: previewLabel(r) }))) },
    { path: "/room.js", handler: ctx => ctx.send(200, ROOM_JS, "text/javascript; charset=utf-8") },
    { path: "/room.css", handler: ctx => ctx.send(200, ROOM_CSS, "text/css; charset=utf-8") },
    { path: "/state.json", handler: ctx => ctx.json(200, state) },
    { path: /^\/shot\/([AB])\/(\d+)\.png$/, handler: ctx => {
      const key = `${ctx.match![1]}/${ctx.match![2]}`;
      const shot = shots.get(key);
      if (!shot || !state.history.some(p => `${p.team}/${p.version}` === key)) return ctx.notFound();
      ctx.send(200, shot, "image/png");
    } },
    { path: /^\/diff\/([AB])\.json$/, handler: ctx => {
      const history = state.history.filter(p => p.team === ctx.match![1] && p.ok);
      const before = history.at(-2), after = history.at(-1);
      if (!before || !after) return ctx.notFound();
      const path = after.files[0]?.path;
      const a = versions.get(`${before.team}/${before.version}`)?.get(path) ?? "";
      const b = versions.get(`${after.team}/${after.version}`)?.get(path) ?? "";
      ctx.json(200, { path, from: before.version, to: after.version, lines: lineDiff(a, b) });
    } },
    { path: /^\/p\/([AB])\/(.+)$/, handler: ctx => {
      const team = ctx.match![1] as "A" | "B";
      let path = ctx.match![2];
      const versioned = ctx.query.has("v") ? null : /^(\d+)\/(.+)$/.exec(path);
      const requested = versioned ? Number(versioned[1]) : ctx.query.has("v") ? Number(ctx.query.get("v")) : undefined;
      if (versioned) path = versioned[2];
      // Reject encoded separators, dot segments, and all unknown names before looking up bytes.
      if (path.includes("%") || validatePath(path)) return ctx.notFound();
      const prototype = (requested === undefined ? state.prototypes : state.history).find(p => p.team === team && p.ok && (requested === undefined || p.version === requested));
      if (!prototype?.files.some(file => file.path === path)) return ctx.notFound();
      const content = (requested === undefined ? files.get(team) : versions.get(`${team}/${requested}`))?.get(path);
      if (content === undefined) return ctx.notFound();
      // Only a web artifact is ever served as a page. Everything else is inert text for the room to display.
      if (!prototype.kind || prototype.kind === "web") {
        if (path !== "index.html") return ctx.notFound();
        ctx.send(200, content, "text/html; charset=utf-8", { "Content-Security-Policy": APP_CSP, "X-Frame-Options": "SAMEORIGIN" });
      } else ctx.send(200, content, "text/plain; charset=utf-8", { "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" });
    } },
  ];
  const server = await SecureServer.start({ name: "Duel room", allowProxied: path => /^\/p\/[AB]\//.test(path), routes: routes.map(route => ({
    ...route,
    handler: ctx => {
      // SecureServer normalizes URLs. Check the raw target too, so dot segments cannot
      // turn a prototype request into a request for the room's state or scripts.
      let target = (ctx.req.url ?? "").split("?")[0];
      try { target = decodeURIComponent(target); } catch { return ctx.notFound(); }
      if (target.includes("\\") || target.split("/").some(segment => segment === "." || segment === "..")) return ctx.notFound();
      return route.handler(ctx);
    },
  })) });
  const onExit = () => server.closeNow();
  const onInterrupt = () => { void close(); };
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (keeper) clearInterval(keeper);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("exit", onExit);
    files.clear(); versions.clear(); shots.clear();
    await server.close();
  }
  process.once("exit", onExit);
  const observer: TableObserver = { onEvent(event) {
    if (closed) return;
    switch (event.type) {
      case "start":
        if (keeper) { clearInterval(keeper); keeper = undefined; }
        process.removeListener("SIGINT", onInterrupt);
        Object.assign(state, createRoomState(), { id: event.id, topic: event.topic, seats: event.seats });
        delete state.end;
        files.clear(); versions.clear(); shots.clear();
        delete state.browser;
        break;
      case "turn":
        state.turns.push(event);
        break;
      case "prototype": {
        const content = getPrototypeFiles(event);
        if (content.length) setPrototypeFiles(event.team, content);
        if (!event.ok) files.delete(event.team);
        const version = event.version ?? state.history.filter(p => p.team === event.team).length + 1;
        const prototype = { ...event, version };
        state.history.push(prototype);
        if (event.ok && files.has(event.team)) versions.set(`${event.team}/${version}`, new Map(files.get(event.team)!));
        const shot = getPrototypeScreenshot(event);
        if (shot) { shots.set(`${event.team}/${version}`, shot); state.browser = { team: event.team, version }; }
        state.prototypes = [...state.prototypes.filter(p => p.team !== event.team), prototype];
        break;
      }
      case "assessment": {
        const version = event.version ?? state.prototypes.find(p => p.team === event.team)?.version;
        state.assessments.push({ ...event, ...(version && { version }) });
        if (version && shots.has(`${event.team}/${version}`)) state.browser = { team: event.team, version };
        break;
      }
      case "dissent": state.dissents.push(event); break;
      case "usage": state.usage = event; break;
      case "end":
        state.end = event;
        if (hold && !keeper) {
          keeper = setInterval(() => {}, 60_000);
          process.once("SIGINT", onInterrupt);
        }
        break;
    }
  } };
  if (open) openInBrowser(server.url);
  return { observer, url: server.url, state, close, setPrototypeFiles };
}

/** A bounded line diff; large changed blocks use removals then additions. */
export function lineDiff(before: string, after: string): { kind: "same" | "remove" | "add"; text: string }[] {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const old = a.slice(start, a.length - end), next = b.slice(start, b.length - end);
  const lines: ReturnType<typeof lineDiff> = a.slice(0, start).map(text => ({ kind: "same", text }));
  const add = (kind: "same" | "remove" | "add", text: string) => lines.push({ kind, text });
  if ((old.length + 1) * (next.length + 1) <= 1_000_000) {
    const width = next.length + 1;
    const lcs = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
      lcs[i * width + j] = old[i] === next[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { add("same", old[i++]); j++; }
      else if (i < old.length && (j === next.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) add("remove", old[i++]);
      else add("add", next[j++]);
    }
  } else {
    for (const text of old) add("remove", text);
    for (const text of next) add("add", text);
  }
  for (const text of a.slice(a.length - end)) add("same", text);
  return lines;
}

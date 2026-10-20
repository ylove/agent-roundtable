import { SecureServer, type Route } from "../http/secure-server.js";
import { APP_CSP, openInBrowser } from "../prototypes/board.js";
import { MAX_FILES, MAX_TOTAL_BYTES, validatePath, type PrototypeFile } from "../prototypes/parse.js";
import type { Seat, TableEvent, TableObserver } from "./events.js";
import { getPrototypeFiles } from "./replay.js";
import { ROOM_CSP, ROOM_CSS, ROOM_HTML, ROOM_JS } from "./room-assets.js";

type EventOf<T extends TableEvent["type"]> = Extract<TableEvent, { type: T }>;
export interface RoomState {
  id?: string;
  topic: string;
  seats: Seat[];
  prototypes: (EventOf<"prototype"> & { version: number })[];
  assessments: EventOf<"assessment">[];
  dissents: EventOf<"dissent">[];
  turns: EventOf<"turn">[];
  usage: EventOf<"usage">;
  end?: EventOf<"end">;
}

export function createRoomState(): RoomState {
  return { topic: "", seats: [], prototypes: [], assessments: [], dissents: [], turns: [], usage: { type: "usage", perSeat: [], totalCostUsd: 0 } };
}

export interface RoomOptions { state?: RoomState; open?: boolean; hold?: boolean }
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
  let version = 0;
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
  const routes: Route[] = [
    { path: "/", handler: ctx => ctx.html(200, ROOM_HTML, ROOM_CSP) },
    { path: "/room.js", handler: ctx => ctx.send(200, ROOM_JS, "text/javascript; charset=utf-8") },
    { path: "/room.css", handler: ctx => ctx.send(200, ROOM_CSS, "text/css; charset=utf-8") },
    { path: "/state.json", handler: ctx => ctx.json(200, state) },
    { path: /^\/p\/([AB])\/(.+)$/, handler: ctx => {
      const team = ctx.match![1] as "A" | "B";
      const path = ctx.match![2];
      // Reject encoded separators, dot segments, and all unknown names before looking up bytes.
      if (path.includes("%") || validatePath(path)) return ctx.notFound();
      const prototype = state.prototypes.find(p => p.team === team && p.ok);
      if (!prototype?.files.some(file => file.path === path)) return ctx.notFound();
      const content = files.get(team)?.get(path);
      if (content === undefined) return ctx.notFound();
      // Only a web artifact is ever served as a page. Everything else is inert text for the room to display.
      if (!prototype.kind || prototype.kind === "web") {
        if (path !== "index.html") return ctx.notFound();
        ctx.send(200, content, "text/html; charset=utf-8", { "Content-Security-Policy": APP_CSP, "X-Frame-Options": "SAMEORIGIN" });
      } else ctx.send(200, content, "text/plain; charset=utf-8", { "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" });
    } },
  ];
  const server = await SecureServer.start({ name: "Duel room", routes: routes.map(route => ({
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
    files.clear();
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
        files.clear();
        break;
      case "turn":
        state.turns.push(event);
        break;
      case "prototype": {
        const content = getPrototypeFiles(event);
        if (content.length) setPrototypeFiles(event.team, content);
        if (!event.ok) files.delete(event.team);
        state.prototypes = [...state.prototypes.filter(p => p.team !== event.team), { ...event, version: ++version }];
        break;
      }
      case "assessment": state.assessments.push(event); break;
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

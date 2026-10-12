// Text renderings of prototypes: public Markdown references, agent-history stubs, end-of-session
// outcomes, and mermaid.live links. Public renderings never carry a local address.
import { deflateSync } from "node:zlib";
import { diagramFile, mermaidSourceOf } from "./parse.js";
import type { PrototypeFile, PrototypeRecord, VerdictEntry } from "./types.js";

export const PUBLIC_SOURCE_CAP_BYTES = 8 * 1024;

/**
 * A https://mermaid.live/view link that opens the diagram. Same encoding as the live editor's
 * "pako" serde: JSON state -> zlib deflate (level 9) -> URL-safe base64 without padding.
 */
export function mermaidLiveUrl(code: string): string {
  const state = {
    code,
    mermaid: '{\n  "theme": "default"\n}',
    autoSync: true,
    rough: false,
    updateDiagram: true,
  };
  const packed = deflateSync(Buffer.from(JSON.stringify(state), "utf8"), { level: 9 }).toString("base64url");
  return `https://mermaid.live/view#pako:${packed}`;
}

const LANGS: Record<string, string> = {
  html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", ts: "typescript", tsx: "tsx", json: "json", sql: "sql", tf: "hcl", hcl: "hcl",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  svg: "xml", md: "markdown", mmd: "mermaid", mermaid: "mermaid", txt: "text", graphql: "graphql",
  gql: "graphql", prisma: "prisma", proto: "protobuf", ini: "ini", csv: "csv",
};

export function languageFor(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? LANGS[base.slice(i + 1).toLowerCase()] ?? "" : "";
}

/** A fenced block whose fence is longer than any backtick run in the content. */
export function fence(content: string, lang = ""): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${content.replace(/\n$/, "")}\n${f}`;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function sliceBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return s.slice(0, end);
}

const LOCAL_URL_RE = /\b(?:https?|wss?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s)"'`<>\]]*/gi;

/** Remove loopback URLs and addresses (public renderings must never carry one). */
export function scrubLocalAddresses(s: string): string {
  return s
    .replace(LOCAL_URL_RE, "[local URL removed]")
    .replace(/\blocalhost\b/gi, "local-host")
    .replace(/\b127(?:\.\d{1,3}){3}\b/g, "[loopback address]");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const oneLine = (s: string, max = 300) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

function verdictList(verdicts: VerdictEntry[], withReasons = false): string {
  if (verdicts.length === 0) return "none";
  return verdicts
    .map((v) => `${v.assessor} ${v.verdict}${withReasons && v.reason ? ` (${oneLine(v.reason, 200)})` : ""}`)
    .join(", ");
}

/** Mermaid source of a diagram prototype, or null. */
function diagramSource(files: PrototypeFile[]): string | null {
  const f = diagramFile(files);
  return f ? mermaidSourceOf(f.content) : null;
}

/** Fenced files under a shared byte cap (Infinity for no cap). */
function renderFiles(files: PrototypeFile[], capBytes: number): string[] {
  const out: string[] = [];
  let budget = capBytes;
  let omitted = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const size = Buffer.byteLength(f.content, "utf8");
    if (budget <= 0) {
      omitted += size;
      continue;
    }
    let body = f.content;
    if (size > budget) {
      body = sliceBytes(f.content, budget);
      omitted += size - Buffer.byteLength(body, "utf8");
    }
    budget -= Buffer.byteLength(body, "utf8");
    out.push(`\`${f.path}\``, fence(body, languageFor(f.path)));
  }
  if (omitted > 0) out.push(`…[truncated: ${omitted} more bytes]`);
  return out;
}

/**
 * Markdown reference for a public channel: heading, kind, files, proposer, demo, then the (redacted)
 * source capped at about 8 KB. Diagrams also get a mermaid.live link. Never contains a local address.
 */
export function renderPublicPrototype(p: PrototypeRecord): string {
  const parts: string[] = [
    `**Prototype ${p.label} — ${oneLine(p.title, 120)}**`,
    `_${p.kind} · ${plural(p.fileCount, "file")} · proposed by ${p.proposer}_`,
  ];
  if (p.demo.trim()) parts.push("**Demo walkthroughs**", p.demo.trim());
  if (p.files.length === 0) {
    parts.push("_(source no longer available: destroyed after assessment)_");
  } else if (p.kind === "diagram") {
    const code = diagramSource(p.files);
    if (code) parts.push(`View diagram: ${mermaidLiveUrl(scrubLocalAddresses(code))}`);
    parts.push(...renderFiles(p.files, PUBLIC_SOURCE_CAP_BYTES));
  } else if (p.kind === "text") {
    parts.push("**Draft 1**", ...renderFiles(p.files, PUBLIC_SOURCE_CAP_BYTES));
  } else {
    parts.push(...renderFiles(p.files, PUBLIC_SOURCE_CAP_BYTES));
  }
  return scrubLocalAddresses(parts.join("\n\n"));
}

function statusPhrase(p: PrototypeRecord): string {
  const verdicts = `verdicts: ${verdictList(p.verdicts)}`;
  switch (p.status) {
    case "live":
      return `live, under assessment; ${verdicts}`;
    case "awaiting_decision":
      return `destroyed after assessment; ${verdicts}; awaiting the proposer's decision`;
    case "shortlisted":
      return `destroyed after assessment; ${verdicts}; decision: SHORTLIST`;
    case "scrapped":
      return `destroyed after assessment; ${verdicts}; decision: SCRAP`;
    case "revised":
      return `destroyed after assessment; ${verdicts}; decision: REVISE${p.supersededBy ? ` (superseded by ${p.supersededBy})` : ""}`;
    case "expired":
      return `destroyed when its time limit ran out; verdicts so far: ${verdictList(p.verdicts)}`;
    case "closed":
      return `destroyed when the session ended; ${verdicts}${p.decision ? `; decision: ${p.decision.decision}` : ""}`;
  }
}

/** One-line stand-in for a resolved prototype in agent-facing history. */
export function renderStub(p: PrototypeRecord): string {
  const title = oneLine(p.title, 120).replace(/"/g, "'");
  return `[Prototype ${p.label} "${title}" (${p.kind}, ${plural(p.fileCount, "file")}) — ${statusPhrase(p)}]`;
}

const STATUS_TEXT: Record<PrototypeRecord["status"], string> = {
  live: "live",
  awaiting_decision: "awaiting decision",
  shortlisted: "shortlisted",
  scrapped: "scrapped",
  revised: "revised",
  expired: "expired (time limit)",
  closed: "closed at session end",
};

function outcomeLine(p: PrototypeRecord): string {
  const decision = p.decision ? `${p.decision.decision}${p.decision.reason ? ` (${oneLine(p.decision.reason, 200)})` : ""}` : "none";
  let status = STATUS_TEXT[p.status];
  if (p.status === "revised" && p.supersededBy) status += ` (superseded by ${p.supersededBy})`;
  return (
    `- **${p.label}** · ${p.proposer} · ${p.kind} · "${oneLine(p.title, 120)}" · ` +
    `verdicts: ${verdictList(p.verdicts, true)} · decision: ${decision} · status: ${status}`
  );
}

function shortlistSection(p: PrototypeRecord): string {
  const parts: string[] = [
    `### ${p.label} — ${oneLine(p.title, 120)}`,
    `_${p.kind} · ${plural(p.fileCount, "file")} · proposed by ${p.proposer}_`,
    `Verdicts: ${verdictList(p.verdicts, true)}`,
  ];
  if (p.decision?.reason) parts.push(`Why it was shortlisted: ${oneLine(p.decision.reason, 500)}`);
  if (p.demo.trim()) parts.push("**Demo walkthroughs**", p.demo.trim());
  if (p.kind === "diagram") {
    const code = diagramSource(p.files);
    if (code) parts.push(`View diagram: ${mermaidLiveUrl(code)}`);
  }
  if (p.kind === "text") parts.push("**Draft**");
  if (p.files.length) parts.push(...renderFiles(p.files, Infinity));
  else parts.push("_(source not available)_");
  return parts.join("\n\n");
}

/** End-of-session Markdown: one outcome line per version, then the full shortlist for the human. */
export function renderOutcomesMarkdown(outcomes: PrototypeRecord[], shortlist: PrototypeRecord[]): string {
  const out: string[] = ["## Prototype outcomes", ""];
  if (outcomes.length === 0) out.push("No prototypes were proposed in this session.");
  else out.push(...outcomes.map(outcomeLine));
  out.push("", "## Shortlist for the human", "");
  if (shortlist.length === 0) out.push("None of the prototypes were shortlisted.");
  else out.push(shortlist.map(shortlistSection).join("\n\n"));
  out.push("", "The session is complete: the human may now give feedback on these proposals.");
  return out.join("\n");
}

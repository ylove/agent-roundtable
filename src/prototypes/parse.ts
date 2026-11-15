// Parsing of the prototype protocol agents emit: one <prototype> block per turn, verdict lines from
// assessors, decision lines from the proposer. Never throws on agent input: problems come back as
// structured errors (shown to the agent) or warnings.

export type PrototypeKind = "web" | "code" | "diagram" | "text";
export type Verdict = "APPROVE" | "REVISE" | "REJECT" | "UNCLEAR";
export type Decision = "REVISE" | "SCRAP" | "SHORTLIST";

export const PROTOTYPE_KINDS: readonly PrototypeKind[] = ["web", "code", "diagram", "text"];
export const MAX_FILES = 10;
export const MAX_PARSE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024;
export const MAX_PATH_LENGTH = 120;
export const MAX_TITLE_LENGTH = 120;
export const MAX_DEMO_LENGTH = 20_000;
/** Relative, at most four segments, each starting with a letter or digit (so no ".", ".." or dotfiles). */
export const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;

export interface PrototypeFile {
  path: string;
  content: string;
}

export interface ParsedPrototype {
  title: string;
  kind: PrototypeKind;
  /** Web prototypes: the HTML file the viewer opens. */
  entry?: string;
  /** Normalized id ("P1") of the prototype this block revises. */
  revises?: string;
  files: PrototypeFile[];
  /** The <demo> walkthroughs ("" when absent). */
  demo: string;
}

export type ParseResult =
  | { found: false; warnings: string[] }
  | { found: true; ok: true; prototype: ParsedPrototype; warnings: string[] }
  | { found: true; ok: false; error: string; warnings: string[] };

// ----------------------------------------------------------------------------
// Block extraction
// ----------------------------------------------------------------------------

const ATTRS = String.raw`((?:\s+[^\s=>"'/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*`;
// The body never contains another opening tag, so prose that mentions <prototype> before a real
// block cannot swallow it. A backtick right before the tag marks an inline-code mention, not a block.
const BLOCK_SOURCE = String.raw`(?<!\x60)<prototype${ATTRS}>((?:(?!<prototype[\s>])[\s\S])*?)<\/prototype\s*>`;
const blockRe = () => new RegExp(BLOCK_SOURCE, "gi");
const UNCLOSED_RE = /(?:^|\n)[ \t>]*<prototype[\s>]/i;
const FILE_OPEN_RE = /<file(?=[\s>/])/gi;
const FILE_CLOSE_RE = /<\/file\s*>/gi;
const DEMO_RE = /<demo(?:\s[^>]*)?>([\s\S]*?)<\/demo\s*>/i;
const ATTR_RE = /([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Attribute map with lower-cased names (any order, single, double or no quotes). */
export function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Trim one leading and one trailing newline, then strip a single code fence wrapping the whole body. */
export function cleanFileContent(raw: string): string {
  let s = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const fence = /^\s*(`{3,}|~{3,})[^\n`]*\r?\n([\s\S]*?)\r?\n?[ \t]*\1[ \t]*$/.exec(s);
  if (fence) {
    const inner = fence[2];
    const marker = fence[1];
    // Only a single wrapping fence: an inner line opening the same fence means the body has its own fences.
    const innerOpens = inner.split(/\r?\n/).some((line) => line.trimStart().startsWith(marker));
    if (!innerOpens) s = inner;
  }
  return s;
}

const ext = (path: string): string => {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};
const isHtml = (path: string) => ext(path) === "html" || ext(path) === "htm";
const isMermaidExt = (path: string) => ext(path) === "mmd" || ext(path) === "mermaid";

/** Validate one relative path. Returns an error message, or null when the path is safe. */
export function validatePath(path: string): string | null {
  if (typeof path !== "string" || !path) return "a <file> element has no path attribute";
  if (path.length > MAX_PATH_LENGTH) return `path "${path.slice(0, 40)}…" is longer than ${MAX_PATH_LENGTH} characters`;
  if (!PATH_RE.test(path)) {
    return (
      `invalid file path "${path}": use a relative path of at most 4 segments, each starting with a letter or digit ` +
      `and using only letters, digits, ".", "_" and "-" (no "..", no leading "/", no backslashes)`
    );
  }
  return null;
}

const MERMAID_TYPES = [
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "classDiagram-v2", "stateDiagram", "stateDiagram-v2",
  "erDiagram", "journey", "gantt", "pie", "quadrantChart", "requirementDiagram", "gitGraph", "mindmap",
  "timeline", "sankey", "sankey-beta", "xychart", "xychart-beta", "block", "block-beta", "packet", "packet-beta",
  "architecture", "architecture-beta", "kanban", "radar", "radar-beta", "treemap", "treemap-beta", "zenuml",
  "C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
];
const MERMAID_START = new RegExp(`^(?:${MERMAID_TYPES.map((t) => t.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&")).join("|")})(?:\\s|$|;)`);

/** True when the text is Mermaid source (optional front matter, %% comments and %%{init}%% directives allowed). */
export function isMermaidSource(text: string): boolean {
  let s = text.replace(/^﻿/, "").trimStart();
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (fm) s = s.slice(fm[0].length);
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("%%")) continue;
    return MERMAID_START.test(t);
  }
  return false;
}

/** The Mermaid source in a diagram file: the content itself, or the first ```mermaid fence of a .md file. */
export function mermaidSourceOf(content: string): string | null {
  if (isMermaidSource(content)) return content;
  const m = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n[ \t]*\2/i.exec(content);
  if (m && isMermaidSource(m[3])) return m[3];
  return null;
}

/** The single Mermaid file of a diagram prototype, or null. */
export function diagramFile(files: PrototypeFile[]): PrototypeFile | null {
  const candidates = files.filter(
    (f) => isMermaidExt(f.path) || (ext(f.path) === "md" && mermaidSourceOf(f.content) !== null)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function inferKind(files: PrototypeFile[]): PrototypeKind {
  if (files.some((f) => isHtml(f.path))) return "web";
  if (files.length === 1 && isMermaidExt(files[0].path)) return "diagram";
  if (files.length === 1 && (ext(files[0].path) === "md" || ext(files[0].path) === "txt")) return "text";
  return "code";
}

function normalizeId(raw: string): string | null {
  const m = /^\s*P?\s*(\d{1,4})(?:\s*v\s*\d+)?\s*$/i.exec(raw);
  return m ? `P${parseInt(m[1], 10)}` : null;
}

/** Validate a parsed block. Returns an error message or null. Also resolves `entry` for web prototypes. */
export function validatePrototype(p: ParsedPrototype): string | null {
  if (p.files.length === 0) return 'a prototype needs at least one <file path="…"> element';
  if (p.files.length > MAX_FILES) return `a prototype may have at most ${MAX_FILES} files (got ${p.files.length})`;
  const seen = new Set<string>();
  let total = 0;
  for (const f of p.files) {
    const err = validatePath(f.path);
    if (err) return err;
    const key = f.path.toLowerCase();
    if (seen.has(key)) return `duplicate file path "${f.path}"`;
    seen.add(key);
    total += Buffer.byteLength(f.content, "utf8");
  }
  if (total > MAX_TOTAL_BYTES) {
    return `the files total ${total} bytes; the limit is ${MAX_TOTAL_BYTES} bytes (100 KB). Scale the prototype down.`;
  }
  switch (p.kind) {
    case "web": {
      const htmls = p.files.filter((f) => isHtml(f.path));
      if (p.entry !== undefined) {
        const err = validatePath(p.entry);
        if (err) return `entry: ${err}`;
        if (!isHtml(p.entry)) return `entry "${p.entry}" must be an .html file`;
        if (!p.files.some((f) => f.path === p.entry)) return `entry "${p.entry}" is not one of the files`;
      } else if (p.files.some((f) => f.path === "index.html")) {
        p.entry = "index.html";
      } else if (htmls.length === 1) {
        p.entry = htmls[0].path;
      } else {
        return htmls.length === 0
          ? "a web prototype needs an .html file (index.html, or name it with entry=\"…\")"
          : 'a web prototype with several .html files needs entry="…" or an index.html';
      }
      return null;
    }
    case "diagram": {
      const candidates = p.files.filter((f) => isMermaidExt(f.path) || ext(f.path) === "md");
      const mermaid = p.files.filter(
        (f) => isMermaidExt(f.path) || (ext(f.path) === "md" && mermaidSourceOf(f.content) !== null)
      );
      if (mermaid.length > 1) return "a diagram prototype needs exactly one Mermaid file (.mmd, .mermaid or .md)";
      if (mermaid.length === 0) {
        return candidates.length === 0
          ? "a diagram prototype needs exactly one Mermaid file (.mmd, .mermaid or .md)"
          : `"${candidates[0].path}" does not contain Mermaid source (start with a diagram type such as flowchart TD or sequenceDiagram)`;
      }
      if (mermaidSourceOf(mermaid[0].content) === null) {
        return `"${mermaid[0].path}" does not contain Mermaid source (start with a diagram type such as flowchart TD or sequenceDiagram)`;
      }
      p.entry = undefined;
      return null;
    }
    case "text":
      if (p.files.length !== 1) return `a text prototype needs exactly one file (got ${p.files.length})`;
      p.entry = undefined;
      return null;
    default:
      p.entry = undefined;
      return null;
  }
}

/**
 * Parse the first <prototype> block in an agent's turn. Extra blocks are ignored with a warning.
 * found=false means the turn has no block; found=true with ok=false carries a validation error.
 */
export function parsePrototypeBlock(text: string): ParseResult {
  const warnings: string[] = [];
  const src = String(text ?? "");
  if (Buffer.byteLength(src, "utf8") > MAX_PARSE_BYTES) {
    return { found: true, ok: false, error: "prototype input exceeds size limit", warnings };
  }
  const matches = [...src.matchAll(blockRe())];
  if (matches.length === 0) {
    if (UNCLOSED_RE.test(src)) {
      return {
        found: true,
        ok: false,
        error: "the prototype block is not closed (or was cut off by the reply length cap): end it with </prototype> and keep it compact",
        warnings,
      };
    }
    return { found: false, warnings };
  }
  if (matches.length > 1) {
    warnings.push(`Only one prototype per turn is used; ${matches.length - 1} extra <prototype> block(s) were ignored.`);
  }
  const [, rawAttrs, body] = matches[0];
  const attrs = parseAttributes(rawAttrs ?? "");

  let kind: PrototypeKind | undefined;
  if (attrs.kind !== undefined && attrs.kind.trim() !== "") {
    const k = attrs.kind.trim().toLowerCase();
    if (!(PROTOTYPE_KINDS as readonly string[]).includes(k)) {
      return { found: true, ok: false, error: `unknown kind "${attrs.kind}" (use web, code, diagram or text)`, warnings };
    }
    kind = k as PrototypeKind;
  }

  let revises: string | undefined;
  if (attrs.revises !== undefined && attrs.revises.trim() !== "") {
    const id = normalizeId(attrs.revises);
    if (!id) return { found: true, ok: false, error: `revises="${attrs.revises}" is not a prototype id like P1`, warnings };
    revises = id;
  }

  const files: PrototypeFile[] = [];
  const remaining: string[] = [];
  let copied = 0;
  FILE_OPEN_RE.lastIndex = 0;
  for (let m; (m = FILE_OPEN_RE.exec(body));) {
    let end = FILE_OPEN_RE.lastIndex;
    let quote = "";
    for (; end < body.length; end++) {
      const char = body[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">" || char === "<") break;
    }
    if (body[end] !== ">") {
      return { found: true, ok: false, error: "a <file> element is not closed: end each file with </file>", warnings };
    }
    const rawAttrs = body.slice(FILE_OPEN_RE.lastIndex, end).trimEnd();
    const selfClosing = rawAttrs.endsWith("/");
    const bodyStart = end + 1;
    FILE_CLOSE_RE.lastIndex = bodyStart;
    const close = selfClosing ? null : FILE_CLOSE_RE.exec(body);
    if (!selfClosing && !close) {
      return { found: true, ok: false, error: "a <file> element is not closed: end each file with </file>", warnings };
    }
    const fa = parseAttributes(selfClosing ? rawAttrs.slice(0, -1) : rawAttrs);
    const path = (fa.path ?? fa.name ?? fa.filename ?? "").trim();
    files.push({ path, content: cleanFileContent(close ? body.slice(bodyStart, close.index) : "") });
    remaining.push(body.slice(copied, m.index));
    copied = FILE_OPEN_RE.lastIndex = close ? FILE_CLOSE_RE.lastIndex : bodyStart;
  }
  remaining.push(body.slice(copied));
  const rest = remaining.join("");
  if (/<file[\s>]/i.test(rest)) {
    return { found: true, ok: false, error: "a <file> element is not closed: end each file with </file>", warnings };
  }

  const demoMatch = DEMO_RE.exec(rest);
  let demo = demoMatch ? demoMatch[1].trim() : "";
  if (demo.length > MAX_DEMO_LENGTH) demo = demo.slice(0, MAX_DEMO_LENGTH) + "\n…[truncated]";

  let title = (attrs.title ?? "").replace(/\s+/g, " ").trim();
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
  const entry = attrs.entry !== undefined && attrs.entry.trim() !== "" ? attrs.entry.trim() : undefined;

  const prototype: ParsedPrototype = {
    title: title || "Untitled prototype",
    kind: kind ?? inferKind(files),
    ...(entry !== undefined && { entry }),
    ...(revises !== undefined && { revises }),
    files,
    demo,
  };
  const error = validatePrototype(prototype);
  if (error) return { found: true, ok: false, error, warnings };
  return { found: true, ok: true, prototype, warnings };
}

// An opening tag outside inline code. It starts an unclosed block when it carries attributes, is cut off
// before its ">", or is followed by a <file> element; a bare "<prototype>" in prose is only a mention.
const OPEN_TAG_RE = /(?<!\x60)<prototype(?=[\s>/]|$)/gi;

function unclosedStart(segment: string): number {
  let lastFile = -1;
  for (const m of segment.matchAll(/<file[\s>/]/gi)) lastFile = m.index;
  let end = segment.indexOf(">");
  let equals = segment.indexOf("=");
  for (const m of segment.matchAll(OPEN_TAG_RE)) {
    if (end < m.index) end = segment.indexOf(">", m.index);
    if (equals >= 0 && equals < m.index) equals = segment.indexOf("=", m.index);
    if (end < 0 || (equals >= 0 && equals < end) || lastFile >= m.index) return m.index;
  }
  return -1;
}

/**
 * Replace every prototype construct so no raw block survives: the first complete block (the one the
 * parser uses) becomes `first` (null keeps it as is), later complete blocks become `extra`, and an
 * unclosed block (from its opening tag up to the next complete block or the end of the text) becomes
 * `unclosed`, or `unclosedOnly` when the text has no complete block at all.
 */
export function scrubPrototypeBlocks(
  text: string,
  opts: { first: string | null; extra: string; unclosed: string; unclosedOnly?: string }
): string {
  const src = String(text ?? "");
  if (Buffer.byteLength(src, "utf8") > MAX_PARSE_BYTES) return opts.unclosedOnly ?? opts.unclosed;
  const blocks = [...src.matchAll(blockRe())];
  const tail = blocks.length ? opts.unclosed : opts.unclosedOnly ?? opts.unclosed;
  let out = "";
  let pos = 0;
  const gap = (end: number) => {
    const segment = src.slice(pos, end);
    const i = unclosedStart(segment);
    return i < 0 ? segment : segment.slice(0, i) + tail;
  };
  blocks.forEach((m, n) => {
    out += gap(m.index);
    out += n === 0 ? opts.first ?? m[0] : opts.extra;
    pos = m.index + m[0].length;
  });
  return out + gap(src.length);
}

/**
 * Replace the first <prototype> block with `replacement`. Later blocks (ignored by the parser) are
 * replaced with `extraReplacement` when given, otherwise left as they are. Text without a block is
 * returned unchanged.
 */
export function replacePrototypeBlock(text: string, replacement: string, extraReplacement?: string): string {
  let n = 0;
  const src = String(text ?? "");
  if (Buffer.byteLength(src, "utf8") > MAX_PARSE_BYTES) return replacement;
  return src.replace(blockRe(), (whole) => {
    n++;
    if (n === 1) return replacement;
    return extraReplacement ?? whole;
  });
}

// ----------------------------------------------------------------------------
// Verdict and decision lines
// ----------------------------------------------------------------------------

/** Undo markdown decoration and unicode dashes so a line can be matched; keeps snake_case words intact. */
function normalizeLine(line: string): string {
  let s = line
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[*`]/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$|:)/g, "$1");
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^\s*(?:#+\s*|>\s*|[-+]\s+|\d+[.)]\s+|\[\s*\]\s+)/, "");
  } while (s !== prev);
  return s.trim();
}

function labelRe(label: string): RegExp {
  return new RegExp(
    String.raw`^(?:(?:my|final|overall|our)\s+)?${label}\s+(?:on|for)\s+(?:prototype\s+)?P(\d+)` +
      String.raw`(?:\s*v(\d+)|\s*\(\s*v(\d+)\s*\))?\s*(?::|-|=)?\s*(.*)$`,
    "i"
  );
}
const VERDICT_LINE = labelRe("verdict");
const DECISION_LINE = labelRe("decision");
const VERDICT_WORD = /^[\[(]?\s*(APPROVE[DS]?|REVISE[DS]?|REJECT(?:ED|S)?)\b/i;
const DECISION_WORD = /^[\[(]?\s*(REVISE[DS]?|SCRAP(?:PED|S)?|SHORT-?LIST(?:ED|S)?)\b/i;

interface LineHit {
  word: string;
  reason: string;
}

function scanLines(text: string, lineRe: RegExp, wordRe: RegExp, id: string, version?: number): LineHit | null {
  const num = parseInt(id.replace(/^P/i, ""), 10);
  let last: LineHit | null = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!/verdict|decision/i.test(raw)) continue;
    const line = normalizeLine(raw);
    const m = lineRe.exec(line);
    if (!m || parseInt(m[1], 10) !== num) continue;
    const v = m[2] ?? m[3];
    if (version !== undefined && v !== undefined && parseInt(v, 10) !== version) continue;
    const value = m[4].trim();
    const w = wordRe.exec(value);
    if (!w) continue;
    const reason = value
      .slice(w[0].length)
      .replace(/^\s*[\])]?\s*[-:,.;=]*\s*/, "")
      .trim();
    last = { word: w[1].toUpperCase(), reason };
  }
  return last;
}

/**
 * The verdict an assessor gave on a prototype (all lines are scanned; the last valid one wins).
 * A line naming a different version is ignored. No valid line gives UNCLEAR with an empty reason.
 */
export function parseVerdictFor(text: string, id: string, version?: number): { verdict: Verdict; reason: string } {
  const hit = scanLines(text, VERDICT_LINE, VERDICT_WORD, id, version);
  if (!hit) return { verdict: "UNCLEAR", reason: "" };
  const verdict: Verdict = hit.word.startsWith("APPROVE") ? "APPROVE" : hit.word.startsWith("REVISE") ? "REVISE" : "REJECT";
  return { verdict, reason: hit.reason };
}

/** The proposer's decision on a prototype, or null when the turn has no valid decision line. */
export function parseDecisionFor(text: string, id: string, version?: number): { decision: Decision; reason: string } | null {
  const hit = scanLines(text, DECISION_LINE, DECISION_WORD, id, version);
  if (!hit) return null;
  const decision: Decision = hit.word.startsWith("REVISE") ? "REVISE" : hit.word.startsWith("SCRAP") ? "SCRAP" : "SHORTLIST";
  return { decision, reason: hit.reason };
}

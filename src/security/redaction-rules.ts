// Shared credential patterns; no publisher or environment dependencies.

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

const mark = (kind: string) => `[redacted:${kind}]`;
const NOT_ALREADY = "(?!\\[redacted:)";

/** Words that make a key or identifier secret-shaped ("author" and "authority" excepted). */
const SECRET_WORD = "secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(?!or(?!iz)|ority)";
/** A JSON key or identifier whose value is a secret, the same vocabulary as the key=value rule. */
export const SECRET_KEY_RE = new RegExp(SECRET_WORD, "i");
/** A run of 12+ letters and digits holding at least two digits is a generated id, not a word ("exe-01m5rpwdq…"). */
const ID_RUN = /(?<![A-Za-z0-9])(?=(?:[A-Za-z]*\d){2})[A-Za-z0-9]{12,}(?![A-Za-z0-9])/g;
/** True when a key or identifier names a secret; a secret word inside a generated id does not count. */
export function secretKeyName(name: string): boolean {
  return SECRET_KEY_RE.test(name.replace(ID_RUN, ""));
}

type Replace = (re: RegExp, kind: string, fn?: (match: string, ...groups: string[]) => string | null) => void;

export function redactWith(input: string, rules: (rep: Replace) => void): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  const bump = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const rep: Replace = (re, kind, fn) => {
    text = text.replace(re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2).filter((g) => typeof g === "string") as string[];
      if (fn) {
        const out = fn(match, ...groups);
        if (out === null) return match; // validator rejected: leave untouched
        bump(kind);
        return out;
      }
      bump(kind);
      return mark(kind);
    });
  };
  rules(rep);
  return { text, counts };
}

/** Token-shaped credentials, without field-name, assignment or authorization heuristics. */
export function redactSecretTokens(input: string): RedactionResult {
  return redactWith(input, (rep) => {
    redactPrivateKeys(rep);
    redactJWTs(rep);
    redactVendorTokens(rep);
  });
}

function redactPrivateKeys(rep: Replace): void {
  // PEM private keys first (whole block, including JSON-escaped "\\n" bodies; then a dangling
  // header whose END marker was cut off), so the key=value rule below only sees the marker.
  rep(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private_key");
  rep(/-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*/g, "private_key");
}

function redactJWTs(rep: Replace): void {
  rep(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "jwt");
}

function redactVendorTokens(rep: Replace): void {
  rep(/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])tk_[A-Za-z0-9]{10,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "api_key");
  rep(/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])r8_[A-Za-z0-9]{20,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, "api_key");
  rep(/(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "api_key");
  rep(/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g, "api_key");
}

/** Secret-shaped rules only: private keys, URL and HTTP credentials, JWTs and vendor key formats. */
function shapedSecretRules(rep: Replace): void {
  redactPrivateKeys(rep);

  // credentials embedded in a URL: scheme://user:pass@host
  rep(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s@/]+@/gi, "url_credentials", (_m, scheme) => scheme + mark("url_credentials") + "@");

  // Explicit authorization fields accept credential tokens of any length or alphabet.
  rep(/\b((?:Proxy-)?Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/]+={0,2}/gi, "basic_auth", (_m, p) => p + mark("basic_auth"));
  rep(/\b((?:Proxy-)?Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "bearer", (_m, p) => p + mark("bearer"));

  // JWTs, then bearer credentials, then vendor tokens
  redactJWTs(rep);
  rep(/\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-]|[A-Za-z]{16})[A-Za-z0-9._~+/=-]{8,}/gi, "bearer", (_m, p) => p + mark("bearer"));
  redactVendorTokens(rep);
  // HTTP Basic credentials, including alphabet-only base64.
  rep(
    /\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/g,
    "basic_auth",
    (_m, p) => p + mark("basic_auth")
  );
}

/** Credentials only: shaped secrets plus the generic key=value assignment rule. */
export function redactSecrets(input: string): RedactionResult {
  return redactAssignments(redactWith(input, shapedSecretRules));
}

/**
 * Artifact content (model-written code and documents): only the secret-shaped rules. The name-based
 * key=value rule is left out because identifiers such as `tokens`, `secretKey` or `password: string`
 * are ordinary source, not credentials. Exact configured values are handled by scrubArtifactSecrets.
 */
export function redactArtifactSecrets(input: string): RedactionResult {
  return redactWith(input, shapedSecretRules);
}

/** Consume each identifier once before deciding whether to read an assignment value. */
function redactAssignments(result: RedactionResult): RedactionResult {
  const input = result.text;
  const keys = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)["']?\s*[:=]\s*/g;
  const value = new RegExp(
    "(?:\"" + NOT_ALREADY + "[^\"]+\"|'" + NOT_ALREADY + "[^']+'|" + NOT_ALREADY + "[^\\s\"',;]{4,})", "y"
  );
  const chunks: string[] = [];
  let copied = 0;
  for (let m; (m = keys.exec(input));) {
    const key = m[1];
    const field = key.slice(key.lastIndexOf(".") + 1);
    if (!secretKeyName(field)) continue;
    value.lastIndex = keys.lastIndex;
    const v = value.exec(input);
    if (!v) continue;
    const quote = v[0][0] === '"' || v[0][0] === "'" ? v[0][0] : "";
    // Provider validation errors echo numeric output-token limits; these are not credentials.
    // Check the already-consumed field and value independently, without rescanning the assignment.
    const raw = quote ? v[0].slice(1, -1) : v[0];
    if (/^max_(?:new_|completion_)?tokens$/i.test(field) && /^\d+$/.test(raw)) {
      keys.lastIndex = value.lastIndex;
      continue;
    }
    chunks.push(input.slice(copied, keys.lastIndex), quote + mark("secret") + quote);
    copied = keys.lastIndex = value.lastIndex;
    result.counts.secret = (result.counts.secret ?? 0) + 1;
  }
  chunks.push(input.slice(copied));
  return { text: chunks.join(""), counts: result.counts };
}

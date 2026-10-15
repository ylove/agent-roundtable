// Shared credential patterns; no publisher or environment dependencies.

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

const mark = (kind: string) => `[redacted:${kind}]`;
const NOT_ALREADY = "(?!\\[redacted:)";

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

/** Credentials only: keys, tokens, private keys, URL and HTTP credentials, key=value secrets. */
export function redactSecrets(input: string): RedactionResult {
  return redactWith(input, (rep) => {
    // PEM private keys first (whole block, including JSON-escaped "\\n" bodies; then a dangling
    // header whose END marker was cut off), so the key=value rule below only sees the marker.
    rep(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private_key");
    rep(/-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*/g, "private_key");

    // credentials embedded in a URL: scheme://user:pass@host
    rep(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s@/]+@/gi, "url_credentials", (_m, scheme) => scheme + mark("url_credentials") + "@");

    // JWTs, then bearer credentials, then vendor tokens
    rep(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "jwt");
    rep(/\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-]|[A-Za-z]{16})[A-Za-z0-9._~+/=-]{8,}/gi, "bearer", (_m, p) => p + mark("bearer"));
    rep(/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])tk_[A-Za-z0-9]{10,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "api_key");
    rep(/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])r8_[A-Za-z0-9]{20,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, "api_key");
    rep(/(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "api_key");
    rep(/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g, "api_key");
    // HTTP Basic credentials (base64 must contain a digit, '+', '/' or '=' so plain words survive)
    rep(
      /\b(Basic\s+)(?=[A-Za-z0-9+/]*[\d+/]|[A-Za-z0-9+/]+=)[A-Za-z0-9+/]{8,}={0,2}/g,
      "basic_auth",
      (_m, p) => p + mark("basic_auth")
    );

    // generic key=value secrets (keeps the key name, drops the value). The secret keyword may sit
    // anywhere inside the identifier (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN_READONLY, client_secret_value).
    // Only the assignment form counts (identifier, optional quote, spaces, = or :, then a value), so
    // prose such as "the token budget is 250" is untouched. Quoted values may hold spaces/commas/semicolons.
    rep(
      new RegExp(
        "(?<![A-Za-z0-9])([A-Za-z0-9_.-]*?(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(?!or(?!iz)|ority))[A-Za-z0-9_-]*[\"']?\\s*[:=]\\s*)" +
          "(?:\"" + NOT_ALREADY + "([^\"]+)\"|'" + NOT_ALREADY + "([^']+)'|" + NOT_ALREADY + "([^\\s\"',;]{4,}))",
        "gi"
      ),
      "secret",
      (m, p) => {
        const q = m.charAt(p.length);
        const quote = q === '"' || q === "'" ? q : "";
        return p + quote + mark("secret") + quote;
      }
    );

  });
}


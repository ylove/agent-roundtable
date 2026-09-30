// Mechanical redaction of outgoing public messages. This is a BACKSTOP, not the main protection:
// it catches well-formed secrets and identifiers, and it cannot catch personal names or free-form
// private context. Patterns are deliberately conservative so years, turn numbers and versions survive.

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const mark = (kind: string) => `[redacted:${kind}]`;
const NOT_ALREADY = "(?!\\[redacted:)";

export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  const bump = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const rep = (
    re: RegExp,
    kind: string,
    fn?: (match: string, ...groups: string[]) => string | null
  ) => {
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

  // emails
  rep(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "email");

  // home-directory absolute paths (unix-style /home/<name>, macOS-style, and Windows C:\Users\<name>)
  rep(
    new RegExp("(?<![\\w.~-])/(?:" + "Us" + "ers|home)/[^\\s/\"'`)\\]>]+(?:/[^\\s\"'`)\\]>]*)?", "g"),
    "path"
  );
  rep(/(?<![\w])[A-Za-z]:\\Users\\[^\s\\"'`)\]>]+(?:\\[^\s"'`)\]>]*)?/gi, "path");

  // private IPv4
  rep(
    /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d]|\.\d)/g,
    "ip",
    (m) => (m.split(".").every((o) => Number(o) <= 255) ? mark("ip") : null)
  );

  // SSN (US), then Luhn-valid card numbers, then phones
  rep(/(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g, "ssn", (_m, a, g, s) =>
    a === "000" || a === "666" || a[0] === "9" || g === "00" || s === "0000" ? null : mark("ssn")
  );
  rep(/(?<![\w.-])[2-6](?:[ -]?\d){12,18}(?![\w-])/g, "card", (m) => {
    const digits = m.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? mark("card") : null;
  });
  rep(/(?<![\w])\+\d[\d\s().-]{7,17}\d(?![\w])/g, "phone", (m) => {
    const n = m.replace(/\D/g, "").length;
    return n >= 8 && n <= 15 ? mark("phone") : null;
  });
  // unseparated numbers, only next to an explicit keyword
  rep(
    /\b((?:ssn|social\s+security(?:\s+(?:number|no\.?))?|ss#)\W{0,12}?)(\d{3}[ -]?\d{2}[ -]?\d{4})(?!\d)/gi,
    "ssn",
    (_m, p) => p + mark("ssn")
  );
  rep(
    /\b((?:phone|tel|telephone|mobile|cell|fax|whatsapp|sms)\b[^\d\n]{0,20}?)(?<!\d)(1?[2-9]\d{2}[2-9]\d{6})(?!\d)/gi,
    "phone",
    (_m, p) => p + mark("phone")
  );
  rep(/(?<![\w.-])(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-]|\.\d)/g, "phone");

  return { text, counts };
}

export function mergeCounts(into: Record<string, number>, add: Record<string, number>): void {
  for (const [k, v] of Object.entries(add)) into[k] = (into[k] ?? 0) + v;
}

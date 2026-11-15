// Mechanical redaction of outgoing public messages. This is a BACKSTOP, not the main protection:
// it catches well-formed secrets and identifiers, and it cannot catch personal names or free-form
// private context. Patterns are deliberately conservative so years, turn numbers and versions survive.

import { scrubConfiguredSecrets } from "../security/secrets.js";
import { redactSecrets, redactWith, type RedactionResult } from "../security/redaction-rules.js";
export { redactSecrets, type RedactionResult } from "../security/redaction-rules.js";

const mark = (kind: string) => `[redacted:${kind}]`;

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

/** Public output: secrets first, then personal data. */
export function redact(input: string): RedactionResult {
  const configured = scrubConfiguredSecrets(input);
  const secrets = redactSecrets(configured.text);
  const pii = redactPII(secrets.text);
  const counts = { ...secrets.counts };
  if (configured.redactions) counts.env = configured.redactions;
  mergeCounts(counts, pii.counts);
  return { text: pii.text, counts };
}

/** Personal data only: emails, home paths, private IPs, SSNs, card numbers, phone numbers. */
export function redactPII(input: string): RedactionResult {
  return redactWith(input, (rep) => {
    // emails
    rep(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "email");

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
  });
}

export function mergeCounts(into: Record<string, number>, add: Record<string, number>): void {
  for (const [k, v] of Object.entries(add)) into[k] = (into[k] ?? 0) + v;
}

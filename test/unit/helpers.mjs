// Shared helpers for the offline unit tests (node:test). No network: fetch is always stubbed.
import dns from "node:dns";

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Replace globalThis.fetch for the duration of a test. `script(url, init, index)` returns the
 * Response for the index-th call. Returns the recorded calls ({ url, init, body, signal }) —
 * `signal` is init.signal so tests can assert that every request carries the caller's AbortSignal.
 * String bodies are JSON-parsed into `body`; binary bodies (Buffer/Uint8Array) are left in
 * `init.body` and `body` is undefined.
 * t.mock.method restores the real fetch when the test ends.
 */
export function stubFetch(t, script) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const body = init.body && !(init.body instanceof Uint8Array) ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body, signal: init.signal });
    return script(String(url), init, calls.length - 1);
  });
  return calls;
}

/**
 * Stub DNS for the URL guard (dns.promises.lookup) for the duration of a test. `answers` maps a host
 * name to its addresses, or to an Error to throw; any other host resolves to 203.0.113.10 (TEST-NET-3,
 * a public address). Returns the host names looked up.
 */
export function stubDns(t, answers = {}) {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    const found = answers[host] ?? ["203.0.113.10"];
    if (found instanceof Error) throw found;
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  return asked;
}

/**
 * Inline script, style or event-handler constructs in an HTML page (none may appear under a strict
 * CSP): <script> without src or with a body, <style>, style="…" attributes, on…= handler
 * attributes, and javascript: URLs in any attribute. Returns the offending snippets.
 */
export function inlineProblems(html) {
  const problems = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc="/i.test(m[0].slice(0, m[0].indexOf(">") + 1)) || m[1].trim()) problems.push(m[0].slice(0, 120));
  }
  for (const m of html.matchAll(/<style\b/gi)) problems.push(m[0]);
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
    if (/\sstyle\s*=/i.test(tag[0])) problems.push(tag[0]);
    if (/\son[a-z]+\s*=/i.test(tag[0])) problems.push(tag[0]);
    if (/=\s*["']?\s*javascript:/i.test(tag[0])) problems.push(tag[0]);
  }
  return problems;
}

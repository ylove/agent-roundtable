// Shared helpers for the offline unit tests (node:test). No network: fetch is always stubbed.

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Replace globalThis.fetch for the duration of a test. `script(url, init, index)` returns the
 * Response for the index-th call. Returns the recorded calls ({ url, init, body, signal }) —
 * `signal` is init.signal so tests can assert that every request carries the caller's AbortSignal.
 * t.mock.method restores the real fetch when the test ends.
 */
export function stubFetch(t, script) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body, signal: init.signal });
    return script(String(url), init, calls.length - 1);
  });
  return calls;
}

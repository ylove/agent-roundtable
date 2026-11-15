import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { guardedDispatcher } from "../../dist/security/url-guard.js";
import { callOpenAICompatible } from "../../dist/providers/openai-compatible.js";
import { WebhookPublisher } from "../../dist/publishers/webhook.js";

async function server(t, handler) {
  const http = createServer(handler);
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return http.address().port;
}

const options = baseUrl => ({ baseUrl, model: "fixture", maxTokens: 8, signal: AbortSignal.timeout(5000) });
const messages = [{ role: "user", content: "hello" }];

test("a real request connects to the approved address when lookup answers change", async t => {
  let host;
  const port = await server(t, (req, res) => {
    host = req.headers.host;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "approved address" } }] }));
  });
  let lookups = 0;
  t.mock.method(dns.promises, "lookup", async () => {
    lookups++;
    return [{ address: lookups === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
  });
  t.mock.method(dns, "lookup", () => { throw new Error("connection must use approved addresses"); });
  const base = `http://approved.example.test:${port}/v1`;
  const result = await callOpenAICompatible(messages, options(base));
  assert.equal(result.content, "approved address");
  assert.equal(lookups, 1);
  assert.equal(host, `approved.example.test:${port}`);
});

test("IP literals use the native fetch connection without a dispatcher", async t => {
  const port = await server(t, (_req, res) => res.end("literal"));
  t.mock.method(dns.promises, "lookup", () => { throw new Error("IP literal needs no lookup"); });
  const url = `http://127.0.0.1:${port}/`;
  assert.equal(await guardedDispatcher(url), undefined);
  assert.equal(await (await globalThis.fetch(url)).text(), "literal");
});

test("a real redirect to a disallowed address is refused", async t => {
  let requests = 0;
  const port = await server(t, (_req, res) => {
    requests++;
    res.writeHead(307, { location: "http://169.254.169.254/" });
    res.end();
  });
  t.mock.method(dns.promises, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  const url = `http://redirect.example.test:${port}/v1`;
  await assert.rejects(callOpenAICompatible(messages, options(url)), /refusing to follow a redirect/);
  const publisher = new WebhookPublisher({ url, topicPrefix: "rt" });
  const result = await publisher.send({ id: "rt-fixture", sessionId: "fixture" }, { content: "hello" });
  assert.equal(result.ok, false);
  assert.equal(requests, 2);
});

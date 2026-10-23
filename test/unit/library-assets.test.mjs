import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { LIBRARY_JS } from "../../dist/library/assets.js";

test("the page renders hostile metadata as text, searches, imports through FileReader and refreshes", async () => {
  class Element {
    textContent = "";
    value = "";
    children = [];
    listeners = {};
    classList = { add() {}, remove() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.textContent = ""; this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const ids = Object.fromEntries(["search", "agents", "status", "casting", "results", "files", "drop"].map(id => [id, new Element()]));
  const malicious = '<img src=x onerror="throw 1">';
  const agents = [{ key: "reader", name: malicious, description: "Reads carefully", tools: ["Read"], skills: [], warnings: [malicious], source: "library", shadowed: true }];
  let reads = 0;
  const posts = [];
  const document = { getElementById: id => ids[id], createElement: () => new Element(), querySelector: () => ({ content: "page-nonce" }) };
  const fetch = async (path, options) => {
    if (path === "agents.json") return { ok: true, json: async () => ({ agents, casting: { brief: "Review", createdAt: "today", agents: [{ key: "reader", verdict: "cast", role: malicious }] } }) };
    posts.push(options);
    agents.push({ ...agents[0], key: "added", name: "Added", shadowed: undefined });
    return { ok: true, json: async () => ({ results: [{ filename: "added.md", status: "imported", warnings: [] }] }) };
  };
  class FileReader {
    readAsText(file) { reads++; this.result = file.content; queueMicrotask(() => this.onload()); }
  }
  new Script(LIBRARY_JS).runInNewContext({ document, fetch, FileReader, TextEncoder });
  await new Promise(resolve => setImmediate(resolve));
  const text = element => [element.textContent, ...element.children.map(text)].join(" ");
  assert.equal(ids.agents.children.length, 1);
  assert.match(text(ids.agents), /<img src=x onerror="throw 1">/);
  assert.match(text(ids.agents), /Shadowed/);
  assert.match(text(ids.agents), /Casting Call: cast/);
  ids.search.value = "absent";
  ids.search.listeners.input();
  assert.equal(ids.agents.children.length, 0);
  ids.search.value = "";
  await ids.files.listeners.change({ target: { files: [{ name: "added.md", size: 6, content: "Read." }] } });
  assert.equal(reads, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["X-Roundtable-Action"], "page-nonce");
  assert.deepEqual(JSON.parse(posts[0].body), { files: [{ filename: "added.md", content: "Read." }] });
  assert.match(text(ids.results), /added.md: imported/);
  assert.equal(ids.agents.children.length, 2);
  assert.equal(ids.files.disabled, false);
  await ids.drop.listeners.drop({ dataTransfer: { files: [{ name: "huge.md", size: 131073 }] } });
  assert.equal(posts.length, 1);
  assert.match(text(ids.results), /128 KiB/);
});

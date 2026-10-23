export const LIBRARY_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function libraryHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="roundtable-action" content="${nonce}"><title>Agents library</title>
<link rel="stylesheet" href="library.css"><script src="library.js" defer></script></head>
<body><header><p>at the table</p><h1>Agents library</h1><p>Browse your personas and bring new voices to the table.</p></header>
<main><section id="drop" aria-label="Import agents"><h2>Import personas</h2><p>Drop .md or .json files here, or choose files. Existing personas are skipped.</p>
<label for="files">Choose persona files</label><input id="files" type="file" accept=".md,.json" multiple>
<p>Up to 50 files, 128 KiB each, 2 MiB per import.</p><div id="results" role="status" aria-live="polite"></div></section>
<label for="search">Search agents</label><input id="search" type="search" placeholder="Name, role, tool or skill">
<p id="casting"></p><p id="status" role="status"></p><section id="agents" aria-label="Agents"></section></main></body></html>`;
}

export const LIBRARY_CSS = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151d;color:#eef2f7}*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1300px;margin-inline:auto}header p{color:#b8c8da}h1{font-size:clamp(28px,4vw,40px)}h2{font-size:20px;margin-top:0}p{line-height:1.5}#drop{border:2px dashed #6888ae;border-radius:12px;padding:20px;margin:24px 0}#drop.drag{background:#1a2b42}label{display:block;margin:12px 0 6px}input{font:inherit;color:inherit;background:#19222f;border:1px solid #6888ae;border-radius:6px;padding:10px;max-width:100%}#search{width:100%}#agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}article{padding:20px;border:1px solid #34465c;border-radius:12px;background:#19222f;min-width:0;overflow-wrap:anywhere}article p{color:#c3d1e1}.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{font-size:13px;border:1px solid #6888ae;border-radius:20px;padding:3px 9px}.warning,.shadowed{color:#eac26a}.verdict{border-color:#63c69a}.key{font-family:ui-monospace,monospace}#results p{white-space:pre-wrap;overflow-wrap:anywhere}input:focus-visible{outline:2px solid #91bdf3;outline-offset:3px}@media(max-width:600px){body{padding:14px}#drop,article{padding:14px}}`;

/** Untrusted filenames, metadata and results enter the DOM only through textContent. */
export const LIBRARY_JS = `"use strict";
const byId = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
let state = {agents: []};
function render() {
  const query = byId("search").value.toLowerCase();
  const agents = state.agents.filter(agent => [agent.key, agent.name, agent.description, agent.source, ...agent.tools, ...agent.skills].join(" ").toLowerCase().includes(query));
  byId("agents").replaceChildren(...agents.map(agent => {
    const card = node("article");
    const chips = node("div", undefined, "chips"); chips.append(node("span", agent.source, "chip"));
    for (const tool of agent.tools) chips.append(node("span", tool, "chip"));
    card.append(node("h2", agent.name || agent.key), node("p", agent.key, "key"), chips, node("p", agent.description || ""));
    if (agent.skills.length) card.append(node("p", "Skills: " + agent.skills.join(", ")));
    for (const warning of agent.warnings) card.append(node("p", warning, "warning"));
    if (agent.shadowed) card.append(node("p", "Shadowed: the configured agents-dir persona wins lookup.", "shadowed"));
    const casting = state.casting?.agents.find(item => item.key === agent.key);
    if (casting) { card.append(node("span", "Casting Call: " + casting.verdict, "chip verdict")); if (casting.role) card.append(node("p", casting.role)); }
    return card;
  }));
  byId("status").textContent = agents.length + " agents";
  byId("casting").textContent = state.casting ? "Latest Casting Call: " + state.casting.brief + " · " + state.casting.createdAt : "";
}
async function refresh() {
  const response = await fetch("agents.json", {cache:"no-store"});
  if (!response.ok) throw new Error("The library could not be loaded.");
  state = await response.json(); render();
}
function read(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({filename: file.name, content: reader.result}); reader.onerror = () => reject(new Error("A file could not be read.")); reader.readAsText(file); });
}
let importing = false;
async function upload(input) {
  if (importing) return;
  const files = Array.from(input); const results = byId("results"); results.replaceChildren();
  if (files.length > 50 || files.some(file => file.size > 131072) || files.reduce((sum, file) => sum + file.size, 0) > 2097152) { results.textContent = "Choose at most 50 files, 128 KiB each, 2 MiB total."; return; }
  importing = true; byId("files").disabled = true; results.textContent = "Importing…";
  try {
    const body = JSON.stringify({files: await Promise.all(files.map(read))});
    if (new TextEncoder().encode(body).length > 2097152) throw new Error("Import JSON exceeds 2 MiB; choose fewer files.");
    const response = await fetch("import", {method:"POST", headers:{"Content-Type":"application/json", "X-Roundtable-Action":document.querySelector('meta[name="roundtable-action"]').content}, body});
    const report = await response.json();
    if (!response.ok) throw new Error(report.error || "The import failed.");
    results.replaceChildren(...report.results.map(result => node("p", (result.filename || result.key || "File") + ": " + result.status + (result.error ? " · " + result.error : "") + (result.warnings.length ? " · " + result.warnings.join("; ") : ""))));
    await refresh();
  } catch (error) { results.textContent = error.message || "The import failed."; }
  finally { importing = false; byId("files").disabled = false; byId("files").value = ""; }
}
byId("search").addEventListener("input", render);
byId("files").addEventListener("change", event => upload(event.target.files));
const drop = byId("drop");
for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add("drag"); });
for (const type of ["dragleave", "drop"]) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove("drag"); });
drop.addEventListener("drop", event => upload(event.dataTransfer.files));
refresh().catch(() => { byId("status").textContent = "The library could not be loaded. Reload the page and try again."; });
`;

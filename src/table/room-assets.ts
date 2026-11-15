export const ROOM_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const ROOM_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Duel at the table</title><link rel="stylesheet" href="room.css"><script src="room.js" defer></script></head>
<body><header><p>at the table · duel</p><h1 id="topic">Waiting for the duel</h1><div id="banner" role="status">Participants are taking their seats.</div></header>
<main><section id="seats" aria-label="Seats"></section><section id="artifacts" aria-label="Artifacts"></section>
<section aria-label="Shared browser"><h2>Browser</h2><p id="browser-note">No page checked yet.</p><img id="browser-shot" alt="Latest checked page" hidden></section>
<section id="previews" aria-label="Live previews" hidden><h2>Live previews</h2><p id="preview-note"></p><div id="preview-frames"></div></section>
<section><h2>Judges' verdicts</h2><div id="verdicts"></div></section><section><h2>Dissents</h2><div id="dissents"></div></section>
<section><h2>At the table</h2><div id="turns"></div></section></main><footer id="spend">Estimated spend: $0.0000</footer></body></html>`;

export const ROOM_CSS = `.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px}.snapshot,#browser-shot{display:block;max-width:100%;height:auto;margin-top:12px}.snapshot[hidden],#browser-shot[hidden]{display:none}.check{font-size:.8em;color:#c3d1e1}.versions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}button{cursor:pointer}pre.diff{max-height:320px;overflow:auto;white-space:pre-wrap}
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151d;color:#eef2f7}body{margin:0;padding:24px;max-width:1500px;margin-inline:auto}header{margin-bottom:24px}header p{color:#91bdf3;letter-spacing:.1em}h1{font-size:clamp(24px,3vw,40px)}h2{font-size:20px}#banner{padding:16px;border:1px solid #6888ae;border-radius:12px;background:#1a2b42}#artifacts{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:24px 0}article,.seat,.verdict,.dissent{padding:16px;border:1px solid #34465c;border-radius:12px;background:#19222f}iframe{display:block;width:100%;height:480px;border:0;border-radius:8px;background:white}#seats,#verdicts,#dissents{display:flex;flex-wrap:wrap;gap:12px}.seat{flex:1;min-width:180px}.seat p{overflow-wrap:anywhere;margin:6px 0;color:#c3d1e1}.verdict[data-verdict=APPROVE]{border-color:#63c69a}.verdict[data-verdict=REVISE]{border-color:#eac26a}.verdict[data-verdict=REJECT]{border-color:#ee8c8c}.dissent{white-space:pre-wrap;flex:1;min-width:240px}#turns{max-height:420px;overflow-y:auto}#turns p{white-space:pre-wrap;padding:12px;border-bottom:1px solid #34465c}footer{margin-top:24px;color:#b8c8da}.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.tabs button{font:inherit;padding:4px 10px;border:1px solid #34465c;border-radius:6px;background:#10151d;color:#eef2f7;cursor:pointer}.tabs button[aria-selected=true]{border-color:#91bdf3;background:#1a2b42}pre.source{margin:0;height:480px;overflow:auto;padding:12px;border-radius:8px;background:#0b0f15;color:#dfe8f2;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.placeholder{padding:50px 12px;color:#c3d1e1}@media(max-width:800px){body{padding:12px}#artifacts{grid-template-columns:1fr}iframe{height:440px}}`;

/** All model-written strings enter the DOM through textContent. Frames survive state polling. */
export const ROOM_JS = `"use strict";
const byId = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if(text !== undefined) element.textContent = text; if(className) element.className = className; return element; };
const spendText = (usd, tokens, unit) => { tokens = tokens || 0; const money = "$" + usd.toFixed(4); if (tokens <= 0) return money; const count = tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1).replace(/\\.0$/, "") + "k"; const rest = count + " tok" + (unit ? " unpriced" : " (no price)"); return usd > 0 ? money + " + " + rest : rest; };
const artifactCards = new Map();
const selections = new Map();
const comparisons = new Set();
const SOURCE_KINDS = ["code", "diagram", "text"];
/* Source is fetched as text and shown through textContent: never parsed as markup, never run. */
function sourceView(team, prototype, version) {
  const box = node("div"); const tabs = node("div", undefined, "tabs"); const pre = node("pre", "Loading…", "source");
  tabs.setAttribute("role", "tablist"); pre.tabIndex = 0; pre.setAttribute("aria-label", "Team " + team + " " + prototype.kind + " source");
  const buttons = []; let latest = 0;
  const show = async (file, button) => {
    const mine = ++latest;
    for (const other of buttons) other.setAttribute("aria-selected", String(other === button));
    pre.textContent = "Loading…";
    try { const response = await fetch("p/" + team + "/" + file.path + "?v=" + version, {cache:"no-store"}); const body = response.ok ? await response.text() : "This file is unavailable."; if (mine === latest) pre.textContent = body; }
    catch { if (mine === latest) pre.textContent = "This file is unavailable."; }
  };
  for (const file of prototype.files) { const button = node("button", file.path); button.type = "button"; button.setAttribute("role", "tab"); button.onclick = () => show(file, button); buttons.push(button); tabs.append(button); }
  box.append(tabs, pre); if (buttons.length) show(prototype.files[0], buttons[0]);
  return box;
}
function render(state) {
  byId("topic").textContent = state.topic || "Waiting for the duel";
  const end = state.end;
  byId("banner").textContent = end ? (end.aborted ? "Duel stopped" : end.winner === "tie" ? "It's a tie" : end.winner === "none" ? "No verdict" : "Team " + end.winner + " wins") + " · A " + end.tally.A + " / B " + end.tally.B : "The duel is in progress";
  byId("seats").replaceChildren(...state.seats.map(seat => {
    const card = node("article", undefined, "seat");
    const spend = state.usage.perSeat.find(item => item.seatId === seat.id);
    card.append(node("strong", seat.name), node("p", (seat.team === "judge" ? "Judge" : "Team " + seat.team) + " · " + (seat.role || "participant")), node("p", seat.provider + " / " + seat.model), node("p", seat.reason || ""), node("p", spendText(spend ? spend.costUsd : 0, spend && spend.unpricedTokens, false)));
    return card;
  }));
  for (const team of ["A", "B"]) {
    const history = (state.history || state.prototypes).filter(item => item.team === team);
    const latest = history.at(-1);
    const version = latest ? latest.version : 0;
    if(artifactCards.get(team)?.version === version) continue;
    const prototype = history.find(item => item.version === selections.get(team)) || latest;
    const card = node("article"); card.append(node("h2", "Team " + team + (prototype?.title ? " · " + prototype.title : "")));
    const strip = node("div", undefined, "versions");
    for (const item of history) {
      const check = item.check;
      const status = !check || check.reason === "no browser" || check.reason === "disabled" || check.reason === "page check unavailable" ? "not checked" : check.loaded && !check.reason && !check.exceptions.length && !check.consoleErrors.length && !check.failedRequests ? "loaded" : "errors";
      const button = node("button", "v" + item.version + " · " + status, "check"); button.type = "button";
      button.setAttribute("aria-pressed", String(item.version === prototype.version));
      button.onclick = () => { selections.set(team, item.version); comparisons.delete(team); artifactCards.get(team).version = -1; render(state); };
      strip.append(button);
    }
    card.append(strip);
    const show = item => {
      const box = node("div"); box.append(node("h3", "v" + item.version));
      if(item.ok && SOURCE_KINDS.includes(item.kind) && item.files.length) box.append(sourceView(team, item, item.version));
      else if(item.ok && item.files.some(file => file.path === "index.html")) {
        const frame = node("iframe"); frame.title = "Team " + team + " artifact v" + item.version;
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
        frame.src = "p/" + team + "/" + item.version + "/index.html"; box.append(frame);
        const image = node("img", undefined, "snapshot"); image.alt = "Team " + team + " screenshot v" + item.version;
        image.src = "shot/" + team + "/" + item.version + ".png"; image.onerror = () => { image.hidden = true; }; box.append(image);
      } else box.append(node("p", item.error || "The builder is heads-down.", "placeholder"));
      return box;
    };
    if (history.length > 1) {
      const toggle = node("button", comparisons.has(team) ? "Selected version" : "Current vs proposed"); toggle.type = "button";
      toggle.onclick = () => { if(comparisons.has(team)) comparisons.delete(team); else comparisons.add(team); artifactCards.get(team).version = -1; render(state); };
      card.append(toggle);
    }
    if (comparisons.has(team) && history.length > 1) {
      const pair = node("div", undefined, "comparison"); pair.append(show(history.at(-2)), show(latest)); card.append(pair);
      const diff = node("pre", "Loading diff…", "diff"); card.append(diff);
      fetch("diff/" + team + ".json", {cache:"no-store"}).then(r => r.ok ? r.json() : null).then(d => {
        diff.textContent = d ? d.path + " · v" + d.from + " → v" + d.to + "\\n" + d.lines.map(line => (line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  ") + line.text).join("\\n") : "No diff available.";
      }).catch(() => { diff.textContent = "No diff available."; });
    } else if(prototype) card.append(show(prototype));
    else card.append(node("p", "The builder is heads-down.", "placeholder"));
    const old = artifactCards.get(team); if(old) old.card.replaceWith(card); else byId("artifacts").append(card);
    artifactCards.set(team, {version, card});
  }
  if (state.browser) {
    const shot = state.browser;
    byId("browser-note").textContent = "Team " + shot.team + " · v" + shot.version;
    const src = "shot/" + shot.team + "/" + shot.version + ".png";
    const image = byId("browser-shot"); if (image.getAttribute("src") !== src) image.src = src; image.hidden = false;
  }
  byId("verdicts").replaceChildren(...state.assessments.map(item => {
    const card = node("article", undefined, "verdict"); card.dataset.verdict = item.verdict;
    card.append(node("strong", item.judge.name + " · Team " + item.team + (item.version ? " · v" + item.version : "") + " · " + item.verdict), node("p", item.reason)); return card;
  }));
  byId("dissents").replaceChildren(...state.dissents.map(item => node("article", item.seat.name + " · Team " + item.team + "\\n" + item.text, "dissent")));
  byId("turns").replaceChildren(...state.turns.map(item => node("p", item.seat.name + " · " + item.round + "\\n" + item.text)));
  byId("spend").textContent = "Estimated spend: " + spendText(state.usage.totalCostUsd, state.usage.totalUnpricedTokens, true);
}
/* Live dev-server previews: sandboxed frames, never same-origin, for the origins the page's CSP was served with. */
let framed = null;
async function previews() {
  try {
    const response = await fetch("previews.json", {cache:"no-store"}); if(!response.ok) return;
    const list = await response.json();
    if (framed === null) framed = new Set(list.map(item => item.origin));
    const holder = byId("preview-frames");
    const wanted = list.filter(item => framed.has(item.origin));
    byId("previews").hidden = list.length === 0;
    byId("preview-note").textContent = wanted.length < list.length ? "A new preview is running: reload this page to show it." : "";
    for (const old of [...holder.children]) if (!wanted.some(item => item.id === old.dataset.id)) old.remove();
    for (const item of wanted) {
      if (holder.querySelector('[data-id="' + item.id + '"]')) continue;
      const figure = node("figure"); figure.dataset.id = item.id; figure.append(node("figcaption", item.id + " · " + item.label + " · " + item.origin));
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts allow-forms"); frame.referrerPolicy = "no-referrer"; frame.title = "Preview " + item.id; frame.src = item.origin + "/";
      figure.append(frame); holder.append(figure);
    }
  } catch { /* the room keeps working without previews */ }
}
async function poll() {
  previews();
  try { const response = await fetch("state.json", {cache:"no-store"}); if(response.ok) render(await response.json()); }
  catch { byId("banner").textContent = "Room disconnected. The last artifacts remain available."; }
  finally { setTimeout(poll, 1000); }
}
poll();`;

export const ROOM_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const ROOM_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Duel at the table</title><link rel="stylesheet" href="room.css"><script src="room.js" defer></script></head>
<body><header><p>at the table · duel</p><h1 id="topic">Waiting for the duel</h1><div id="banner" role="status">Participants are taking their seats.</div></header>
<main><section id="seats" aria-label="Seats"></section><section id="artifacts" aria-label="Artifacts"></section>
<section><h2>Judges' verdicts</h2><div id="verdicts"></div></section><section><h2>Dissents</h2><div id="dissents"></div></section>
<section><h2>At the table</h2><div id="turns"></div></section></main><footer id="spend">Estimated spend: $0.0000</footer></body></html>`;

export const ROOM_CSS = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151d;color:#eef2f7}body{margin:0;padding:24px;max-width:1500px;margin-inline:auto}header{margin-bottom:24px}header p{color:#91bdf3;letter-spacing:.1em}h1{font-size:clamp(24px,3vw,40px)}h2{font-size:20px}#banner{padding:16px;border:1px solid #6888ae;border-radius:12px;background:#1a2b42}#artifacts{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:24px 0}article,.seat,.verdict,.dissent{padding:16px;border:1px solid #34465c;border-radius:12px;background:#19222f}iframe{display:block;width:100%;height:480px;border:0;border-radius:8px;background:white}#seats,#verdicts,#dissents{display:flex;flex-wrap:wrap;gap:12px}.seat{flex:1;min-width:180px}.seat p{overflow-wrap:anywhere;margin:6px 0;color:#c3d1e1}.verdict[data-verdict=APPROVE]{border-color:#63c69a}.verdict[data-verdict=REVISE]{border-color:#eac26a}.verdict[data-verdict=REJECT]{border-color:#ee8c8c}.dissent{white-space:pre-wrap;flex:1;min-width:240px}#turns{max-height:420px;overflow-y:auto}#turns p{white-space:pre-wrap;padding:12px;border-bottom:1px solid #34465c}footer{margin-top:24px;color:#b8c8da}.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.tabs button{font:inherit;padding:4px 10px;border:1px solid #34465c;border-radius:6px;background:#10151d;color:#eef2f7;cursor:pointer}.tabs button[aria-selected=true]{border-color:#91bdf3;background:#1a2b42}pre.source{margin:0;height:480px;overflow:auto;padding:12px;border-radius:8px;background:#0b0f15;color:#dfe8f2;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.placeholder{padding:50px 12px;color:#c3d1e1}@media(max-width:800px){body{padding:12px}#artifacts{grid-template-columns:1fr}iframe{height:440px}}`;

/** All model-written strings enter the DOM through textContent. Frames survive state polling. */
export const ROOM_JS = `"use strict";
const byId = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if(text !== undefined) element.textContent = text; if(className) element.className = className; return element; };
const spendText = (usd, tokens, unit) => { tokens = tokens || 0; const money = "$" + usd.toFixed(4); if (tokens <= 0) return money; const count = tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1).replace(/\\.0$/, "") + "k"; const rest = count + " tok" + (unit ? " unpriced" : " (no price)"); return usd > 0 ? money + " + " + rest : rest; };
const artifactCards = new Map();
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
    card.append(node("strong", seat.name), node("p", (seat.team === "judge" ? "Judge" : "Team " + seat.team) + " · " + (seat.role || "participant")), node("p", seat.provider + " / " + seat.model), node("p", spendText(spend ? spend.costUsd : 0, spend && spend.unpricedTokens, false)));
    return card;
  }));
  for (const team of ["A", "B"]) {
    const prototype = state.prototypes.find(item => item.team === team);
    const version = prototype ? prototype.version : 0;
    if(artifactCards.get(team)?.version === version) continue;
    const card = node("article"); card.append(node("h2", "Team " + team + (prototype?.title ? " · " + prototype.title : "")));
    if(prototype?.ok && SOURCE_KINDS.includes(prototype.kind) && prototype.files.length) card.append(sourceView(team, prototype, version));
    else if(prototype?.ok && prototype.files.some(file => file.path === "index.html")) {
      const frame = node("iframe"); frame.title = "Team " + team + " artifact";
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
      frame.src = "p/" + team + "/index.html?v=" + version; card.append(frame);
    } else card.append(node("p", prototype?.error || "The builder is heads-down.", "placeholder"));
    const old = artifactCards.get(team); if(old) old.card.replaceWith(card); else byId("artifacts").append(card);
    artifactCards.set(team, {version, card});
  }
  byId("verdicts").replaceChildren(...state.assessments.map(item => {
    const card = node("article", undefined, "verdict"); card.dataset.verdict = item.verdict;
    card.append(node("strong", item.judge.name + " · Team " + item.team + " · " + item.verdict), node("p", item.reason)); return card;
  }));
  byId("dissents").replaceChildren(...state.dissents.map(item => node("article", item.seat.name + " · Team " + item.team + "\\n" + item.text, "dissent")));
  byId("turns").replaceChildren(...state.turns.map(item => node("p", item.seat.name + " · " + item.round + "\\n" + item.text)));
  byId("spend").textContent = "Estimated spend: " + spendText(state.usage.totalCostUsd, state.usage.totalUnpricedTokens, true);
}
async function poll() {
  try { const response = await fetch("state.json", {cache:"no-store"}); if(response.ok) render(await response.json()); }
  catch { byId("banner").textContent = "Room disconnected. The last artifacts remain available."; }
  finally { setTimeout(poll, 1000); }
}
poll();`;

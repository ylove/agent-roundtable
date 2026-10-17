// ============================================================================
// Execution dashboard: static stylesheet and script, served under <token>/static/
//
// They are string constants because tsc copies no asset files. The page CSP allows scripts and
// styles from 'self' only, so nothing on a page is inline: the script reads its settings from
// data-* attributes on <body> and changes the page through textContent and class names only.
// ============================================================================

export const DASHBOARD_CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e2e2e0;--accent:#2f6fde;
--ok:#187a40;--warn:#a5660a;--bad:#b3261e;--busy:#7a4cc2;--code:#f0f0ee;--banner:#fff1ef;--chip-bg:#f4f4f2;
--meas-fg:#0a5a4e;--meas-bg:#e3f4f0;--meas-line:#7cc7b9;--rep-fg:#1d4f9c;--rep-bg:#e6eefb;--rep-line:#8fb0e8;--est-fg:#7a4a00;--est-bg:#fff3dc;--est-line:#d9a441}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;
--accent:#7aa7ff;--ok:#5fd08e;--warn:#e3a54a;--bad:#ff8a80;--busy:#c3a1ff;--code:#25252a;--banner:#3a1f1d;--chip-bg:#26262b;
--meas-fg:#8ee0cf;--meas-bg:#14332d;--meas-line:#2f7f70;--rep-fg:#a9c7ff;--rep-bg:#172743;--rep-line:#3c609f;--est-fg:#ffd28a;--est-bg:#3a2a0c;--est-line:#a67a28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px 16px 48px}h1{font-size:1.4rem;margin:8px 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}
h3{font-size:1rem;margin:16px 0 6px}a{color:var(--accent)}.meta,.empty{color:var(--muted)}.meta{margin:0 0 12px}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--line);padding:0 0 8px}nav a{text-decoration:none}
nav a.here{font-weight:600;color:var(--fg)}
.live{color:var(--muted);font-size:.85rem;margin:8px 0}.live.fresh{color:var(--accent)}.live.gone{color:var(--bad)}
.banner{border:1px solid var(--bad);background:var(--banner);border-radius:8px;padding:10px 14px;margin:12px 0}
.banner h2{margin:0 0 6px;color:var(--bad)}.banner ul{margin:0}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card h3{margin:0 0 4px;font-size:.85rem;color:var(--muted);font-weight:500}.card .big{font-size:1.5rem;font-weight:600}
progress{width:100%;height:10px;accent-color:var(--ok)}td progress,dd progress{width:120px;vertical-align:middle}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
th,td{text-align:left;vertical-align:top;padding:6px 10px;border-bottom:1px solid var(--line)}th{font-weight:600;font-size:.85rem;color:var(--muted)}
td.num{white-space:nowrap}td.note{max-width:420px;overflow-wrap:anywhere}
.badge{display:inline-block;font-size:.8rem;padding:0 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.st-accepted,.st-completed,.st-passed,.st-resolved{color:var(--ok)}.st-ready,.st-running,.st-routed{color:var(--accent)}
.st-claimed,.st-in_progress,.st-open,.st-in_huddle{color:var(--warn)}.st-submitted,.st-checking,.st-merging{color:var(--busy)}
.st-blocked,.st-failed,.st-aborted,.st-awaiting_human,.st-timed_out{color:var(--bad)}
.st-pending,.st-paused,.st-cancelled,.st-created,.st-withdrawn,.st-unknown{color:var(--muted)}.st-alive{color:var(--ok)}.st-stale{color:var(--bad)}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap;
word-break:break-word;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.diff .add{color:var(--ok)}.diff .del{color:var(--bad)}.diff .hunk{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:4px 10px;margin:6px 0 12px;font-size:.9rem}.filters a.here{font-weight:600}
.pager{display:flex;gap:16px;margin:12px 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}blockquote{margin:8px 0;padding:0 12px;border-left:3px solid var(--line);color:var(--muted)}
.contract table{width:auto}.dagwrap{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
.dag .edge{fill:none;stroke:#8a94a6;stroke-width:1.5}.dag .bg{fill:#fafafa}.dag text{font:12px system-ui,-apple-system,sans-serif;fill:#1d1d1f}
.dag text.sub{font-size:11px;fill:#55555a}
@media (prefers-color-scheme:dark){.dag .bg{fill:#1d1d21}}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Usage page */
.hero{margin:8px 0 20px}.hero h1{margin:0 0 2px}.lead{font-size:1.15rem;margin:0 0 10px}
.hero-total{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}.hero-total .big{font-size:2.2rem;font-weight:700;line-height:1.1}
.hero-split{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.hero progress{max-width:420px;display:block;margin:6px 0 12px}
.plus{color:var(--muted)}.amt{font-weight:600;font-variant-numeric:tabular-nums}
.chip{display:inline-block;font-size:.78rem;line-height:1.5;padding:0 8px;border-radius:999px;border:1px solid var(--line);color:var(--fg);background:var(--chip-bg);white-space:nowrap}
.chip.platform{color:var(--muted);background:transparent;white-space:normal;overflow-wrap:anywhere;border-radius:10px;line-height:1.35;padding:1px 8px}
.prov-measured{color:var(--meas-fg);background:var(--meas-bg);border-color:var(--meas-line)}
.prov-reported{color:var(--rep-fg);background:var(--rep-bg);border-color:var(--rep-line)}
.prov-estimated{color:var(--est-fg);background:var(--est-bg);border:1px dashed var(--est-line)}
.prov-none{color:var(--muted)}
.legend{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;margin:12px 0 0;max-width:640px}.legend div{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:center}
.legend dt{margin:0}.legend dd{margin:0;color:var(--muted)}
.agent-cards{list-style:none;margin:0;padding:0;display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.agent-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:grid;gap:8px;align-content:start;min-height:244px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.agent-card.state-working{border-color:var(--accent)}.agent-card.state-stopped{border-color:var(--warn)}.agent-card.state-done{opacity:.92}
.card-top{display:grid;grid-template-columns:44px 1fr auto;gap:10px;align-items:center}
.who{min-width:0}.who h3{margin:0;font-size:1.05rem;color:var(--fg);font-weight:600;overflow-wrap:anywhere}
.avatar{--h:0;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;font-weight:700;font-size:.95rem;letter-spacing:.02em;background:hsl(var(--h) 50% 34%);color:#fff}
.av-0{--h:2}.av-1{--h:28}.av-2{--h:52}.av-3{--h:92}.av-4{--h:140}.av-5{--h:172}.av-6{--h:196}.av-7{--h:220}.av-8{--h:252}.av-9{--h:280}.av-10{--h:310}.av-11{--h:336}
.pill{display:inline-block;font-size:.8rem;padding:1px 10px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.pill.st-working{color:var(--accent)}.pill.st-idle{color:var(--muted)}.pill.st-done{color:var(--ok)}.pill.st-stopped,.pill.st-stopping{color:var(--warn)}
.money{font-size:1.1rem;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.tokens{color:var(--muted);font-size:.88rem}.prov-words{display:block;font-size:.8rem}
.share{display:grid;gap:2px;font-size:.85rem;color:var(--muted)}.share progress{width:100%}
.spark{width:100%;height:36px;color:var(--accent)}.spark .area{fill:currentColor;opacity:.14}.spark .line{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round}.spark .base{stroke:var(--line);stroke-width:1}
.card-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:36px;margin-top:auto}.note{color:var(--muted);font-size:.85rem;overflow-wrap:anywhere}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:5px 14px;min-height:36px}
button.stop,button.danger{border-color:var(--bad);color:var(--bad);font-weight:600}button.stop:hover,button.danger:hover{background:var(--banner)}
button[disabled]{cursor:default;opacity:.7}
.tablewrap{overflow-x:auto}.empty-state{padding:28px 0}.stops{margin:0;padding-left:20px}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--fg);padding:20px 22px;max-width:min(92vw,440px)}
dialog::backdrop{background:rgba(0,0,0,.45)}dialog h2{margin:0 0 8px}dialog p{margin:0 0 16px}.dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}
@media (prefers-reduced-motion:no-preference){.agent-card{transition:border-color .2s}.pill.st-working{animation:breathe 2.4s ease-in-out infinite}@keyframes breathe{50%{opacity:.6}}}
@media (max-width:480px){main{padding:12px 16px 40px}.hero-total .big{font-size:1.8rem}.legend div{grid-template-columns:1fr}.card-top{grid-template-columns:40px 1fr}.card-top .pill{grid-column:2}}
.card-top .pill{justify-self:start}
.agent-card:focus-visible,.live:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media (prefers-color-scheme:dark){.avatar{background:hsl(var(--h) 60% 72%);color:#141416}}
`;

/**
 * Live updates. The page names its event seq (data-seq); a server-sent "rev" event, or the
 * state.json poll that takes over when the stream fails, reports a newer seq. Pages marked
 * data-live="reload" then reload (at most every 3 s); data-live="swap" pages (Usage) fetch themselves
 * again and replace the content of #swap in place, so nothing jumps and an open dialog is left alone;
 * the others show a notice to reload.
 *
 * The Usage page's Stop buttons open a native dialog (Cancel focused); confirming sends
 * POST <token>/agents/<agent>/stop with X-Roundtable-Action set to the nonce in the page's <meta>.
 * The script changes the page through textContent, class names and node moves only.
 */
export const DASHBOARD_JS = `(function(){
var b=document.body,base=b.getAttribute("data-base"),seq=Number(b.getAttribute("data-seq"))||0;
var mode=b.getAttribute("data-live"),reload=mode==="reload",swap=mode==="swap",note=document.getElementById("live"),loaded=Date.now(),pending=false;
function say(text,cls){if(note){note.textContent=text;note.className="live "+cls}}
function announce(text){var a=document.getElementById("announce");if(a)a.textContent=text}
function states(){var m={},c=document.querySelectorAll("[data-agent]");for(var i=0;i<c.length;i++)m[c[i].getAttribute("data-agent")]=c[i].getAttribute("data-state");return m}
function move(into,from){into.replaceChildren.apply(into,Array.prototype.slice.call(from.childNodes))}
var refreshing=false,again=false;
function refresh(){var box=document.getElementById("swap");if(!box){location.reload();return}
if(refreshing||document.querySelector("dialog[open]")){again=true;return}
refreshing=true;
fetch(location.pathname,{cache:"no-store",headers:{Accept:"text/html"}}).then(function(r){if(!r.ok)throw new Error("status "+r.status);return r.text()})
.then(function(html){var doc=new DOMParser().parseFromString(html,"text/html"),next=doc.getElementById("swap");if(!next)throw new Error("no content");
if(document.querySelector("dialog[open]")){again=true;return}
var before=states(),ae=document.activeElement,fcard=ae&&ae.closest?ae.closest("[data-agent]"):null,fk=fcard?fcard.getAttribute("data-agent"):null,inbox=ae&&box.contains(ae),fbtn=ae&&ae.getAttribute?ae.getAttribute("data-stop"):null;
move(box,next);
var gone=!document.activeElement||document.activeElement===document.body||!document.body.contains(document.activeElement);
if(gone&&fk){var cs=document.querySelectorAll("[data-agent]"),to=null;for(var q=0;q<cs.length;q++){if(cs[q].getAttribute("data-agent")===fk){to=cs[q];if(fbtn){var bb=cs[q].querySelector("[data-stop]");if(bb)to=bb}}}
if(to)to.focus();else if(note){note.setAttribute("tabindex","-1");note.focus()}}else if(gone&&inbox&&note){note.setAttribute("tabindex","-1");note.focus()}
var meta=document.getElementById("runmeta"),fresh=doc.getElementById("runmeta");if(meta&&fresh)move(meta,fresh);
var s=Number(doc.body.getAttribute("data-seq"));if(s>seq)seq=s;
var after=states();for(var k in after){if(before[k]&&before[k]!==after[k])announce(k+" is now "+after[k]+".")}
say("This page follows the run as it happens. The Stop buttons are the one thing it can change.","live")})
.catch(function(){say("Could not refresh this page. Reload it to see the latest.","gone")})
.then(function(){refreshing=false;if(again){again=false;setTimeout(refresh,500)}})}
function changed(s){s=Number(s);if(!(s>seq))return;if(swap){refresh();seq=s;return}seq=s;
if(reload){if(!pending){pending=true;setTimeout(function(){location.reload()},Math.max(0,3000-(Date.now()-loaded)))}}
else say("New activity (event "+s+"). Reload the page to see it.","fresh")}
var dlg=document.getElementById("stop-dialog"),who=null;
function put(id,text){var e=document.getElementById(id);if(e)e.textContent=text}
function stop(agent){var meta=document.querySelector('meta[name="roundtable-action"]');
var btns=document.querySelectorAll("[data-stop]");for(var i=0;i<btns.length;i++){if(btns[i].getAttribute("data-stop")===agent){btns[i].textContent="Stopping\\u2026";btns[i].disabled=true;var cd=btns[i].closest("[data-agent]");if(cd)cd.focus()}}
say("Stopping "+agent+"\\u2026","fresh");announce("Stopping "+agent+".");
fetch(base+"agents/"+encodeURIComponent(agent)+"/stop",{method:"POST",headers:{"X-Roundtable-Action":meta?meta.getAttribute("content"):""},cache:"no-store",referrerPolicy:"no-referrer"})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}},function(){return{ok:r.ok,j:{}}})})
.then(function(x){if(x.ok){refresh()}else{say(x.j.error||"The stop was refused.","gone");refresh()}})
.catch(function(){say("The stop could not be sent. The dashboard may have closed.","gone")})}
document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target:null;if(!t)return;
var btn=t.closest("[data-stop]");
if(btn){who=btn.getAttribute("data-stop");if(dlg&&dlg.showModal){put("stop-name",who);put("stop-name2",who);dlg.showModal()}else if(window.confirm("Stop "+who+"? Its task will pause and the orchestrator will be asked to rework or write a handoff.")){stop(who)}return}
if(t.closest("#stop-cancel")){dlg.close();return}
if(t.closest("#stop-confirm")){dlg.close();stop(who)}});
if(dlg)dlg.addEventListener("close",function(){if(again){again=false;refresh()}});
var timer=null,fails=0;
function poll(){if(timer)return;timer=setInterval(function(){fetch(base+"state.json",{cache:"no-store"})
.then(function(r){if(!r.ok)throw new Error("status "+r.status);return r.json()})
.then(function(s){fails=0;changed(s.seq)})
.catch(function(){if(++fails>=3){clearInterval(timer);say("The dashboard has stopped: its runner is no longer serving it.","gone")}})},5000)}
if(!window.EventSource){poll();return}
var es=new EventSource(base+"stream?since="+seq),errors=0;
es.addEventListener("rev",function(e){errors=0;try{changed(JSON.parse(e.data).seq)}catch(x){}});
es.addEventListener("open",function(){errors=0});
es.addEventListener("error",function(){if(es.readyState===2||++errors>=3){es.close();poll()}});
})();`;

export const STATIC_ASSETS: Readonly<Record<string, { body: string; type: string }>> = {
  "dashboard.css": { body: DASHBOARD_CSS, type: "text/css; charset=utf-8" },
  "dashboard.js": { body: DASHBOARD_JS, type: "text/javascript; charset=utf-8" },
};

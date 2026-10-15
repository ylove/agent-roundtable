// ============================================================================
// Execution dashboard: static stylesheet and script, served under <token>/static/
//
// They are string constants because tsc copies no asset files. The page CSP allows scripts and
// styles from 'self' only, so nothing on a page is inline: the script reads its settings from
// data-* attributes on <body> and changes the page through textContent and class names only.
// ============================================================================

export const DASHBOARD_CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e2e2e0;--accent:#2f6fde;
--ok:#1f8a4c;--warn:#a5660a;--bad:#b3261e;--busy:#7a4cc2;--code:#f0f0ee;--banner:#fff1ef}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;
--accent:#7aa7ff;--ok:#5fd08e;--warn:#e3a54a;--bad:#ff8a80;--busy:#c3a1ff;--code:#25252a;--banner:#3a1f1d}}
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
`;

/**
 * Live updates. The page names its event seq (data-seq); a server-sent "rev" event, or the
 * state.json poll that takes over when the stream fails, reports a newer seq. Pages marked
 * data-live="reload" then reload (at most every 3 s); the others show a notice to reload.
 */
export const DASHBOARD_JS = `(function(){
var b=document.body,base=b.getAttribute("data-base"),seq=Number(b.getAttribute("data-seq"))||0;
var reload=b.getAttribute("data-live")==="reload",note=document.getElementById("live"),loaded=Date.now(),pending=false;
function say(text,cls){if(note){note.textContent=text;note.className="live "+cls}}
function changed(s){s=Number(s);if(!(s>seq))return;seq=s;
if(reload){if(!pending){pending=true;setTimeout(function(){location.reload()},Math.max(0,3000-(Date.now()-loaded)))}}
else say("New activity (event "+s+"). Reload the page to see it.","fresh")}
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

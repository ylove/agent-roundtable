// Requires a loopback listener. Run on a host that permits local HTTP servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRoom } from '../../dist/table/room.js';
import { runDuel } from '../../dist/table/duel.js';
import { createDuelControls } from '../../dist/table/controls.js';
import { fanout } from '../../dist/table/events.js';
import { json, stubFetch } from './helpers.mjs';

const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let text='';r.setEncoding('utf8');r.on('data',c=>text+=c);r.on('end',()=>resolve({status:r.statusCode,text}));}).on('error',reject));

test('one live room keeps the stopped version, then refreshes to the resumed chosen version',async t=>{
  const previous=process.env.OPENAI_COMPATIBLE_BASE_URL;process.env.OPENAI_COMPATIBLE_BASE_URL='http://127.0.0.1:1/v1';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_COMPATIBLE_BASE_URL;else process.env.OPENAI_COMPATIBLE_BASE_URL=previous;});
  stubFetch(t,(_url,init)=>{const request=JSON.parse(init.body),p=request.messages.at(-1).content,stage=/stage (\d) of/.exec(p)?.[1]??'1';
    const content=p.startsWith('R1b BUILD')?`<prototype kind="web" title="Stage ${stage}"><file path="index.html"><!doctype html><html><title>Stage ${stage}</title><h1>Stage ${stage}</h1></html></file></prototype>`:p.startsWith('R2 JUDGE')?'VERDICT A: APPROVE — clear\nVERDICT B: REVISE — thin\nPREFER: A':'A short turn';
    return json(200,{model:'m',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}});});
  const controls=createDuelControls(),room=await startRoom({controls,hold:false});t.after(()=>room.close());
  const seats=[['a','A'],['b','B'],['j','judge']].map(([name,team])=>({id:`${team}:${name}`,name,team,provider:'openai_compatible',model:'m'}));
  const events=[],observer=fanout(room.observer,{onEvent(e){events.push(e);if(e.type==='stage' && e.team==='A' && e.stage===1 && e.status==='done')controls.send({action:'stop'},'room');}});
  const stopped=await runDuel({topic:'An offline page',teamA:['a'],teamB:['b'],judges:['j'],stages:2,pageCheck:false},observer,new AbortController().signal,{controls,resolveSeats:()=>seats});
  assert.equal(stopped.resumable,true);assert.ok(!events.some(e=>e.type==='end'));
  const first=await get(new URL('p/A/index.html',room.url));assert.equal(first.status,200);assert.match(first.text,/Stage 1/);
  const resumed=await runDuel({resume:stopped.id},room.observer,new AbortController().signal,{controls,resolveSeats:()=>seats,replayHistory:false});
  assert.equal(resumed.winner,'A');assert.equal(resumed.chosen.version,2);
  const final=await get(new URL('p/A/index.html',room.url));assert.equal(final.status,200);assert.match(final.text,/Stage 2/);
});

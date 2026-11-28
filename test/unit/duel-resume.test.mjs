import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, lstat, symlink, mkdir, mkdtemp, readdir, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDuel } from '../../dist/table/duel.js';
import { createDuelControls } from '../../dist/table/controls.js';
import { checkpointPath, MAX_CHECKPOINT_BYTES } from '../../dist/table/checkpoint.js';
import { exportChosenArtifact, validateDuelOutputDir } from '../../dist/table/artifacts.js';
import { ROUNDTABLE_HOME } from '../../dist/config.js';
import { abortSession } from '../../dist/usage/session-scope.js';
import { getPrototypeFiles, replayDuel } from '../../dist/table/replay.js';
import { json, stubFetch } from './helpers.mjs';

const opts = { topic: 'A clear policy', teamA: ['a'], teamB: ['b'], judges: ['j'], kind: 'text', stages: 2, pageCheck: false };
const seats = [['a','A'],['b','B'],['j','judge']].map(([name,team]) => ({ id:`${team}:${name}`, name, team, provider:'openai_compatible', model:'m', reason:'chosen once', prompt:`PRIVATE PERSONA BODY ${name}` }));
const artifact = (team, stage, revision = false) => `<prototype kind="text" title="Policy ${team}"><file path="document.md"># ${team} stage ${stage}${revision ? ' revised' : ''}</file></prototype>`;
const verdict = 'VERDICT A: APPROVE — clear\nVERDICT B: REVISE — improve\nPREFER: A';
function provider(t, script = {}) {
  const before = process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1/v1';
  t.after(() => { if(before === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL; else process.env.OPENAI_COMPATIBLE_BASE_URL = before; });
  return stubFetch(t, async (_url, init) => {
    const req = JSON.parse(init.body), prompt = req.messages.at(-1).content, team = /Team ([AB])/.exec(prompt)?.[1];
    const round = prompt.startsWith('R1 CONCEPT') ? 'concept' : prompt.startsWith('R2 JUDGE') ? 'judge' : prompt.startsWith('R4 CLOSING') ? 'close' : prompt.includes('R3 REVISION') ? 'revise' : 'build';
    const stage = Number(/stage (\d) of/.exec(prompt)?.[1] ?? 1);
    const custom = await script.call?.({team, stage, round, prompt, signal:init.signal});
    const content = custom ?? (round === 'concept' ? `Concept ${team}` : round === 'judge' ? verdict : round === 'close' ? 'Closing.\n<DISSENT>\nclaim: Test this\npredicted_failure: Readers miss a rule\n</DISSENT>' : artifact(team, stage, round === 'revise'));
    return json(200, { model:req.model, choices:[{message:{content},finish_reason:'stop'}], usage:{prompt_tokens:100,completion_tokens:20} });
  });
}
const dependencies = controls => ({ controls, resolveSeats: () => seats.map(s=>({...s})) });
const signal = () => new AbortController().signal;
const textOf = call => call.body.messages.at(-1).content;

async function stoppedAtStage(t, { directSignal, external, stages = 2 } = {}) {
  const controls = createDuelControls(), controller = new AbortController(), events = [];
  const calls = provider(t);
  const result = await runDuel({...opts,stages}, {onEvent(e){events.push(e);if(e.type==='stage' && e.team==='A' && e.stage===1 && e.status==='done') {
    if(directSignal) controller.abort(); else if(external) abortSession(events[0].id,'Stop from usage'); else assert.equal(controls.send({action:'stop'},'room'),true);
  }}}, controller.signal, dependencies(controls));
  return {controls, events, result, calls};
}

test('controls enforce phase availability, permitted teams, sources, and queued commands', async () => {
  const c = createDuelControls();
  assert.deepEqual(c.available(), {stop:false,resume:false,choose:false});
  assert.equal(c.send({action:'stop'},'room'),false);
  c.runner.setAvailable({stop:true,choose:['A']});
  assert.equal(c.send({action:'choose',team:'B'},'room'),false);
  assert.equal(c.send({action:'choose',team:'A'},'unknown'),false);
  assert.equal(c.send({action:'chat',text:'change the brief'},'room'),false);
  assert.equal(c.send({action:'choose',team:'A'},'room'),true);
  assert.equal(c.send({action:'choose',team:'A'},'room'),false);
  assert.deepEqual(await c.runner.wait(), {command:{action:'choose',team:'A'},by:'room'});
  const abort = new AbortController(), pending = c.runner.wait(abort.signal); abort.abort(new Error('cancel command wait'));
  await assert.rejects(pending,/cancel command wait/);
});

for(const [label,config] of [['room',{}],['abort signal',{directSignal:true}],['session stop',{external:true}]]) test(`${label} stop writes a private checkpoint with no end event`, async t => {
  const {events,result,controls} = await stoppedAtStage(t,config);
  assert.equal(result.aborted,true); assert.equal(result.resumable,true); assert.equal(result.archivePath,undefined);
  assert.equal(events.some(e=>e.type==='end'),false);
  assert.equal(events.at(-1).type,'control'); assert.equal(events.at(-1).action,'stopped');
  const path = checkpointPath(result.id), body = await readFile(path,'utf8'), cp = JSON.parse(body);
  assert.equal((await stat(path)).mode & 0o777,0o600);
  assert.equal(cp.progress.phase,'build');
  assert.equal(cp.progress.teams.A.stages[0].status,'done');
  assert.equal(cp.progress.teams.A.metrics.versions,1);
  assert.equal(cp.options.stages,2);
  assert.equal(cp.seats[0].reason,'chosen once');
  assert.ok(!body.includes('PRIVATE PERSONA BODY') && !body.includes('"prompt"'));
  assert.ok(cp.archive.prototypes.length>0);
  assert.deepEqual(controls.available(),{stop:false,resume:true,choose:false});
});

test('resume skips completed concepts and stages, redoes an interrupted stage, and replays history first in a fresh room', async t => {
  const first = await stoppedAtStage(t), cp = JSON.parse(await readFile(checkpointPath(first.result.id),'utf8'));
  const events=[],offset=first.calls.length;
  const result=await runDuel({resume:first.result.id},{onEvent(e){events.push(e);}},signal(),dependencies(createDuelControls()));
  assert.equal(result.id,first.result.id); assert.equal(result.aborted,false);
  assert.deepEqual(events.slice(0,cp.archive.events.length),cp.archive.events);
  assert.equal(events[cp.archive.events.length].type,'start'); assert.equal(events[cp.archive.events.length].resumed,true);
  assert.equal(events[cp.archive.events.length+1].action,'resumed');
  const subsequent=first.calls.slice(offset).map(textOf);
  assert.ok(!subsequent.some(p=>p.startsWith('R1 CONCEPT') && /Team A/.test(p)));
  assert.ok(!subsequent.some(p=>p.startsWith('R1b BUILD') && /Team A/.test(p) && /stage 1 of/.test(p)));
  assert.ok(subsequent.some(p=>p.startsWith('R1b BUILD') && /Team A/.test(p) && /stage 2 of/.test(p)));
  assert.equal(result.metrics.A.stagesDone,2);
  assert.equal(result.chosen.team,'A');
  await assert.rejects(stat(checkpointPath(result.id)),{code:'ENOENT'});
  const replayed=[];
  await replayDuel(result.archivePath,{onEvent(e){replayed.push(e);}},{speed:1e9});
  assert.ok(replayed.some(e=>e.type==='start' && e.resumed));
  assert.ok(replayed.filter(e=>e.type==='prototype' && e.ok).every(e=>getPrototypeFiles(e).length===1));
  await assert.rejects(runDuel({resume:result.id},{onEvent(){}},signal(),dependencies(createDuelControls())),/finished/);
});

test('same-process resume does not repeat history and excludes stopped wall time from team metrics', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const first=await stoppedAtStage(t), before=first.result.metrics.A.elapsedMs;
  t.mock.timers.tick(86_400_000);
  const events=[];
  const result=await runDuel({resume:first.result.id},{onEvent(e){events.push(e);}},signal(),{...dependencies(first.controls),replayHistory:false});
  assert.equal(events[0].type,'start'); assert.equal(events[0].resumed,true);
  assert.ok(result.metrics.A.elapsedMs < before+1000);
  assert.ok(result.metrics.A.inputTokens >= first.result.metrics.A.inputTokens);
});

test('a stopped in-flight call is abandoned, metered and redone, even if it ignores abort', async t => {
  const controls=createDuelControls(), events=[];
  let stopped=false;
  provider(t,{call({round,team}){if(round==='concept' && team==='A' && !stopped){stopped=true;queueMicrotask(()=>controls.send({action:'stop'},'room'));return new Promise(()=>{});}}});
  const result=await runDuel(opts,{onEvent(e){events.push(e);}},signal(),dependencies(controls));
  assert.equal(result.resumable,true); assert.equal(result.metrics.A.failedTurns,1);
  assert.ok(result.metrics.A.inputTokens>0); assert.equal(result.metrics.A.estimated,true);
  const cp=JSON.parse(await readFile(checkpointPath(result.id),'utf8'));
  assert.equal(cp.progress.teams.A.conceptDone,false);
  const resumed=await runDuel({resume:result.id},{onEvent(){}},signal(),{...dependencies(controls),replayHistory:false});
  assert.equal(resumed.aborted,false); assert.equal(resumed.metrics.A.failedTurns,1);
});

test('resume refuses bad ids, missing, malformed, tampered, oversized and symlink checkpoints before calling a provider', async t => {
  const first=await stoppedAtStage(t), path=checkpointPath(first.result.id), good=await readFile(path,'utf8'), offset=first.calls.length;
  const resume=()=>runDuel({resume:first.result.id},{onEvent(){}},signal(),dependencies(createDuelControls()));
  for(const id of ['../bad','/tmp/file','duel-../../bad','bad']) await assert.rejects(runDuel({resume:id},{onEvent(){}},signal()),/duel id/);
  await assert.rejects(runDuel({resume:'duel-missing'},{onEvent(){}},signal()),/No checkpoint/);
  await assert.rejects(runDuel({resume:first.result.id,topic:'override'},{onEvent(){}},signal()),/only a duel id/);
  await writeFile(path,'{'); await assert.rejects(resume(),/Malformed/);
  for(const mutate of [
    c=>{c.progress.phase='finished';},
    c=>{c.progress.teams.A.metrics.rewrites=-1;},
    c=>{c.progress.teams.A.submission.files[0].path='../escape';},
    c=>{c.archive.prototypes[0].files[0].path='../escape';},
    c=>{c.seats[0].prompt='injected';},
    c=>{c.progress.teams.A.stages[0].status='started';},
    c=>{c.usage[0].inputTokens=-1;},
    c=>{c.options.stages=5;},
    c=>{c.progress.teams.A.submission.files[0].content='tampered';},
  ]) {const cp=JSON.parse(good);mutate(cp);await writeFile(path,JSON.stringify(cp));await assert.rejects(resume(),/Malformed|tampered/);}
  await writeFile(path,good); await truncate(path,MAX_CHECKPOINT_BYTES+1); await assert.rejects(resume(),/10 MB/);
  const other=path+'.saved';await writeFile(other,good);const {rm}=await import('node:fs/promises');await rm(path);await symlink(other,path);await assert.rejects(resume());
  assert.equal(first.calls.length,offset);
});

test('human judges may omit judges; only valid teams are accepted and their chosen files survive sandbox cleanup', async t => {
  provider(t,{call({round,team}){if(round==='build' && team==='A')return 'invalid artifact';}});
  const controls=createDuelControls(), events=[];
  const result=await runDuel({...opts,humanJudge:true,judges:undefined,stages:1},{onEvent(e){events.push(e);if(e.type==='decision' && e.status==='awaiting'){
    assert.equal(controls.available().choose,true);
    assert.equal(controls.send({action:'choose',team:'A'},'room'),false);
    assert.equal(controls.send({action:'choose',team:'B'},'room'),true);
  }}},signal(),{...dependencies(controls),resolveSeats:()=>seats.filter(s=>s.team!=='judge').map(s=>({...s}))});
  assert.equal(result.winner,'B');assert.equal(result.decidedBy,'human');assert.deepEqual(result.tally,{A:0,B:0});
  const awaiting=events.findIndex(e=>e.type==='decision' && e.status==='awaiting'),made=events.findIndex(e=>e.type==='decision' && e.status==='made');
  assert.ok(awaiting<made && made<events.findIndex(e=>e.type==='turn' && e.round==='R4'));
  assert.deepEqual(events.at(-1).chosen,result.chosen);
  const dir=join(ROUNDTABLE_HOME,result.chosen.dir);
  assert.equal((await stat(dir)).mode & 0o777,0o700);
  assert.equal((await stat(join(dir,'document.md'))).mode & 0o777,0o600);
  assert.match(await readFile(join(dir,'document.md'),'utf8'),/B stage 1/);
});

test('stop while awaiting a human decision checkpoints decide and resumes without rebuilding or rejudging', async t => {
  const calls=provider(t),controls=createDuelControls();
  const first=await runDuel({...opts,humanJudge:true},{onEvent(e){if(e.type==='decision' && e.status==='awaiting')controls.send({action:'stop'},'room');}},signal(),dependencies(controls));
  const cp=JSON.parse(await readFile(checkpointPath(first.id),'utf8'));assert.equal(cp.progress.phase,'decide');
  const offset=calls.length, events=[];
  const result=await runDuel({resume:first.id},{onEvent(e){events.push(e);if(e.type==='decision' && e.status==='awaiting')controls.send({action:'choose',team:'B'},'terminal');}},signal(),{...dependencies(controls),replayHistory:false});
  assert.equal(result.winner,'B');assert.equal(result.decidedBy,'human');assert.equal(result.tally.A,1);
  assert.ok(calls.slice(offset).every(c=>textOf(c).startsWith('R4 CLOSING')));
  assert.equal(events.filter(e=>e.type==='assessment').length,0);
});

test('human decision has no deadline while awaiting a choice', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  provider(t);const controls=createDuelControls();
  const result=await runDuel({...opts,humanJudge:true,maxSeconds:1},{onEvent(e){if(e.type==='decision' && e.status==='awaiting'){
    t.mock.timers.tick(3_600_000);assert.equal(controls.send({action:'choose',team:'A'},'room'),true);
  }}},signal(),dependencies(controls));
  assert.equal(result.winner,'A');assert.equal(result.aborted,false);assert.ok(result.metrics.A.elapsedMs<1000);
});

test('resuming after judging or a closing turn repeats no completed turns', async t => {
  for(const round of ['R2','R4']) await t.test(round,async child=>{
    const calls=provider(child),controls=createDuelControls();let stopped=false;
    const first=await runDuel(opts,{onEvent(e){if(e.type==='turn' && e.round===round && !stopped){stopped=true;controls.send({action:'stop'},'room');}}},signal(),dependencies(controls));
    const offset=calls.length;
    const result=await runDuel({resume:first.id},{onEvent(){}},signal(),{...dependencies(controls),replayHistory:false});
    assert.equal(result.aborted,false);
    assert.ok(!calls.slice(offset).some(c=>textOf(c).startsWith('R2 JUDGE')));
    if(round==='R4')assert.equal(calls.filter(c=>textOf(c).startsWith('R4 CLOSING')).length,2);
  });
});

test('chosen artifacts use the kept valid version, while ties choose nothing', async t => {
  provider(t,{call({round,team}){if(round==='judge')return 'VERDICT A: REVISE — revise\nVERDICT B: REJECT — weak\nPREFER: A';if(round==='revise' && team==='A')return 'invalid revision';}});
  const result=await runDuel({...opts,rounds:2},{onEvent(){}},signal(),dependencies(createDuelControls()));
  assert.equal(result.chosen.team,'A');assert.equal(result.chosen.version,2);
  assert.match(await readFile(join(ROUNDTABLE_HOME,result.chosen.dir,'document.md'),'utf8'),/A stage 2$/);
  const tieEvents=[];
  // Reuse the same provider hook with no judges only via human? A tie needs advisory verdicts.
  const tied=await runDuel({...opts,maxSeconds:0},{onEvent(e){tieEvents.push(e);}},signal(),dependencies(createDuelControls()));
  assert.equal(tied.chosen,undefined);assert.equal(tied.winner,'none');assert.equal(tied.resumable,undefined);
});

test('--out exports only into absent or empty real directories and refuses symlinks and overwrites', async t => {
  provider(t);
  const result=await runDuel(opts,{onEvent(){}},signal(),dependencies(createDuelControls()));
  const root=await mkdtemp(join(tmpdir(),'duel-out-'));t.after(async()=>{const{rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true});});
  for(const name of ['new','empty']){
    const out=join(root,name);if(name==='empty')await mkdir(out);
    exportChosenArtifact(result.chosen,out);
    assert.match(await readFile(join(out,'document.md'),'utf8'),/A stage 2/);
    assert.equal((await stat(join(out,'document.md'))).mode & 0o777,0o600);
    assert.throws(()=>exportChosenArtifact(result.chosen,out),/empty real directory/);
  }
  const symlinkPath=join(root,'link');await symlink(join(root,'empty'),symlinkPath);
  assert.throws(()=>validateDuelOutputDir(symlinkPath),/symlinks/);
  const file=join(root,'file');await writeFile(file,'keep');assert.throws(()=>validateDuelOutputDir(file),/empty real/);
  assert.equal(await readFile(file,'utf8'),'keep');
  assert.throws(()=>exportChosenArtifact({...result.chosen,files:['../escape']},join(root,'bad')),/Invalid chosen/);
});

test('an interrupted stage is redone, and completed stages and persona turns stay completed', async t => {
  const controls=createDuelControls();let interrupted=false;
  const calls=provider(t,{call({round,team,stage,signal}){
    if(round==='build' && team==='A' && stage===2 && !interrupted){interrupted=true;queueMicrotask(()=>controls.send({action:'stop'},'room'));return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
  }});
  const first=await runDuel(opts,{onEvent(){}},signal(),dependencies(controls));
  const cp=JSON.parse(await readFile(checkpointPath(first.id),'utf8'));
  assert.equal(cp.progress.teams.A.stages.at(-1).status,'started');assert.equal(cp.progress.teams.A.metrics.stagesDone,1);
  const offset=calls.length,result=await runDuel({resume:first.id},{onEvent(){}},signal(),{...dependencies(controls),replayHistory:false});
  assert.equal(result.metrics.A.stagesDone,2);
  assert.equal(calls.slice(offset).filter(c=>textOf(c).startsWith('R1b BUILD') && /Team A/.test(textOf(c))).length,1);
  assert.ok(!calls.slice(offset).some(c=>textOf(c).startsWith('R1 CONCEPT')));
});

test('resume restores selected models but reloads persona bodies, and completed critics are not called again',async t=>{
  const controls=createDuelControls();let stopOnce=true,criticCalls=0;
  const teamSeats=[{...seats[0],id:'A:lead',name:'lead'},{...seats[0],id:'A:critic',name:'critic'},{...seats[0],id:'A:builder',name:'builder'},seats[1],seats[2]];
  const calls=provider(t,{call({prompt}){if(prompt.startsWith('R1c CRITIQUE')){criticCalls++;return 'A completed critique';}}});
  const first=await runDuel({...opts,teamA:['lead','critic','builder']},{onEvent(e){if(e.type==='turn' && e.round==='R1c' && stopOnce){stopOnce=false;controls.send({action:'stop'},'room');}}},signal(),{controls,resolveSeats:()=>teamSeats});
  const cp=JSON.parse(await readFile(checkpointPath(first.id),'utf8'));assert.deepEqual(cp.progress.teams.A.completedCritics,['A:critic']);
  const offset=calls.length;
  await runDuel({resume:first.id},{onEvent(){}},signal(),{controls,replayHistory:false,resolveSeats:()=>teamSeats.map(s=>({...s,model:'different-model',prompt:'NEW PERSONA BODY'}))});
  assert.equal(criticCalls,1);assert.ok(calls.slice(offset).every(c=>c.body.model==='m'));
  assert.ok(calls.slice(offset).every(c=>c.body.messages[0].content.includes('NEW PERSONA BODY')));
  assert.ok(calls.slice(offset).some(c=>textOf(c).includes('A completed critique')));
});

test('resumed deadlines receive at least 60 seconds after the previous active budget was spent',async t=>{
  const first=await stoppedAtStage(t),path=checkpointPath(first.result.id),cp=JSON.parse(await readFile(path,'utf8'));
  cp.activeMs=cp.options.maxSeconds*1000;await writeFile(path,JSON.stringify(cp));
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  let checked=false;
  const result=await runDuel({resume:first.result.id},{onEvent(e){if(e.type==='start' && e.resumed){t.mock.timers.tick(59_000);checked=true;}}},signal(),{...dependencies(createDuelControls()),replayHistory:false});
  assert.equal(checked,true);assert.equal(result.metrics.A.stagesDone,2);assert.equal(result.aborted,false);
});

test('equal judge verdicts choose no artifact',async t=>{
  provider(t,{call({round}){if(round==='judge')return 'VERDICT A: APPROVE — clear\nVERDICT B: APPROVE — clear';}});
  const result=await runDuel(opts,{onEvent(){}},signal(),dependencies(createDuelControls()));
  assert.equal(result.winner,'tie');assert.equal(result.chosen,undefined);assert.equal(result.decidedBy,'judges');
});

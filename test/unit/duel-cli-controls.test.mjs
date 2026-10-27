import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { parseTableArgs, runTableCli } from '../../dist/cli-table.js';
import { createDuelControls } from '../../dist/table/controls.js';
import { runDuel } from '../../dist/table/duel.js';
import { saveChosenArtifact } from '../../dist/table/artifacts.js';
import { json, stubFetch } from './helpers.mjs';

const sink=()=>{let value='';return{write(s){value+=s;},read:()=>value};};
const id='duel-cli-test';
const result={id,winner:'A',tally:{A:1,B:0},aborted:false};
const roster=['A clear policy','--team-a','a','--team-b','b','--judges','j','--seat','a=openai_compatible:m,b=openai_compatible:m,j=openai_compatible:m','--no-preflight'];
function env(t){
  const previous=process.env.OPENAI_COMPATIBLE_BASE_URL;process.env.OPENAI_COMPATIBLE_BASE_URL='http://127.0.0.1:1/v1';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_COMPATIBLE_BASE_URL;else process.env.OPENAI_COMPATIBLE_BASE_URL=previous;});
  mkdirSync(process.env.ROUNDTABLE_AGENTS_DIR,{recursive:true});for(const n of ['a','b','j'])writeFileSync(join(process.env.ROUNDTABLE_AGENTS_DIR,n+'.md'),`You are ${n}.\n`);
}
function fixture(run, onEvent=()=>{}){
  const state={runs:[],roomOptions:undefined,closed:0};
  const modules={duel:async()=>({runDuel:async(opts,obs,signal,seats,deps)=>{state.runs.push({opts,signal,seats,deps});return run(opts,obs,signal,deps,state);}}),
    room:async()=>({createRoom:async options=>{state.roomOptions=options;return{onEvent,close(){state.closed++;}};}}),
    replay:async()=>{throw new Error('not a replay');}};
  return{state,modules};
}
const start=obs=>obs.onEvent({type:'start',id,topic:'A clear policy',mode:'duel',seats:[],startedAt:new Date().toISOString()});

test('CLI validates stage, human judge, resume conflicts and layout flags',()=>{
  for(const stages of ['1','2','3','4'])assert.equal(parseTableArgs('duel',[...roster,'--stages',stages]).options.stages,Number(stages));
  for(const value of ['0','5','1.5','NaN'])assert.throws(()=>parseTableArgs('duel',[...roster,'--stages',value]),/stages/);
  const human=parseTableArgs('duel',['brief','--team-a','a','--team-b','b','--human-judge']);assert.deepEqual(human.options.judges,[]);assert.equal(human.options.humanJudge,true);
  for(const layout of ['auto','split','stack'])assert.equal(parseTableArgs('duel',[...roster,'--layout',layout]).flags.layout,layout);
  assert.throws(()=>parseTableArgs('duel',[...roster,'--layout','rows']),/layout/);
  for(const args of [['brief','--resume',id],['--resume','../file'],...['team-a','team-b','judges','seat','kind','criteria','stages','rounds','agents-dir','max-seconds','connectors'].map(flag=>['--resume',id,'--'+flag,'x']),['--resume',id,'--human-judge'],['--resume',id,'--replay','archive.json'],['--resume',id,'--dry-run']])assert.throws(()=>parseTableArgs('duel',args));
  assert.deepEqual(parseTableArgs('duel',['--resume',id,'--layout','split','--out','winner','--no-room']).options,{resume:id});
  assert.throws(()=>parseTableArgs('meeting',['topic','--agents','a,b','--stages','2']),/available for duel/);
});

test('human judge without a room requires a TTY before resolving seats or calling providers',async()=>{
  const input=new PassThrough(),output=sink(),error=sink();
  const code=await runTableCli('duel',['brief','--team-a','missing-a','--team-b','missing-b','--human-judge','--no-room'],{input,output,error});
  assert.equal(code,2);assert.match(error.read(),/requires a TTY/);
});

test('TTY human choice prompts and rejects a team without a valid artifact',async t=>{
  env(t);const input=new PassThrough();input.isTTY=true;
  const {modules}=fixture(async(opts,obs,_signal,deps)=>{
    assert.equal(opts.humanJudge,true);const controls=deps.controls;
    controls.runner.setAvailable({stop:true,choose:['A']});
    await start(obs);await obs.onEvent({type:'decision',status:'awaiting',ts:new Date().toISOString()});
    setImmediate(()=>input.write('B\nA\n'));
    const message=await controls.runner.wait();assert.equal(message.command.team,'A');
    await obs.onEvent({type:'decision',status:'made',by:'human',winner:'A',ts:new Date().toISOString()});
    return{...result,decidedBy:'human'};
  });
  const output=sink(),error=sink();
  const code=await runTableCli('duel',['brief','--team-a','a','--team-b','b','--seat','a=openai_compatible:m,b=openai_compatible:m','--human-judge','--no-room','--no-preflight','--json'],{input,output,error,modules});
  assert.equal(code,0,error.read());assert.match(error.read(),/Choose the winner \[A\/B\]:/);assert.match(error.read(),/valid artifact/);
});

test('room and runner share controls; a held room resumes in-process with fresh cancellation and no replay',async t=>{
  env(t);let control;
  const {state,modules}=fixture(async(opts,obs,signal,deps,state)=>{
    const c=deps.controls;assert.equal(c,control);await start(obs);
    if(!opts.resume){
      c.runner.setAvailable({stop:true});
      const stopped=new Promise(resolve=>c.runner.onStop(resolve));
      setImmediate(()=>process.emit('SIGINT'));await stopped;
      await obs.onEvent({type:'control',action:'stopped',by:'terminal',ts:new Date().toISOString()});
      c.runner.setAvailable({resume:true});c.runner.onStop(undefined);
      return{...result,winner:'none',aborted:true,resumable:true};
    }
    assert.deepEqual(opts,{resume:id});assert.equal(deps.replayHistory,false);assert.equal(deps.resumeBy,'room');assert.equal(signal.aborted,false);
    setImmediate(()=>process.emit('SIGINT'));return result;
  },e=>{if(e.type==='control' && e.action==='stopped')setImmediate(()=>control.send({action:'resume'},'room'));});
  const createRoom=modules.room;modules.room=async()=>{const m=await createRoom();return{createRoom:async options=>{control=options.controls;return m.createRoom(options);}};};
  const error=sink(),before=process.listenerCount('SIGINT');
  const code=await runTableCli('duel',[...roster,'--json'],{modules,output:sink(),error});
  assert.equal(code,0,error.read());assert.equal(state.runs.length,2);assert.equal(state.closed,1);assert.equal(process.listenerCount('SIGINT'),before);
  assert.doesNotMatch(error.read(),/Resume with:/);
});

for(const flags of [['--no-room'],['--no-hold'],[]])test(`a stopped CLI prints a resume command and exits 1 (${flags.join(' ')||'held room, second Ctrl-C'})`,async t=>{
  env(t);const output=sink(),error=sink();
  const {state,modules}=fixture(async(_opts,obs,signal,deps)=>{
    await start(obs);deps.controls.runner.setAvailable({stop:true});
    const done=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    setImmediate(()=>process.emit('SIGINT'));await done;
    await obs.onEvent({type:'control',action:'stopped',by:'terminal',ts:new Date().toISOString()});
    deps.controls.runner.setAvailable({resume:true});
    if(!flags.length)setImmediate(()=>process.emit('SIGINT'));
    return{...result,winner:'none',aborted:true,resumable:true};
  });
  const code=await runTableCli('duel',[...roster,'--json',...flags],{modules,output,error});
  assert.equal(code,1);assert.match(error.read(),new RegExp(`Resume with: roundtable duel --resume ${id}`));assert.ok(!output.read().includes('"type":"end"'));
  assert.equal(state.closed,flags.includes('--no-room')?0:1);
});

test('CLI resume reads saved options and skips persona/provider preparation',async t=>{
  const c=createDuelControls();const checkpoint=await runDuel({topic:'brief',teamA:['not-installed-a'],teamB:['not-installed-b'],judges:['not-installed-j'],kind:'text'},
    {onEvent(e){if(e.type==='start')c.send({action:'stop'},'tool');}},new AbortController().signal,{controls:c,resolveSeats:()=>[['not-installed-a','A'],['not-installed-b','B'],['not-installed-j','judge']].map(([name,team])=>({id:`${team}:${name}`,name,team,provider:'openai',model:'m'}))});
  const calls=stubFetch(t,()=>{throw new Error('No preparation requests');});
  const {state,modules}=fixture(async(opts,_obs,_signal,deps)=>{assert.deepEqual(opts,{resume:checkpoint.id});assert.ok(deps.controls);return result;});
  const error=sink();assert.equal(await runTableCli('duel',['--resume',checkpoint.id,'--no-room','--no-hold'],{modules,error,output:sink()}),0,error.read());
  assert.equal(calls.length,0);assert.equal(state.runs[0].seats,undefined);
});

test('CLI validates --out before calls and exports the chosen files before holding the room',async t=>{
  env(t);const root=mkdtempSync(join(tmpdir(),'duel-cli-out-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const chosen=saveChosenArtifact('duel-cli-export','A',1,[{path:'src/main.txt',content:'kept winner'}]);
  const {state,modules}=fixture(async()=>{setImmediate(()=>{assert.equal(readFileSync(join(root,'out','src/main.txt'),'utf8'),'kept winner');process.emit('SIGINT');});return{...result,chosen};});
  const error=sink();assert.equal(await runTableCli('duel',[...roster,'--out',join(root,'out')],{modules,error,output:sink()}),0,error.read());
  assert.equal(state.closed,1);
  const offset=state.runs.length;assert.equal(await runTableCli('duel',[...roster,'--out',join(root,'out'),'--no-hold'],{modules,error,output:sink()}),2);
  assert.equal(state.runs.length,offset);assert.equal(readFileSync(join(root,'out','src/main.txt'),'utf8'),'kept winner');
});

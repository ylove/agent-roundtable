import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { START_DUEL_SCHEMA, startDuelTool } from '../../dist/tools/duel.js';
import { ROUNDTABLE_HOME } from '../../dist/config.js';
import { json, stubFetch } from './helpers.mjs';

test('MCP accepts only integer stages 1–4 and returns metrics plus chosen paths without source',async t=>{
  assert.deepEqual({type:START_DUEL_SCHEMA.properties.stages.type,min:START_DUEL_SCHEMA.properties.stages.minimum,max:START_DUEL_SCHEMA.properties.stages.maximum},{type:'integer',min:1,max:4});
  assert.equal(START_DUEL_SCHEMA.properties.human_judge,undefined);assert.equal(START_DUEL_SCHEMA.properties.resume,undefined);
  const previous=process.env.OPENAI_COMPATIBLE_BASE_URL;process.env.OPENAI_COMPATIBLE_BASE_URL='http://127.0.0.1:1/v1';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_COMPATIBLE_BASE_URL;else process.env.OPENAI_COMPATIBLE_BASE_URL=previous;});
  const dir=process.env.ROUNDTABLE_AGENTS_DIR;mkdirSync(dir,{recursive:true});for(const name of ['tool-a','tool-b','tool-j'])writeFileSync(join(dir,`${name}.md`),`You are ${name}.\n`);
  const calls=stubFetch(t,(_url,init)=>{const req=JSON.parse(init.body),prompt=req.messages.at(-1).content;
    const content=prompt.startsWith('R1b BUILD')?'<prototype kind="text" title="Policy"><file path="document.md">The secret policy source.</file></prototype>':prompt.startsWith('R2 JUDGE')?'VERDICT A: APPROVE — clear\nVERDICT B: REVISE — thin\nPREFER: A':'A short turn';
    return json(200,{model:req.model,choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}});});
  const args={topic:'Policy',team_a:['tool-a'],team_b:['tool-b'],judges:['tool-j'],kind:'text',stages:3,provider:'openai_compatible',seats:Object.fromEntries(['tool-a','tool-b','tool-j'].map(name=>[name,{provider:'openai_compatible',model:'m'}]))};
  for(const stages of [0,5,1.5,'2',null])await assert.rejects(startDuelTool({...args,stages}),/stages/);
  for(const extra of [{resume:'duel-test'},{human_judge:true}])await assert.rejects(startDuelTool({...args,...extra}),/CLI-only/);
  assert.equal(calls.length,0);
  const progress=[],reply=await startDuelTool(args,{progress:(...p)=>progress.push(p)}),out=JSON.parse(reply.content[0].text);
  assert.equal(out.metrics.A.stagesDone,3);assert.equal(out.metrics.B.versions,3);assert.equal(out.chosen.team,'A');assert.equal(out.chosen.version,3);
  assert.deepEqual(out.chosen.files,['document.md']);assert.equal(out.chosen.dir,`duels/${out.duel_id}/chosen`);
  assert.equal(await readFile(join(ROUNDTABLE_HOME,out.chosen.dir,'document.md'),'utf8'),'The secret policy source.');
  assert.ok(!reply.content[0].text.includes('The secret policy source.'));assert.ok(!reply.content[0].text.includes(ROUNDTABLE_HOME));
  assert.ok(progress.some(p=>p[2].startsWith('stage')));
});

import { basename } from 'node:path';
import { spawn } from 'node:child_process';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(`${name} fixture 1.0`); process.exit(0); }
const input = async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text; };
switch (name) {
  case 'duel-runtime': {
    const prompt = (await input()).split('user:\n').at(-1);
    if (prompt.startsWith('R1b BUILD')) console.log('<prototype kind="text" title="Proposal"><file path="proposal.md">A useful proposal.</file></prototype>');
    else if (prompt.startsWith('R2 JUDGE')) console.log('VERDICT A: APPROVE — Useful\nVERDICT B: APPROVE — Useful');
    else console.log('Runtime contribution.');
    break;
  }
  case 'hermes': console.log('\u001b[36m╭──────╮\nHermes Agent fixture\n╰──────╯\u001b[0m\nA useful answer.'); break;
  case 'openclaw': console.log('Gateway answer.'); break;
  case 'gemini': console.log(JSON.stringify({ response: 'Structured answer.', stats: { tokens: { input: 11, output: 7 }, cost: 0.012 } })); break;
  case 'codex':
    await input();
    for (const event of [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Earlier answer.' } },
      { type: 'item.completed', item: { type: 'command_execution', text: 'Ignore this.' } },
      { type: 'item.completed', item: { type: 'assistant_message', text: 'Final answer.' } },
      { type: 'turn.completed', usage: { input_tokens: 15, output_tokens: 9 } },
    ]) console.log(JSON.stringify(event));
    break;
  case 'fail': console.error(`Failed with ${process.env.FIXTURE_SECRET || ''}`); process.exitCode = 23; break;
  case 'hang': {
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' });
    console.error(`descendant=${child.pid}`);
    setInterval(() => {}, 1000);
    break;
  }
  case 'oversize': process.stdout.write('x'.repeat(200_000)); break;
  case 'oversize-stderr': process.stderr.write('x'.repeat(200_000)); break;
  case 'env-dump': console.log(JSON.stringify(process.env)); break;
  case 'argv-echo': console.log(JSON.stringify({ args, stdin: await input(), cwd: process.cwd() })); break;
  case 'json-output': console.log(await input()); break;
  default: throw new Error('Unknown fixture');
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-agent-limits-cli-'));
const bin = join(directory, 'bin');
const state = join(directory, 'state');
const file = join(directory, 'workflow.ts');
const cli = (...args) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30_000,
  });
try {
  mkdirSync(bin);
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const agent = `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const provider=path.basename(process.argv[1]);
if(process.argv.includes('--version')){console.log(provider==='claude'?'2.1.283':'0.157.1');process.exit(0);}
let prompt='';process.stdin.on('data',data=>prompt+=data);process.stdin.on('end',()=>{
 const log=kind=>fs.appendFileSync('agents.jsonl',JSON.stringify({kind,provider,pid:process.pid})+'\\n');
 log('start');
 const wait=setInterval(()=>{
  if(fs.readFileSync('agents.jsonl','utf8').trim().split('\\n').filter(line=>JSON.parse(line).kind==='start').length<3)return;
  clearInterval(wait);setTimeout(()=>{
   log('end');
   if(provider==='claude')console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'}));
   else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}})+'\\n'+JSON.stringify({type:'turn.completed'}));
  },200);
 },10);
});`;
  writeFileSync(join(bin, 'claude'), agent, { mode: 0o700 });
  writeFileSync(join(bin, 'codex'), agent, { mode: 0o700 });
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';import {appendFileSync,existsSync} from 'node:fs';
appendFileSync('imports','import\\n');
export default defineWorkflow({name:'agent-limits-cli',version:'1',input:z.object({}),output:z.number(),async run(ctx){
 await ctx.map('outer',[0,1,2],{concurrency:3},async()=>ctx.map('inner',[0,1],{concurrency:2},async provider=>ctx[provider===0?'codex':'claude'].text('ask',{prompt:'x'})));
 if(existsSync('pause'))throw new Error('tail pause');return 6;
}});`,
  );
  for (const bad of [
    ['--max-agents', '0'],
    ['--max-agents', '-1'],
    ['--max-agents', '1.5'],
    ['--provider-limit', 'codex=0'],
    ['--provider-limit', 'codex=1.5'],
  ]) {
    const result = cli('execute', file, ...bad);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(join(directory, 'imports')), false);
  }
  writeFileSync(join(directory, 'pause'), 'pause');
  const args = ['execute', file, '--state-dir', state, '--run-id', 'limited', '--json'];
  const first = cli(
    ...args,
    '--max-agents',
    '3',
    '--provider-limit',
    'codex=1',
    '--log-level',
    'debug',
  );
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /tail pause/);
  assert.match(first.stderr, /Agent limits: total=3; per-harness=\{"codex":1\}/);
  assert.match(first.stderr, /agent.queued .*harness=.*inFlight=.*queued=/);
  assert.match(first.stderr, /agent.admitted .*waitedMs=/);
  const events = readFileSync(join(directory, 'agents.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  let total = 0,
    peak = 0;
  const active = { claude: 0, codex: 0 };
  for (const event of events) {
    const delta = event.kind === 'start' ? 1 : -1;
    total += delta;
    active[event.provider] += delta;
    peak = Math.max(peak, total);
    assert.ok(total <= 3 && total >= 0);
    assert.ok(active.codex <= 1 && active.codex >= 0);
  }
  assert.equal(peak, 3);
  assert.equal(total, 0);
  assert.equal(events.length, 12);
  const before = readFileSync(join(directory, 'agents.jsonl'), 'utf8');
  rmSync(join(directory, 'pause'));
  const resumed = cli(...args, '--resume', '--max-agents', '1', '--provider-limit', 'codex=1');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).output, 6);
  assert.match(resumed.stderr, /Agent limits: total=1/);
  assert.equal(readFileSync(join(directory, 'agents.jsonl'), 'utf8'), before);
  console.log(
    'PASS CLI total/provider caps across nested processes, visible queueing, early validation and changed-limit zero-call resume',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

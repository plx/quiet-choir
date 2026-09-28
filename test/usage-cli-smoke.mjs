import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readRunSync } from '../dist/workflow/runtime/store.js';
import { processIdentity } from '../dist/processes/identity.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-usage-cli-'));
const state = join(directory, 'state');
const file = join(directory, 'workflow.ts');
const bin = join(directory, 'bin');
const ledger = join(directory, 'calls.jsonl');
const runners = new Set();
const identities = new Map();
const env = (mode = 'complete') => ({
  ...process.env,
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  QC_USAGE_MODE: mode,
  QC_USAGE_LEDGER: ledger,
});
const cli = (args, mode) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: directory,
    env: env(mode),
    encoding: 'utf8',
    timeout: 60_000,
  });
const argsFor = (runId, mode = 'calls') => [
  'execute',
  file,
  '--state-dir',
  state,
  '--run-id',
  runId,
  '--input',
  JSON.stringify({ mode }),
  '--max-agents',
  '1',
  '--kill-grace-ms',
  '30',
  '--json',
];
const calls = () =>
  existsSync(ledger)
    ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
const saved = (runId) => readRunSync({ stateDir: state, runId });
async function waitFor(fn) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (fn()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for durable usage evidence');
}

try {
  mkdirSync(bin);
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';
export default defineWorkflow({name:'usage-cli',version:'1',input:z.object({mode:z.enum(['calls','crash'])}),output:z.null(),
async run(ctx,input){if(input.mode==='crash'){await ctx.codex.text('crash',{prompt:'fixture'});}else{for(const id of ['one','two','three'])await ctx.claude.text(id,{prompt:'fixture'});}return null;}});`,
  );
  const script = `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('fixture 1.0.0');process.exit();}
const claude=!process.argv.includes('exec');
const send=value=>console.log(JSON.stringify(value));
process.stdin.resume();process.stdin.on('end',()=>{
fs.appendFileSync(process.env.QC_USAGE_LEDGER,JSON.stringify({runId:process.env.QUIET_CHOIR_RUN_ID,pid:process.pid})+'\\n');
if(claude){send({type:'result',subtype:'success',session_id:'claude-fixture',result:'ok',total_cost_usd:0.1,usage:{input_tokens:1,output_tokens:1},modelUsage:{'fixture-model':{inputTokens:7,cacheReadInputTokens:3,cacheCreationInputTokens:2,outputTokens:4,thinkingTokens:1,costUSD:0.1}}});return;}
send({type:'thread.started',thread_id:'early-usage-session'});
if(process.env.QC_USAGE_MODE==='hang'){setInterval(()=>{},1000);return;}
send({type:'item.completed',item:{type:'agent_message',text:'ok'}});
send({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:20,output_tokens:30,reasoning_output_tokens:12}});
});`;
  for (const provider of ['claude', 'codex'])
    writeFileSync(join(bin, provider), script, { mode: 0o700 });

  for (const [id, flag, limit, raised] of [
    ['cost', '--max-run-cost-usd', '0.1', '1'],
    ['attempts', '--max-run-agent-attempts', '1', '3'],
  ]) {
    const stopped = cli([...argsFor(id), flag, limit]);
    assert.equal(stopped.status, 1, stopped.stderr + stopped.stdout);
    assert.match(stopped.stdout, /Resume with a higher/);
    assert.deepEqual(Object.keys(saved(id).steps), ['one']);
    const retry = cli(['resume', id, '--state-dir', state, '--json']);
    assert.equal(retry.status, 1, retry.stderr + retry.stdout);
    assert.equal(calls().filter((call) => call.runId === id).length, 1);
    const resumed = cli(['resume', id, '--state-dir', state, '--json', flag, raised]);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.equal(calls().filter((call) => call.runId === id).length, 3);
    const inspected = cli(['inspect', id, '--state-dir', state, '--json']);
    assert.equal(inspected.status, 0, inspected.stderr);
    const summary = JSON.parse(inspected.stdout).usageSummary;
    assert.equal(summary.attempts, 3);
    assert.equal(summary.inputTokens, 36);
    assert.equal(summary.outputTokens, 12);
    assert.ok(Math.abs(summary.costUsd - 0.3) < 1e-12);
    assert.equal(summary.unknownCostAttempts, 0);
    assert.equal(summary.byModel['fixture-model'].tokens.reasoning, 3);
    const text = cli(['inspect', id, '--state-dir', state]);
    assert.match(text.stdout, /0 unknown usage; 0 unknown cost/);
    assert.match(text.stdout, /Model fixture-model/);
  }
  const invalid = cli([...argsFor('invalid'), '--max-run-agent-attempts', '1.5']);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.equal(existsSync(join(state, 'invalid', 'run.json')), false);

  if (process.platform !== 'win32') {
    const child = spawn(
      process.execPath,
      [join(root, 'bin/run.js'), 'workflow', ...argsFor('killed', 'crash')],
      { cwd: directory, env: env('hang'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    runners.add(child);
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, signal) => {
        runners.delete(child);
        resolve(signal);
      });
    });
    await waitFor(() => {
      const call = calls().find((value) => value.runId === 'killed');
      if (!call) return false;
      identities.set(call.pid, processIdentity(call.pid)?.start);
      return saved('killed').steps['crash']?.attemptHistory[0]?.sessionId === 'early-usage-session';
    });
    child.kill('SIGKILL');
    assert.equal(await done, 'SIGKILL');
    assert.equal(saved('killed').steps.crash.attemptHistory[0].usage, null);
    const recovered = cli([
      'execute',
      '--resume',
      '--run-id',
      'killed',
      '--state-dir',
      state,
      '--json',
      '--kill-orphans',
      '--kill-grace-ms',
      '30',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
    const history = saved('killed').steps.crash.attemptHistory;
    assert.deepEqual(
      history.map((attempt) => attempt.status),
      ['interrupted', 'completed'],
    );
    assert.equal(history[0].sessionId, 'early-usage-session');
    const inspection = cli(['inspect', 'killed', '--state-dir', state, '--json']);
    const summary = JSON.parse(inspection.stdout).usageSummary;
    assert.equal(summary.attempts, 2);
    assert.equal(summary.unknownUsageAttempts, 1);
    assert.equal(summary.unknownCostAttempts, 2);
    assert.equal(summary.outcomes.interrupted, 1);
  }
  console.log(
    'PASS CLI cost/attempt gates, sticky policy, higher-cap resume, usage inspection, and interrupted-attempt recovery',
  );
} finally {
  for (const child of runners) child.kill('SIGKILL');
  for (const call of calls()) {
    const start = identities.get(call.pid);
    if (!start || processIdentity(call.pid)?.start !== start) continue;
    try {
      process.kill(-call.pid, 'SIGKILL');
    } catch {
      /* Owned fixture already exited. */
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileRunStore } from '../dist/index.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-waits-cli-'));
const stateDir = join(root, 'state');
const file = join(root, 'waits.mts');
const imported = join(root, 'imports.txt');
const calls = join(root, 'effects.txt');
const events = join(root, 'events.jsonl');
const ready = join(root, 'ready.txt');
const cliPath = join(repository, 'bin/run.js');
const env = {
  ...process.env,
  QUIET_CHOIR_NOTIFY_COMMAND: `cat >> '${events.replaceAll("'", "'\"'\"'")}'`,
};
const cliArgs = (args) => [cliPath, 'workflow', ...args, '--state-dir', stateDir];
function command(...args) {
  const result = spawnSync(process.execPath, cliArgs(args), {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(...args);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const runAsync = promisify(execFile);
async function concurrentTick() {
  try {
    return {
      status: 0,
      ...(await runAsync(process.execPath, cliArgs(['tick', '--run', 'gate', '--json']), {
        cwd: root,
        env,
        timeout: 30_000,
      })),
    };
  } catch (error) {
    if (error.code !== 75) throw error;
    return { status: 75, stdout: error.stdout, stderr: error.stderr };
  }
}
const source = `import { defineWorkflow,z } from ${JSON.stringify(join(repository, 'dist/index.js'))};
import { appendFileSync,readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(imported)},'import\\n');
export default defineWorkflow({name:'waits',version:'1',input:z.object({fail:z.boolean().default(false)}),output:z.string(),async run(ctx,input){
 const result = await ctx.wait('ready',{
  timeoutMs:60000,
  signal:{prompt:'Continue?',schema:z.boolean()},
  poll:{input:{file:${JSON.stringify(ready)}},schema:z.string(),every:30000,observe:async()=>readFileSync(${JSON.stringify(ready)},'utf8')==='ready'?{done:true,value:'ready'}:{done:false,note:{pending:1}}}
 });
 await ctx.step('action',{input:null,schema:z.null(),run:()=>{appendFileSync(${JSON.stringify(calls)},'effect\\n');return null;}});
 if(input.fail)throw new Error('requested failure');
 return result.by;
}});`;
try {
  writeFileSync(ready, 'pending');
  writeFileSync(file, source);
  const initial = document(75, 'execute', file, '--run-id', 'gate', '--json', '--full');
  assert.equal(initial.kind, 'workflow.run.suspended');
  assert.equal(initial.run.steps.ready.kind, 'wait');
  assert.ok(initial.run.nextWakeAt);
  const pending = document(0, 'pending', '--json').pending;
  assert.equal(pending[0].checks, 1);
  assert.deepEqual(pending[0].note, { pending: 1 });
  assert.ok(pending[0].nextCheckAt);
  assert.equal(pending[0].kind, 'wait');
  const notDue = document(75, 'tick', '--run', 'gate', '--json');
  assert.deepEqual(notDue.resumed, []);
  assert.deepEqual(
    notDue.skipped.map(({ runId, reason }) => ({ runId, reason })),
    [{ runId: 'gate', reason: 'not due' }],
  );
  assert.deepEqual(
    document(75, 'tick', '--run', 'gate', '--watch', '--timeout', '50ms', '--json').resumed,
    [],
  );
  assert.equal(readFileSync(imported, 'utf8'), 'import\n');
  assert.equal(command('answer', 'gate', 'ready', '--json', 'true').status, 0);
  const results = await Promise.all([concurrentTick(), concurrentTick()]);
  assert.equal(
    results.reduce((n, result) => n + JSON.parse(result.stdout).resumed.length, 0),
    1,
  );
  assert.equal(readFileSync(calls, 'utf8'), 'effect\n');
  assert.equal(readFileSync(imported, 'utf8'), 'import\nimport\n');
  // An already-completed run is only observed, and --run exits 0 for it.
  const observedGate = document(0, 'tick', '--run', 'gate', '--json');
  assert.deepEqual(observedGate.resumed, []);
  assert.deepEqual(observedGate.skipped, []);
  assert.equal(observedGate.observed, 1);
  const hooks = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    hooks.map((event) => event.type),
    ['wait.opened', 'run.suspended', 'run.completed'],
  );
  assert.equal(hooks[0].data.question.prompt, 'Continue?');

  document(
    75,
    'execute',
    file,
    '--run-id',
    'failing',
    '--input',
    '{"fail":true}',
    '--json',
    '--notify-command',
    'exit 9',
  );
  assert.equal(command('answer', 'failing', 'ready', '--json', 'true').status, 0);
  // A per-run failure is data in batch mode: exit 0.
  const batch = document(0, 'tick', '--max-runs', '1', '--json');
  assert.deepEqual(
    batch.resumed.map(({ runId, outcome }) => ({ runId, outcome })),
    [{ runId: 'failing', outcome: 'failed' }],
  );
  assert.deepEqual(batch.skipped, []);
  assert.equal(
    readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse).at(-1).type,
    'run.failed',
  );
  const failed = document(1, 'tick', '--run', 'failing', '--json');
  assert.deepEqual(failed.resumed, []);
  assert.equal(failed.observed, 1);

  document(75, 'execute', file, '--run-id', 'drift', '--json');
  assert.equal(command('answer', 'drift', 'ready', '--json', 'true').status, 0);
  const saved = readFileSync(join(stateDir, 'drift', 'run.json'), 'utf8');
  const importsBefore = readFileSync(imported, 'utf8');
  const held = await new FileRunStore(stateDir).open('drift');
  try {
    const locked = document(75, 'tick', '--run', 'drift', '--json');
    assert.deepEqual(locked.resumed, []);
    assert.deepEqual(locked.skipped, [{ runId: 'drift', reason: 'locked' }]);
  } finally {
    await held.release();
  }
  writeFileSync(file, source + '\n// incompatible edit\n');
  const drifted = document(1, 'tick', '--run', 'drift', '--json');
  assert.deepEqual(drifted.resumed, []);
  assert.deepEqual(
    drifted.skipped.map(({ runId, reason }) => ({ runId, reason })),
    [{ runId: 'drift', reason: 'incompatible' }],
  );
  assert.equal(readFileSync(imported, 'utf8'), importsBefore);
  assert.equal(readFileSync(join(stateDir, 'drift', 'run.json'), 'utf8'), saved);
  assert.equal(document(2, 'tick', '--timeout', 'nonsense', '--json').error.code, 'usage.flag');

  const sleepFile = join(root, 'sleep.mts');
  writeFileSync(
    sleepFile,
    `import {defineWorkflow,z} from ${JSON.stringify(join(repository, 'dist/index.js'))};export default defineWorkflow({name:'sleep',version:'1',input:z.object({}),output:z.null(),run:ctx=>ctx.sleep('pause',1200)});`,
  );
  assert.equal(
    document(0, 'execute', sleepFile, '--run-id', 'block', '--wait-mode', 'block', '--json').status,
    'completed',
  );
  console.log(
    'Waits CLI: parked progress, tick entries/exits (not due, locked, observed, failed, drift)/watch/concurrency, hook flag/environment/dedup/failures, and block mode passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

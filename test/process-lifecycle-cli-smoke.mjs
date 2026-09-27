import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { groupState, processIdentity } from '../dist/processes/identity.js';

if (process.platform === 'win32') {
  console.log('SKIP POSIX signal/group CLI fixtures on Windows');
  process.exit(0);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-process-cli-'));
const bin = join(directory, 'bin');
const state = join(directory, 'state');
const file = join(directory, 'workflow.ts');
const runners = new Set();
const allPids = new Map();
const envFor = (runId, mode = 'hang') => ({
  ...process.env,
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  QC_PROCESS_RUN: runId,
  QC_PROCESS_MODE: mode,
  QC_PROCESS_STATE: state,
});
const cli = (args, env = process.env) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
const argsFor = (runId, grace = '200') => [
  'execute',
  file,
  '--state-dir',
  state,
  '--run-id',
  runId,
  '--max-agents',
  '3',
  '--kill-grace-ms',
  grace,
  '--json',
];
const calls = (runId) => {
  const path = join(directory, `${runId}.calls`);
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
};
async function waitFor(fn, context, budget = 40_000) {
  const until = performance.now() + budget;
  while (performance.now() < until) {
    if (fn()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${context}`);
}
function start(runId, grace = '200', extra = []) {
  const child = spawn(
    process.execPath,
    [join(root, 'bin/run.js'), 'workflow', ...argsFor(runId, grace), ...extra],
    { cwd: directory, env: envFor(runId), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return observeRunner(child);
}
function observeRunner(child) {
  runners.add(child);
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      runners.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done, stderr: () => stderr };
}
async function ready(runId) {
  await waitFor(() => calls(runId).length === 3, `${runId}: three recorded live agents`);
  const records = calls(runId);
  records.forEach(({ pid, osStartTime }) => allPids.set(pid, osStartTime));
  for (const call of records) {
    assert.equal(call.registered, true, 'task input arrived before durable process registration');
    assert.equal(groupState({ pid: call.pid, pgid: call.pid }), 'alive');
  }
  return records;
}
function gone(records) {
  return records.every(({ pid }) => groupState({ pid, pgid: pid }) === 'dead');
}
try {
  mkdirSync(bin);
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
import {groupState} from ${JSON.stringify(pathToFileURL(join(root, 'dist/processes/identity.js')).href)};
if(process.argv.includes('--version')){console.log('2.1.283');process.exit(0);}
process.on('SIGTERM',()=>{});
process.stdin.resume();process.stdin.on('end',()=>{
 const run=process.env.QC_PROCESS_RUN;
 const record=JSON.parse(fs.readFileSync(path.join(process.env.QC_PROCESS_STATE,run+'.json.lock/processes/'+process.pid+'.json'),'utf8'));
 if(process.env.QC_PROCESS_MODE==='finish'&&fs.existsSync(run+'.calls')) {
  const old=fs.readFileSync(run+'.calls','utf8').trim().split('\\n').map(JSON.parse).filter(call=>call.mode==='hang');
  if(old.some(({pid})=>groupState({pid,pgid:pid})!=='dead'))throw Error('Replacement started before original processes stopped');
 }
 fs.appendFileSync(run+'.calls',JSON.stringify({pid:process.pid,osStartTime:record.osStartTime,mode:process.env.QC_PROCESS_MODE,registered:record.runId===run&&record.stepId.startsWith('agents/')&&record.attempt>=1})+'\\n');
 if(process.env.QC_PROCESS_MODE==='finish'){console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'}));process.exit(0);}
 setInterval(()=>{},1000);
});`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';import {appendFileSync} from 'node:fs';
appendFileSync('imports','import\\n');
export default defineWorkflow({name:'process-lifecycle-cli',version:'1',input:z.object({}),output:z.number(),async run(ctx){
 await ctx.map('agents',[0,1,2],{concurrency:3},()=>ctx.claude.text('ask',{prompt:'x',timeoutMs:120000}));return 3;
}});`,
  );
  for (const value of ['0', '-1', '1.5', '2147483648', 'NaN', '1e3']) {
    const bad = cli(['execute', file, '--kill-grace-ms', value]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.equal(existsSync(join(directory, 'imports')), false);
  }
  const killed = start('killed');
  const original = await ready('killed');
  const active = cli(['inspect', 'killed', '--state-dir', state, '--json']);
  assert.equal(active.status, 0, active.stderr);
  assert.equal(JSON.parse(active.stdout).ownership.owner.state, 'alive');
  assert.equal(
    JSON.parse(active.stdout).ownership.processes.filter((p) => p.state === 'alive').length,
    3,
  );
  killed.child.kill('SIGKILL');
  assert.equal((await killed.done).signal, 'SIGKILL');
  const checkpoint = readFileSync(join(state, 'killed.json'), 'utf8');
  const inspect = cli(['inspect', 'killed', '--state-dir', state]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /dead: stale lock/);
  for (const { pid } of original)
    assert.match(inspect.stdout, new RegExp(`pid ${pid} .*step agents/`));
  const refused = cli([...argsFor('killed'), '--resume'], envFor('killed', 'finish'));
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'run.orphans');
  assert.deepEqual(JSON.parse(refused.stdout).run, JSON.parse(checkpoint));
  assert.match(refused.stderr, /live or unverified harness processes/);
  assert.equal(calls('killed').length, 3);
  assert.equal(readFileSync(join(state, 'killed.json'), 'utf8'), checkpoint);
  const recovered = cli(
    [...argsFor('killed'), '--resume', '--kill-orphans'],
    envFor('killed', 'finish'),
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).output, 3);
  assert.equal(calls('killed').length, 6);
  assert.ok(gone(original));
  assert.equal(existsSync(join(state, 'killed.json.lock')), false);
  for (const step of Object.values(JSON.parse(recovered.stdout).steps))
    assert.equal(step.attemptHistory.at(-1).policy.killGraceMs, 200);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const id = signal.toLowerCase();
    const running = start(id);
    const records = await ready(id);
    running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.code, 130, result.stderr);
    assert.match(result.stderr, /Send again to force/);
    assert.ok(gone(records));
    const record = JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8'));
    assert.equal(record.status, 'cancelled');
    assert.ok(Object.values(record.steps).every((step) => step.status === 'cancelled'));
    assert.equal(existsSync(join(state, `${id}.json.lock`)), false);
  }

  const forced = start('forced', '20000');
  const forcing = await ready('forced');
  forced.child.kill('SIGINT');
  await waitFor(
    () => forced.stderr().includes('Send again to force'),
    'first interrupt diagnostic',
  );
  assert.ok(forcing.every(({ pid }) => groupState({ pid, pgid: pid }) === 'alive'));
  const begin = performance.now();
  forced.child.kill('SIGHUP');
  assert.equal((await forced.done).code, 130);
  await waitFor(() => gone(forcing), 'second signal kills every tracked group', 2500);
  assert.ok(performance.now() - begin < 2500);
  // Hard exit preserves ownership. A subsequent resume can clear dead records without an orphan override.
  const resumed = cli([...argsFor('forced'), '--resume'], envFor('forced', 'finish'));
  assert.equal(resumed.status, 0, resumed.stderr);

  const closed = start('closed');
  const closedRecords = await ready('closed');
  closed.child.stderr.destroy();
  closed.child.stdout.destroy();
  closed.child.kill('SIGHUP');
  assert.equal((await closed.done).code, 130);
  assert.ok(gone(closedRecords));
  assert.equal(existsSync(join(state, 'closed.json.lock')), false);
  const doctorBinary = join(bin, 'doctor-harness');
  writeFileSync(
    doctorBinary,
    `#!/usr/bin/env node
import fs from 'node:fs';
import {processIdentity} from ${JSON.stringify(pathToFileURL(join(root, 'dist/processes/identity.js')).href)};
process.on('SIGTERM',()=>{});
fs.appendFileSync(process.env.QC_PROCESS_RUN+'.calls',JSON.stringify({pid:process.pid,osStartTime:processIdentity(process.pid)?.start??null})+'\\n');
setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  for (const forced of [false, true]) {
    const id = forced ? 'doctor-force' : 'doctor-hup';
    const doctor = observeRunner(
      spawn(
        process.execPath,
        [
          join(root, 'bin/run.js'),
          'configuration',
          'doctor',
          '--harness',
          'claude',
          '--claude-binary',
          doctorBinary,
          '--json',
        ],
        {
          cwd: directory,
          env: envFor(id),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    await waitFor(() => calls(id).length === 1, `${id}: probe startup`);
    const records = calls(id);
    records.forEach(({ pid, osStartTime }) => allPids.set(pid, osStartTime));
    doctor.child.kill('SIGHUP');
    await waitFor(() => doctor.stderr().includes('Doctor interrupted'), `${id}: first signal`);
    const begin = performance.now();
    if (forced) doctor.child.kill('SIGINT');
    assert.equal((await doctor.done).code, 130);
    await waitFor(() => gone(records), `${id}: probe reaped`, 1500);
    if (forced) assert.ok(performance.now() - begin < 1500);
  }
  console.log(
    'PASS CLI SIGKILL orphan refusal/recovery, live/stale inspection, all first signals, forced second signal, dead terminal, configurable cleanup grace, and doctor probe signals',
  );
} finally {
  for (const child of runners) child.kill('SIGKILL');
  // Read every fixture ledger, including a setup failure before ready() returned.
  for (const id of [
    'killed',
    'sigint',
    'sigterm',
    'sighup',
    'forced',
    'closed',
    'doctor-hup',
    'doctor-force',
  ])
    for (const { pid, osStartTime } of calls(id)) allPids.set(pid, osStartTime);
  for (const [pid, start] of allPids) {
    if (!start || processIdentity(pid)?.start !== start) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* owned fixture already reaped */
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

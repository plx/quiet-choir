import { readRunSync, writeRun } from '../dist/workflow/runtime/store.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-observe-cli-'));
const state = join(root, 'state');
const file = join(root, 'workflow.ts');
const repaired = join(root, 'repaired');
const bin = join(project, 'bin/run.js');
const children = new Set();
function run(args, json = true) {
  const result = spawnSync(
    process.execPath,
    [bin, 'workflow', ...args, '--state-dir', state, ...(json ? ['--json'] : [])],
    { cwd: project, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  const lines = result.stdout.trim().split('\n');
  if (json) assert.equal(lines.length, 1, result.stdout);
  return { ...result, value: json ? JSON.parse(result.stdout) : null };
}
function start(args) {
  const child = spawn(
    process.execPath,
    [bin, 'workflow', ...args, '--state-dir', state, '--json'],
    { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(child);
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output.stderr += chunk;
  });
  const closed = once(child, 'close').then(([code, signal]) => {
    children.delete(child);
    return { code, signal, ...output };
  });
  return { child, output, closed };
}
async function until(check, label) {
  for (let n = 0; n < 1500; n++) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const execute = (id, mode = 'pass') => [
  'execute',
  file,
  '--run-id',
  id,
  '--input',
  JSON.stringify({ mode }),
];
const pathFor = (id) => join(state, id, 'run.json');
const saved = (id) => readRunSync({ stateDir: state, runId: id });
const active = (id) => existsSync(pathFor(id)) && saved(id).steps['wait']?.status === 'running';
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(
    file,
    `
import { existsSync } from 'node:fs';
import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({ name:'observe-cli', version:'1', input:z.object({ mode:z.enum(['pass','fail','wait']) }), output:z.string(),
  async run(ctx, input) {
    ctx.phase('verify', { total:2 }); ctx.log('begin', { mode:input.mode });
    await ctx.step('z-first', { input:null, schema:z.string(), run:()=> 'first' });
    if (input.mode === 'wait') await ctx.step('wait',{input:null,schema:z.null(),run:async({signal})=>{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,60000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});return null;}});
    return ctx.step('a-result', { input:input.mode, schema:z.string(), run:()=> {
      if (input.mode === 'fail' && !existsSync(${JSON.stringify(repaired)})) throw new Error('root diagnostic');
      return 'done';
    }});
  }
});`,
  );
  const good = run([...execute('good'), '--full']);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.value.formatVersion, 7);
  assert.match(good.stderr, /\d{4}-\d{2}-\d{2}T\S+ good phase verify/);
  assert.match(good.stderr, /good log begin/);
  const fail = run([...execute('bad', 'fail'), '-v']);
  assert.equal(fail.status, 1, fail.stderr);
  assert.match(fail.value.error.message, /Step a-result \(step\) failed: root diagnostic/);
  assert.equal(fail.value.error.stepId, 'a-result');
  assert.match(fail.stderr, /workflow.ts:\d/);
  const text = run(['inspect', 'bad', '-v'], false);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Steps: 2: 1 completed, 1 failed/);
  assert.match(text.stdout, /Phase: verify 1\/2/);
  assert.match(text.stdout, /a-result.*\[root cause\]/);
  assert.match(text.stdout, /workflow.ts:\d/);
  assert.doesNotMatch(text.stdout, /^null$/m);
  const summary = run(['inspect', 'bad', '--summary']);
  assert.equal(summary.value.steps[0].id, 'a-result');
  assert.equal(summary.value.rootCause.stepId, 'a-result');
  assert.equal(run(['inspect', 'bad', '--watch', '--summary']).status, 1);
  assert.equal(run(['inspect', 'good', '--watch', '--summary']).status, 0);
  const invalid = run(['inspect', 'good', '--watch', '--interval', '0s']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.value.error.code, 'usage.flag');
  for (const flags of [['--final'], ['--timeout', '1s'], ['--wait-created', '1s']]) {
    const unwatched = run(['inspect', 'good', ...flags]);
    assert.equal(unwatched.status, 2, unwatched.stdout);
    assert.equal(unwatched.value.error.code, 'usage.flag');
  }
  const badBound = run(['inspect', 'good', '--watch', '--timeout', '10']);
  assert.equal(badBound.status, 2, badBound.stdout);
  assert.match(badBound.value.error.message, /--timeout must be a positive duration/);
  const help = run(['inspect', '--help'], false);
  assert.equal(help.status, 0, help.stderr);
  for (const exit of [/suspended \(75\)/, /exit 79 \(watch\.timeout\)/, /exit 66/])
    assert.match(help.stdout.replace(/\s+/g, ' '), exit);

  // --wait-created waits for a record written later, then streams it. The record is written
  // directly, not by executing a workflow, so the bound never depends on typecheck time.
  const late = start([
    'inspect',
    'late',
    '--watch',
    '--wait-created',
    '10s',
    '--summary',
    '--interval',
    '20ms',
  ]);
  await delay(1000);
  mkdirSync(join(state, 'late'), { recursive: true });
  await writeRun(state, { ...saved('good'), id: 'late' });
  const lateWatch = await late.closed;
  assert.equal(lateWatch.code, 0, lateWatch.stderr);
  const lateSnapshots = lateWatch.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(lateSnapshots.length >= 1, lateWatch.stdout);
  assert.ok(lateSnapshots.every((entry) => entry.id === 'late' && entry.status === 'completed'));
  const never = run(['inspect', 'never', '--watch', '--wait-created', '300ms']);
  assert.equal(never.status, 66, never.stderr);
  assert.equal(never.value.exitCode, 66);
  assert.equal(never.value.error.code, 'watch.record_not_created');
  assert.equal(never.value.status, null);
  assert.equal(never.value.error.details.waitCreatedMs, 300);
  assert.match(never.value.error.message, /not created within 300ms\. Run never not found in /);
  const missingNow = run(['inspect', 'never', '--watch']);
  assert.equal(missingNow.status, 3, missingNow.stderr);
  assert.equal(missingNow.value.error.code, 'run.not_found');

  writeFileSync(repaired, 'fixed');
  const resumed = run([
    'execute',
    file,
    '--run-id',
    'bad',
    '--resume',
    '--full',
    '--log-level',
    'debug',
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /bad phase verify \(replay\)/);
  assert.match(resumed.stderr, /bad log begin .*\(replay\)/);
  assert.match(resumed.stderr, /\d{4}-\d{2}-\d{2}T\S+ bad step.replayed z-first/);
  assert.deepEqual(
    resumed.value.executions.map((entry) => entry.outcome),
    ['failed', 'completed'],
  );
  assert.equal(resumed.value.events.filter((entry) => entry.type === 'log').length, 1);
  assert.deepEqual(
    resumed.value.steps['a-result'].attemptHistory.map((entry) => entry.execution),
    [1, 2],
  );

  // A cooperative SIGINT persists a resumable suspension and exits 130; the separate watcher sees
  // an interrupted run as suspended and exits 75.
  const interrupted = start(execute('interrupted', 'wait'));
  await until(() => active('interrupted'), 'interrupt workflow started');
  const watching = start(['inspect', 'interrupted', '--watch', '--summary', '--interval', '20ms']);
  const finalOnly = start([
    'inspect',
    'interrupted',
    '--watch',
    '--final',
    '--summary',
    '--interval',
    '20ms',
  ]);
  await until(() => watching.output.stdout.includes('"status":"running"'), 'watch first snapshot');
  // A bounded watch of the still-running run stops with watch.timeout (79), not stale or
  // suspended, and reports the last observed status; --final prints only that error document.
  const bounded = ['inspect', 'interrupted', '--watch', '--summary', '--timeout', '1s'];
  const [timedOut, timedOutFinal] = await Promise.all([
    start([...bounded, '--interval', '20ms']).closed,
    start([...bounded, '--final', '--interval', '20ms']).closed,
  ]);
  for (const result of [timedOut, timedOutFinal]) {
    assert.equal(result.code, 79, result.stderr);
    const document = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(document.kind, 'workflow.error');
    assert.equal(document.exitCode, 79);
    assert.equal(document.error.code, 'watch.timeout');
    assert.equal(document.error.details.timeoutMs, 1000);
    assert.equal(document.status, 'running');
    assert.equal(document.run, undefined, '--summary compacts the error document');
    assert.equal(document.summary.status, 'running');
  }
  assert.ok(JSON.parse(timedOut.stdout.trim().split('\n')[0]).status === 'running');
  assert.equal(timedOutFinal.stdout.trim().split('\n').length, 1, timedOutFinal.stdout);
  assert.equal(saved('interrupted').status, 'running', 'a timed-out watch leaves the run alone');
  interrupted.child.kill('SIGINT');
  const cancelled = await interrupted.closed;
  assert.equal(cancelled.code, 130, cancelled.stderr);
  const watched = await watching.closed;
  assert.equal(watched.code, 75, watched.stderr);
  const snapshots = watched.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(snapshots.length >= 2, watched.stdout);
  assert.equal(snapshots.at(-1).status, 'suspended');
  assert.match(snapshots.at(-1).interruptedBy.reason, /Workflow interrupted by SIGINT/);
  assert.ok(snapshots.every((entry) => entry.id === 'interrupted'));
  // --final waited through the same changes but printed only the last snapshot.
  const finalWatched = await finalOnly.closed;
  assert.equal(finalWatched.code, 75, finalWatched.stderr);
  const finalLines = finalWatched.stdout.trim().split('\n');
  assert.equal(finalLines.length, 1, finalWatched.stdout);
  assert.equal(JSON.parse(finalLines[0]).status, 'suspended');
  const cancelledRun = saved('interrupted');
  assert.equal(cancelledRun.status, 'suspended');
  assert.equal(cancelledRun.executions[0].outcome, 'suspended');
  assert.equal(cancelledRun.rootCause, null);
  assert.equal(cancelledRun.steps.wait.attemptHistory[0].status, 'cancelled');
  assert.ok(cancelledRun.steps.wait.durationMs >= 0);
  assert.equal(cancelledRun.events.at(-1).type, 'run.suspended');

  // Owner death changes the read-only status even with unchanged checkpoint bytes.
  const abandoned = start(execute('abandoned', 'wait'));
  await until(() => active('abandoned'), 'abandoned workflow started');
  const watcher = start(['inspect', 'abandoned', '--watch', '--summary', '--interval', '20ms']);
  await until(
    () => watcher.output.stdout.includes('"status":"running"'),
    'abandoned watcher started',
  );
  const bytes = readFileSync(pathFor('abandoned'), 'utf8');
  abandoned.child.kill('SIGKILL');
  await abandoned.closed;
  const stale = await watcher.closed;
  assert.equal(stale.code, 3, stale.stderr);
  assert.equal(JSON.parse(stale.stdout.trim().split('\n').at(-1)).status, 'stale');
  assert.equal(readFileSync(pathFor('abandoned'), 'utf8'), bytes);

  writeFileSync(join(state, 'broken.json'), '{broken');
  const listed = run(['list', '--status', 'stale']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.value.kind, 'workflow.list.result');
  assert.deepEqual(
    listed.value.runs.map((entry) => entry.id),
    ['abandoned'],
  );
  assert.equal(listed.value.warnings.length, 1);
  assert.match(listed.stderr, /Skipped broken/);
  assert.match(run(['list'], false).stdout, /ID {2}WORKFLOW {2}STATUS/);
  const all = run(['list']).value.runs;
  for (const entry of all) {
    assert.equal(entry.steps, undefined, 'default list rows are compact');
    assert.equal(typeof entry.usage.unknownTokenAttempts, 'number');
    assert.equal(entry.usage.byHarness, undefined);
  }
  const full = run(['list', '--full']).value.runs;
  assert.deepEqual(
    full.map((entry) => entry.id),
    all.map((entry) => entry.id),
  );
  assert.ok(
    full.every((entry) => Array.isArray(entry.steps)),
    '--full restores run summaries',
  );
  assert.deepEqual(
    all.map((entry) => entry.updatedAt),
    all
      .map((entry) => entry.updatedAt)
      .sort()
      .reverse(),
  );
  console.log(
    'Observability CLI smoke passed: phases, history, dashboard, list, watch exits and bounds, SIGINT, stale owner.',
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => once(child, 'close')));
  rmSync(root, { recursive: true, force: true });
}

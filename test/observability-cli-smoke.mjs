import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const pathFor = (id) => join(state, `${id}.json`);
const saved = (id) => JSON.parse(readFileSync(pathFor(id), 'utf8'));
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
    if (input.mode === 'wait') await ctx.sleep('wait', 60_000);
    return ctx.step('a-result', { input:input.mode, schema:z.string(), run:()=> {
      if (input.mode === 'fail' && !existsSync(${JSON.stringify(repaired)})) throw new Error('root diagnostic');
      return 'done';
    }});
  }
});`,
  );
  const good = run(execute('good'));
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.value.formatVersion, 6);
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

  writeFileSync(repaired, 'fixed');
  const resumed = run(['execute', file, '--run-id', 'bad', '--resume', '--log-level', 'debug']);
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

  // A cooperative SIGINT persists cancellation; the separate watcher mirrors exit 130.
  const interrupted = start(execute('interrupted', 'wait'));
  await until(() => active('interrupted'), 'interrupt workflow started');
  const watching = start(['inspect', 'interrupted', '--watch', '--summary', '--interval', '20ms']);
  await until(() => watching.output.stdout.includes('"status":"running"'), 'watch first snapshot');
  interrupted.child.kill('SIGINT');
  const cancelled = await interrupted.closed;
  assert.equal(cancelled.code, 130, cancelled.stderr);
  const watched = await watching.closed;
  assert.equal(watched.code, 130, watched.stderr);
  const snapshots = watched.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(snapshots.at(-1).status, 'cancelled');
  assert.ok(snapshots.every((entry) => entry.id === 'interrupted'));
  const cancelledRun = saved('interrupted');
  assert.equal(cancelledRun.executions[0].outcome, 'cancelled');
  assert.equal(cancelledRun.rootCause.stepId, null);
  assert.equal(cancelledRun.steps.wait.attemptHistory[0].status, 'cancelled');
  assert.ok(cancelledRun.steps.wait.durationMs >= 0);
  assert.equal(cancelledRun.events.at(-1).type, 'run.cancelled');

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
  assert.match(listed.stderr, /Skipped broken.json/);
  assert.match(run(['list'], false).stdout, /ID {2}WORKFLOW {2}STATUS/);
  const all = run(['list']).value.runs;
  assert.deepEqual(
    all.map((entry) => entry.updatedAt),
    all
      .map((entry) => entry.updatedAt)
      .sort()
      .reverse(),
  );
  console.log(
    'Observability CLI smoke passed: phases, history, dashboard, list, watch exits, SIGINT, stale owner.',
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => once(child, 'close')));
  rmSync(root, { recursive: true, force: true });
}

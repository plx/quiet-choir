import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readRun } from '../dist/index.js';

// Lock transitions are single renames (ADR 0030): SIGKILL right after a lock is published, after a
// release renamed it to a tombstone, or after a recovery marker was linked, and a plain resume (or
// tick) still recovers the run with no manual file operation.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-lock-crash-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const preload = join(repository, 'test/lock-crash-preload.mjs');
const dist = JSON.stringify(join(repository, 'dist/index.js'));

function command(args, crashAt) {
  const result = spawnSync(
    process.execPath,
    [
      ...(crashAt ? ['--import', preload] : []),
      cliPath,
      'workflow',
      ...args,
      '--state-dir',
      stateDir,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...(crashAt ? { QC_LOCK_CRASH_AT: crashAt } : {}) },
    },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(args);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
/** An invocation that the preload SIGKILLs at the named lock transition. */
function killedAt(crashAt, ...args) {
  const result = command(args, crashAt);
  assert.equal(result.signal, 'SIGKILL', `${crashAt}: ${result.stderr || result.stdout}`);
}
/** Suspend a new run on a short sleep and return its wake time. */
function suspend(runId, nap) {
  const suspended = document(
    75,
    'execute',
    workflow,
    '--run-id',
    runId,
    '--input',
    JSON.stringify({ nap }),
    '--json',
  );
  assert.equal(suspended.kind, 'workflow.run.suspended');
  return suspended.run.nextWakeAt;
}
async function wake(at) {
  await delay(Math.max(0, at - Date.now() + 100));
}
/** Lock directories and their publish or tombstone siblings, in the state dir and the run dir. */
function lockEntries(runId) {
  return [
    ...readdirSync(stateDir).filter((name) => name.startsWith(`${runId}.json.lock`)),
    ...readdirSync(join(stateDir, runId))
      .filter((name) => name.startsWith('lock'))
      .map((name) => `${runId}/${name}`),
  ];
}
async function completes(runId, result) {
  assert.equal(result.status, 'completed');
  assert.equal((await readRun({ stateDir, runId })).output, 'done');
  assert.deepEqual(lockEntries(runId), []);
}

const workflow = join(root, 'nap.mts');
writeFileSync(
  workflow,
  `import { defineWorkflow, z } from ${dist};
export default defineWorkflow({ name: 'nap', version: '1', input: z.object({ nap: z.number() }),
  output: z.string(),
  async run(ctx, input) {
    await ctx.sleep('nap', input.nap);
    return 'done';
  } });`,
);

try {
  // Publish: killed right after the primary lock is renamed into place.
  await wake(suspend('P', 1500));
  killedAt('publish', 'resume', 'P', '--json');
  assert.deepEqual(lockEntries('P').sort(), ['P.json.lock', 'P/lock']);
  await completes('P', document(0, 'resume', 'P', '--json'));

  // Tombstone: an early resume suspends again and is killed after renaming its lock away.
  const tombstoneWake = suspend('T', 5000);
  killedAt('tombstone', 'resume', 'T', '--json');
  const stranded = lockEntries('T');
  assert.ok(
    stranded.some((name) => /^T\/lock\.\d+\.[0-9a-f-]+\.gone$/u.test(name)),
    stranded.join(', '),
  );
  await wake(tombstoneWake);
  await completes('T', document(0, 'resume', 'T', '--json'));

  // Recovery: a dead owner's lock, then a recoverer killed right after publishing its marker.
  for (const [runId, finish] of [
    ['C', () => document(0, 'resume', 'C', '--json')],
    ['K', () => document(0, 'tick', '--run', 'K', '--json')],
  ]) {
    await wake(suspend(runId, 1500));
    killedAt('publish', 'resume', runId, '--json');
    killedAt('recovery', 'resume', runId, '--json');
    assert.ok(existsSync(join(stateDir, `${runId}.json.lock`, 'recovery.json')));
    const { ownership } = document(0, 'inspect', runId, '--json');
    assert.equal(ownership.locked, true);
    assert.equal(ownership.owner.state, 'dead');
    assert.deepEqual(
      ownership.locks.map((lock) => [lock.kind, lock.owner?.state, lock.recovery?.state ?? null]),
      [
        ['primary', 'dead', null],
        ['guard', 'dead', 'dead'],
      ],
    );
    assert.equal(ownership.locks[1].path, join(stateDir, `${runId}.json.lock`));
    const summary = document(0, 'inspect', runId, '--json', '--summary');
    assert.equal(summary.ownership.locks.length, 2);
    const result = finish();
    if (runId === 'K') {
      // Tick resumes a run whose recoverer crashed instead of skipping it as locked.
      assert.deepEqual(result.resumed, [{ runId: 'K', outcome: 'completed' }]);
      assert.deepEqual(result.skipped, []);
      await completes('K', await readRun({ stateDir, runId: 'K' }));
    } else await completes(runId, result);
  }
  console.log(
    'Lock crash CLI: SIGKILL after a lock publish, a release tombstone or a recovery marker leaves a run that a plain resume or tick recovers, with no strays left behind.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

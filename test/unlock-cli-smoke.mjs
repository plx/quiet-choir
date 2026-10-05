import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readRun } from '../dist/index.js';
import { processIdentity } from '../dist/processes/identity.js';
import { formatArgv } from '../dist/workflow/runtime/commands.js';

if (process.platform === 'win32') {
  console.log('SKIP POSIX process-group unlock fixtures on Windows');
  process.exit(0);
}

// workflow unlock clears abandoned locks that a plain resume refuses, and refuses live owners,
// live recoverers, live children and foreign hosts (without --force-remote). All workflows here are
// local sleeps: no harness calls.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-unlock-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const dist = JSON.stringify(join(repository, 'dist/index.js'));
const DEAD = 2_000_000_000;
// Run through bin/run.js with no installed quiet-choir, every printed unlock command starts with the
// launcher `node <realpath of bin/run.js>` (#135, #213).
const unlockProgram = formatArgv([process.execPath, realpathSync(cliPath)]);
const sleepers = [];

function command(args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'workflow', ...args, '--state-dir', stateDir],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(args);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function refused(code, ...args) {
  const failure = document(3, ...args, '--json');
  assert.equal(failure.error.code, code, failure.error.message);
  return failure.error;
}
function suspend(runId) {
  const suspended = document(
    75,
    'execute',
    workflow,
    '--run-id',
    runId,
    '--input',
    JSON.stringify({ nap: 1500 }),
    '--json',
    '--full',
  );
  assert.equal(suspended.kind, 'workflow.run.suspended');
  return suspended.run.nextWakeAt;
}
async function completes(runId) {
  const result = document(0, 'resume', runId, '--json');
  assert.equal(result.status, 'completed');
  assert.equal((await readRun({ stateDir, runId })).output, 'done');
}
const primary = (runId) => join(stateDir, runId, 'lock');
const guard = (runId) => join(stateDir, `${runId}.json.lock`);
function plant(path, files) {
  mkdirSync(path, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(path, name, '..'), { recursive: true });
    writeFileSync(join(path, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
}
const owner = (pid, host = hostname(), extra = {}) => ({
  pid,
  host,
  token: `token-${String(pid)}`,
  ...extra,
});
async function sleeper() {
  const child = spawn(
    process.execPath,
    ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  sleepers.push(child);
  await once(child.stdout, 'data');
  const start = processIdentity(child.pid)?.start ?? null;
  assert.ok(start, 'sleeper birth identity');
  return { child, start };
}
async function stop({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGKILL');
  await exited;
}
/** A resume refusal that names the unlock command. */
function resumeNamesUnlock(runId, ...extra) {
  const error = refused('run.locked', 'resume', runId);
  assert.ok(
    error.message.includes(`${unlockProgram} workflow unlock ${runId} --state-dir `),
    error.message,
  );
  // The message embeds the very command that details.next lists.
  assert.ok(error.details.next.length >= 1, JSON.stringify(error.details));
  for (const entry of error.details.next) {
    assert.deepEqual(entry.argv.slice(0, 2), [process.execPath, realpathSync(cliPath)]);
    assert.ok(error.message.includes(formatArgv(entry.argv)), error.message);
  }
  for (const text of extra) assert.ok(error.message.includes(text), error.message);
  return error;
}

/** `workflow inspect` text, whatever the run's status makes the exit code. */
function inspectText(runId) {
  const result = command(['inspect', runId]);
  assert.ok(result.stdout.includes(`Run ${runId}:`), result.stderr || result.stdout);
  return result.stdout;
}
const unlockLines = (text) => text.split('\n').filter((line) => line.startsWith('Unlock:'));
const unlockPrefix = (runId) =>
  `Unlock: ${unlockProgram} workflow unlock ${runId} --state-dir ${stateDir}`;

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
  const wakes = ['F', 'O', 'L', 'M', 'R', 'U'].map((runId) => suspend(runId));
  await delay(Math.max(0, Math.max(...wakes) - Date.now() + 100));

  // Foreign host: refused by resume and by a plain unlock; cleared with --force-remote.
  const foreign = `${hostname()}-gone`;
  plant(primary('F'), { 'owner.json': owner(DEAD, foreign) });
  plant(guard('F'), { 'owner.json': owner(DEAD, foreign) });
  resumeNamesUnlock('F', '--force-remote', foreign);
  // Inspect text hints the same command with the foreign-host caveat; JSON gains nothing.
  assert.deepEqual(unlockLines(inspectText('F')), [
    `${unlockPrefix('F')} --force-remote (only if ${foreign} is this machine under an old name or is permanently gone)`,
  ]);
  const inspected = command(['inspect', 'F', '--json']);
  const inspection = JSON.parse(inspected.stdout);
  assert.ok(!inspected.stdout.includes('Unlock:'));
  assert.deepEqual(
    Object.keys(inspection).sort(),
    [...Object.keys(await readRun({ stateDir, runId: 'F' })), 'ownership', 'usageSummary'].sort(),
  );
  const remote = refused('run.locked', 'unlock', 'F');
  assert.match(remote.message, /is on foreign host .+--force-remote\.$/u);
  assert.equal(remote.details.host, foreign);
  assert.equal(remote.details.next.length, 1);
  assert.equal(remote.details.next[0].argv.at(-1), '--force-remote');
  assert.ok(remote.message.includes(formatArgv(remote.details.next[0].argv)), remote.message);
  const forced = document(0, 'unlock', 'F', '--force-remote', '--json');
  assert.equal(forced.kind, 'workflow.unlock.result');
  assert.equal(forced.forceRemote, true);
  assert.deepEqual(
    forced.locks.map((lock) => [lock.kind, lock.owner.host, lock.owner.state, lock.action]),
    [
      ['primary', foreign, 'dead', 'removed'],
      ['guard', foreign, 'dead', 'removed'],
    ],
  );
  await completes('F');
  assert.deepEqual(unlockLines(inspectText('F')), []);

  // Orphans: a dead owner with a live recorded child is refused with both; nothing is removed.
  const child = await sleeper();
  plant(primary('O'), {
    'owner.json': owner(DEAD),
    [`processes/${String(child.child.pid)}.json`]: {
      pid: child.child.pid,
      pgid: child.child.pid,
      binary: 'fake-harness',
      cwd: root,
      startedAt: new Date().toISOString(),
      osStartTime: child.start,
      runId: 'O',
      stepId: 'nap',
      attempt: 1,
      ownerToken: owner(DEAD).token,
    },
  });
  const orphans = refused('run.orphans', 'unlock', 'O');
  assert.deepEqual(orphans.details.owner, { pid: DEAD, host: hostname(), state: 'dead' });
  assert.deepEqual(
    orphans.details.processes.map((entry) => [entry.process.pid, entry.state]),
    [[child.child.pid, 'alive']],
  );
  assert.match(orphans.message, /--kill-orphans/u);
  assert.ok(existsSync(join(primary('O'), 'owner.json')));
  // A live child makes unlock refuse, so inspect offers no hint; once it is dead, the plain one.
  assert.deepEqual(unlockLines(inspectText('O')), []);
  await stop(child);
  assert.deepEqual(unlockLines(inspectText('O')), [unlockPrefix('O')]);
  assert.equal(document(0, 'unlock', 'O', '--json').locks[0].action, 'removed');
  await completes('O');

  // A live local owner is refused as alive, whatever the flags.
  const live = await sleeper();
  plant(guard('L'), {
    'owner.json': owner(live.child.pid, hostname(), { osStartTime: live.start }),
  });
  resumeNamesUnlock('L', 'Wait for it or stop it');
  assert.deepEqual(unlockLines(inspectText('L')), []);
  const alive = refused('run.locked', 'unlock', 'L', '--force-remote');
  assert.equal(alive.details.state, 'alive');
  await stop(live);
  document(0, 'unlock', 'L', '--json');
  await completes('L');

  // An older build's metadata-less lock: refused by resume, cleared with a warning.
  plant(guard('M'), { stray: 'x' });
  resumeNamesUnlock('M', 'incomplete ownership metadata');
  const legacy = document(0, 'unlock', 'M', '--json');
  assert.equal(legacy.locks[0].owner, null);
  assert.match(legacy.locks[0].warning, /owner\.json: missing/u);
  await completes('M');

  // A dead recoverer's marker is removed with its lock; a damaged marker blocks resume until then.
  plant(primary('R'), {
    'owner.json': owner(DEAD),
    'recovery.json': owner(DEAD + 1),
  });
  const marker = document(0, 'unlock', 'R', '--json');
  assert.deepEqual(marker.locks[0].recovery, { pid: DEAD + 1, host: hostname(), state: 'dead' });
  await completes('R');
  plant(guard('U'), { 'owner.json': owner(DEAD), 'recovery.json': '{bad' });
  resumeNamesUnlock('U', 'damaged marker');
  const damaged = document(0, 'unlock', 'U', '--json');
  assert.match(damaged.locks[0].warning, /recovery\.json: /u);
  await completes('U');

  // No lock: a no-op with the documented shape; an unknown run is not found.
  assert.deepEqual(document(0, 'unlock', 'F', '--json'), {
    kind: 'workflow.unlock.result',
    ok: true,
    runId: 'F',
    stateDir,
    forceRemote: false,
    locks: [],
  });
  const text = command(['unlock', 'F']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trim(), 'Run F is not locked.');
  refused('run.not_found', 'unlock', 'missing');
  console.log(
    'Unlock CLI: foreign-host, orphan, live-owner, legacy and marker locks are refused or cleared as documented, and each cleared run resumes to completion.',
  );
} finally {
  for (const child of sleepers) await stop({ child }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

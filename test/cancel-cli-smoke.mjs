import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP POSIX signal cancel fixture on Windows');
  process.exit(0);
}

// workflow cancel ends a live local run as cancelled (ADR 0039): the owner exits 130, inspect
// agrees, tick observes the run instead of resuming it, and a repeated cancel is a no-op. One run
// whose only step is a local wait: no harness calls. Plain-SIGINT suspension is covered by the
// process-lifecycle smoke. A suspended run that no process owns is ended under its lock instead,
// without a signal (ADR 0057). A cancel that force-kills an owner whose step ignores its signal
// (--force, or a cancel whose SIGINT is the owner's second signal) keeps its request, and the next
// tick saves the run cancelled instead of resuming it (ADR 0058).
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-cancel-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const calls = join(root, 'calls.txt');
const workflow = join(root, 'wait.mts');
const runId = 'cancel-me';
writeFileSync(
  workflow,
  `import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'dist/index.js'))};
export default defineWorkflow({ name: 'wait', version: '1', input: z.null(), output: z.string(),
  async run(ctx) {
    await ctx.step('wait', { input: null, schema: z.null(), run: async ({ signal }) => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      await delay(60_000, undefined, { signal });
      return null;
    } });
    return 'done';
  } });`,
);

const nap = join(root, 'nap.mts');
writeFileSync(
  nap,
  `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'dist/index.js'))};
export default defineWorkflow({ name: 'nap', version: '1', input: z.null(), output: z.null(),
  async run(ctx) {
    await ctx.sleep('nap', 3_600_000);
    return null;
  } });`,
);

/** A workflow whose only step ignores its abort signal, so a first SIGINT can never finish it. */
function stubborn(name) {
  const file = join(root, `${name}.mts`);
  const log = join(root, `${name}.txt`);
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'dist/index.js'))};
export default defineWorkflow({ name: ${JSON.stringify(name)}, version: '1', input: z.null(), output: z.null(),
  async run(ctx) {
    await ctx.step('stubborn', { input: null, schema: z.null(), run: async () => {
      appendFileSync(${JSON.stringify(log)}, 'call\\n');
      await delay(60_000);
      return null;
    } });
    return null;
  } });`,
  );
  return {
    file,
    calls: () =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0,
  };
}

/** Start `workflow execute` of `file` as run `id` in the background; resolves its exit on close. */
function startOwner(file, id) {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'workflow',
      'execute',
      file,
      '--run-id',
      id,
      '--input',
      'null',
      '--state-dir',
      stateDir,
      '--json',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = { text: '' };
  child.stdout.setEncoding('utf8').on('data', (data) => (output.text += data));
  child.stderr.setEncoding('utf8').on('data', (data) => (output.text += data));
  const exit = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return { child, output, exit };
}

function command(args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'workflow', ...args, '--state-dir', stateDir],
    { cwd: root, encoding: 'utf8', timeout: 90_000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(args);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const callCount = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
async function waitFor(check, what, budget = 120_000) {
  const until = performance.now() + budget;
  while (performance.now() < until) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const owner = spawn(
  process.execPath,
  [
    cliPath,
    'workflow',
    'execute',
    workflow,
    '--run-id',
    runId,
    '--input',
    'null',
    '--state-dir',
    stateDir,
    '--json',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
/** Further owners started below, killed on any failure. */
const others = [];
let ownerOutput = '';
owner.stdout.setEncoding('utf8').on('data', (data) => (ownerOutput += data));
owner.stderr.setEncoding('utf8').on('data', (data) => (ownerOutput += data));
const ownerExit = new Promise((resolve) =>
  owner.once('close', (code, signal) => resolve({ code, signal })),
);

try {
  await waitFor(() => callCount() === 1, 'the wait step to start');
  let ownership;
  await waitFor(() => {
    ownership = document(0, 'inspect', runId, '--json').ownership;
    return ownership?.owner?.state === 'alive';
  }, 'a live owner in inspect');
  assert.equal(ownership.owner.pid, owner.pid);
  assert.equal(typeof ownership.owner.osStartTime, 'string');

  const cancelled = document(0, 'cancel', runId, '--json', '--timeout', '20s');
  assert.equal(cancelled.kind, 'workflow.cancel.result');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.signalsSent, 1);
  assert.equal(cancelled.owner.pid, owner.pid);
  assert.deepEqual(await ownerExit, { code: 130, signal: null }, ownerOutput);

  const inspected = document(0, 'inspect', runId, '--json');
  assert.equal(inspected.status, 'cancelled');
  assert.equal(inspected.interruptedBy, undefined);
  assert.equal(inspected.ownership.locked, false);

  // Tick observes the cancelled run (exit 1 for a cancelled --run) and never re-runs the step.
  const ticked = document(1, 'tick', '--run', runId, '--json');
  assert.deepEqual([ticked.resumed, ticked.skipped, ticked.observed], [[], [], 1]);
  assert.equal(callCount(), 1);

  const again = document(0, 'cancel', runId, '--json');
  assert.equal(again.status, 'cancelled');
  assert.equal(again.signalsSent, 0);
  assert.equal(again.owner, null);
  assert.equal(again.previousStatus, null);

  // A suspended run with no owner: saved cancelled under its lock, reported in text.
  const parked = command(['execute', nap, '--run-id', 'napping', '--input', 'null', '--json']);
  assert.equal(parked.status, 75, parked.stderr || parked.stdout);
  const idle = command(['cancel', 'napping']);
  assert.equal(idle.status, 0, idle.stderr || idle.stdout);
  assert.match(idle.stdout, /^Run napping was suspended with no owner; saved cancelled\.$/mu);
  const napped = document(0, 'inspect', 'napping', '--json');
  assert.equal(napped.status, 'cancelled');
  assert.equal(napped.ownership.locked, false);
  const ticks = document(1, 'tick', '--run', 'napping', '--json');
  assert.deepEqual([ticks.resumed, ticks.skipped, ticks.observed], [[], [], 1]);

  // A forced cancel kills the owner before it saves: the run stays running behind its dead lock,
  // cancel keeps the request bound to that lock, and the next tick saves the run cancelled.
  const forcedRun = stubborn('forced');
  const forcedOwner = startOwner(forcedRun.file, 'forced-1');
  others.push(forcedOwner.child);
  await waitFor(() => forcedRun.calls() === 1, 'the forced step to start');
  await waitFor(
    () => document(0, 'inspect', 'forced-1', '--json').ownership?.owner?.state === 'alive',
    'a live forced owner',
  );
  const killed = command(['cancel', 'forced-1', '--json', '--force', '--timeout', '1s']);
  assert.equal(killed.status, 3, killed.stderr || killed.stdout);
  const killedDocument = JSON.parse(killed.stdout);
  assert.equal(killedDocument.error.code, 'run.unowned');
  assert.deepEqual(killedDocument.error.details, {
    reason: 'owner-exited',
    pid: forcedOwner.child.pid,
    signalsSent: 2,
    forced: true,
    requestKept: true,
  });
  assert.deepEqual(await forcedOwner.exit, { code: 130, signal: null }, forcedOwner.output.text);
  assert.equal(document(0, 'inspect', 'forced-1', '--json').status, 'running');
  const forcedTick = document(1, 'tick', '--run', 'forced-1', '--json');
  assert.deepEqual(forcedTick.resumed, []);
  assert.deepEqual(
    forcedTick.skipped.map(({ runId, reason }) => [runId, reason]),
    [['forced-1', 'cancelled']],
  );
  const forcedInspected = document(0, 'inspect', 'forced-1', '--json');
  assert.equal(forcedInspected.status, 'cancelled');
  assert.equal(forcedInspected.ownership.locked, false);
  assert.equal(forcedRun.calls(), 1);

  // The same when a plain cancel's SIGINT is the owner's second signal: a first plain SIGINT left
  // the owner draining a step that ignores it.
  const secondRun = stubborn('second');
  const secondOwner = startOwner(secondRun.file, 'second-1');
  others.push(secondOwner.child);
  await waitFor(() => secondRun.calls() === 1, 'the second step to start');
  await waitFor(
    () => document(0, 'inspect', 'second-1', '--json').ownership?.owner?.state === 'alive',
    'a live second owner',
  );
  secondOwner.child.kill('SIGINT');
  await waitFor(
    () => secondOwner.output.text.includes('Send again to force'),
    'the first-signal notice',
  );
  const second = command(['cancel', 'second-1', '--json']);
  assert.equal(second.status, 3, second.stderr || second.stdout);
  const secondDocument = JSON.parse(second.stdout);
  assert.equal(secondDocument.error.code, 'run.unowned');
  assert.deepEqual(secondDocument.error.details, {
    reason: 'owner-exited',
    pid: secondOwner.child.pid,
    signalsSent: 1,
    forced: false,
    requestKept: true,
  });
  assert.deepEqual(await secondOwner.exit, { code: 130, signal: null }, secondOwner.output.text);
  const secondTick = document(1, 'tick', '--run', 'second-1', '--json');
  assert.deepEqual(
    secondTick.skipped.map(({ runId, reason }) => [runId, reason]),
    [['second-1', 'cancelled']],
  );
  assert.equal(document(0, 'inspect', 'second-1', '--json').status, 'cancelled');
  assert.equal(secondRun.calls(), 1);
  console.log('workflow cancel CLI smoke passed');
} finally {
  for (const child of [owner, ...others])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}

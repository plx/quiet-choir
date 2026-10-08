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
// without a signal (ADR 0057).
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
  console.log('workflow cancel CLI smoke passed');
} finally {
  if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}

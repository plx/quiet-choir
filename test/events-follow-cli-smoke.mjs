// `workflow events --follow` through the built CLI: a run started by another process is followed
// from its record while its workflow file is unimportable, lines arrive while it runs, and the
// follower exits with the watch codes; usage and missing-run refusals.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const runtime = JSON.stringify(join(project, 'dist/index.js'));
const bin = join(project, 'bin/run.js');
const root = mkdtempSync(join(tmpdir(), 'choir-events-follow-cli-'));
const stateDir = join(root, 'state');
const children = new Set();

function cli(args) {
  const result = spawnSync(process.execPath, [bin, 'workflow', ...args, '--state-dir', stateDir], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function expectExit(result, code) {
  assert.equal(result.status, code, `${result.stdout}\n${result.stderr}`);
  return result;
}
/** Every stdout line: parsed JSON, each within the 512-byte cap. */
function eventLines(text) {
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines)
    assert.ok(Buffer.byteLength(line) <= 512, `event line over 512 bytes: ${line}`);
  return lines.map((line) => JSON.parse(line));
}
const summary = (events) =>
  events.map((event) => `${event.ev}${event.step === undefined ? '' : ` ${event.step}`}`);
async function until(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
/** Spawn a follower and collect its stdout as it arrives. */
function follower(args) {
  const child = spawn(
    process.execPath,
    [bin, 'workflow', 'events', ...args, '--state-dir', stateDir, '--interval', '100ms'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(child);
  const state = { stdout: '', stderr: '', child, closed: once(child, 'close') };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    state.stderr += chunk;
  });
  return state;
}

const first = join(root, 'first-release');
const second = join(root, 'second-release');
const live = join(root, 'live.workflow.mts');
writeFileSync(
  live,
  `import { defineWorkflow, z } from ${runtime};
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const hold = (file: string) => async () => {
  while (!existsSync(file)) await delay(25);
  return null;
};
export default defineWorkflow({ name: 'live', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    ctx.phase('hold');
    ctx.log('waiting for release', { round: 1 });
    await ctx.step('first', { input: null, schema: z.null(), run: hold(${JSON.stringify(first)}) });
    ctx.log('released once');
    await ctx.step('second', { input: null, schema: z.null(), run: hold(${JSON.stringify(second)}) });
    return 'released';
  },
});
`,
);
const ask = join(root, 'ask.workflow.mts');
writeFileSync(
  ask,
  `import { defineWorkflow, z } from ${runtime};
export default defineWorkflow({ name: 'ask', version: '1', input: z.object({}), output: z.boolean(),
  async run(ctx) {
    return ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() });
  },
});
`,
);

try {
  // A run started by another process; then its workflow file becomes unimportable.
  {
    const started = expectExit(
      cli(['start', live, '--run-id', 'live', '--input', '{}', '--json']),
      0,
    );
    assert.equal(JSON.parse(started.stdout).kind, 'workflow.start.result');
    unlinkSync(live);
    writeFileSync(live, 'export default {{{ not TypeScript\n');

    const replay = follower(['live', '--follow', '--from-start']);
    // Debug logging reports each read on stderr, so the release waits for the baseline read.
    const tail = follower(['live', '--follow', '--log-level', 'debug']);
    await until(
      () => summary(eventLines(replay.stdout)).includes('log'),
      'the phase and log lines from the start',
    );
    assert.equal(replay.child.exitCode, null);
    assert.deepEqual(summary(eventLines(replay.stdout)), ['run.started', 'phase', 'log']);
    assert.match(eventLines(replay.stdout)[2].msg, /^waiting for release \{"round":1\}$/u);
    await until(() => tail.stderr.includes('Events: read run live'), 'the baseline read');
    assert.equal(tail.stdout, '', 'the default start prints nothing already in the record');
    writeFileSync(first, 'go');
    await until(
      () => summary(eventLines(tail.stdout)).includes('log'),
      'the lines after the first release',
    );
    assert.equal(tail.child.exitCode, null, 'the run is still holding its second step');
    assert.deepEqual(summary(eventLines(tail.stdout)), ['step.completed first', 'log']);
    writeFileSync(second, 'go');
    const [tailCode] = await tail.closed;
    const [replayCode] = await replay.closed;
    children.delete(tail.child);
    children.delete(replay.child);
    assert.equal(tailCode, 0, tail.stderr);
    assert.equal(replayCode, 0, replay.stderr);
    assert.deepEqual(summary(eventLines(tail.stdout)), [
      'step.completed first',
      'log',
      'step.completed second',
      'run.completed',
    ]);
    assert.deepEqual(summary(eventLines(replay.stdout)), [
      'run.started',
      'phase',
      'log',
      'step.completed first',
      'log',
      'step.completed second',
      'run.completed',
    ]);
    // Printing once reads the same record and exits 0.
    const once = expectExit(cli(['events', 'live']), 0);
    assert.deepEqual(summary(eventLines(once.stdout)), summary(eventLines(replay.stdout)));
  }

  // A suspended run: the follower exits 75 at once; --from-start shows the opened question.
  {
    expectExit(cli(['execute', ask, '--run-id', 'gate']), 75);
    const plain = expectExit(cli(['events', 'gate', '--follow']), 75);
    assert.equal(plain.stdout, '');
    const replayed = expectExit(cli(['events', 'gate', '--follow', '--from-start']), 75);
    assert.deepEqual(summary(eventLines(replayed.stdout)), [
      'run.started',
      'wait.opened gate',
      'run.suspended',
    ]);
  }

  // Usage and missing-run refusals.
  {
    const conflict = expectExit(
      cli(['events', 'gate', '--follow', '--from-start', '--after-execution', '1', '--json']),
      2,
    );
    assert.equal(JSON.parse(conflict.stdout).error.code, 'usage.flag');
    const missing = expectExit(cli(['events', 'never', '--follow', '--json']), 3);
    assert.equal(JSON.parse(missing.stdout).error.code, 'run.not_found');
    const waited = expectExit(
      cli(['events', 'never', '--follow', '--wait-created', '200ms', '--json']),
      66,
    );
    assert.equal(JSON.parse(waited.stdout).error.code, 'watch.record_not_created');
  }
  console.log(
    'Events follow CLI: unimportable-workflow follow, live lines, exits 0/75, usage and missing-run refusals passed.',
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}

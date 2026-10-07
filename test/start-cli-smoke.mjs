import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP detached workflow start (POSIX sessions) on Windows');
  process.exit(0);
}

// `workflow start` launches `workflow execute` detached and returns once the runner owns its record.
// Every workflow here is local: no harness calls. The CLI runs as `node bin/run.js` with no
// quiet-choir on PATH, so the runner's argv must be launcher-correct on its own.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-start-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const dist = JSON.stringify(join(repository, 'dist/index.js'));
const env = { ...process.env, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
const runners = new Set();

function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, 'workflow', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
function documentOf(result, expected) {
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  const document = JSON.parse(result.stdout);
  const pid = document.pid ?? document.launch?.pid;
  if (typeof pid === 'number') runners.add(pid);
  return document;
}
function start(...args) {
  return cli(['start', ...args, '--state-dir', stateDir, '--json']);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
async function gone(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`Runner ${pid} is still alive.`);
    await delay(50);
  }
}
function inspectSummary(runId) {
  return cli(['inspect', runId, '--state-dir', stateDir, '--json', '--summary']);
}
const mode = (path) => statSync(path).mode & 0o777;
function workflowFile(name, source) {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

const release = join(root, 'release');
const gated = workflowFile(
  'gated.workflow.mts',
  `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineWorkflow, z } from ${dist};
export default defineWorkflow({ name: 'gated', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    return ctx.step('gate', { input: null, schema: z.string(), run: async () => {
      while (!existsSync(${JSON.stringify(release)})) await delay(50);
      return 'released';
    } });
  } });`,
);
const echo = workflowFile(
  'echo.workflow.mts',
  `import { defineWorkflow, z } from ${dist};
export default defineWorkflow({ name: 'echo', version: '1', input: z.object({ word: z.string() }),
  output: z.string(), async run(_ctx, input) { return input.word; } });`,
);
const broken = workflowFile(
  'broken.workflow.mts',
  `import { defineWorkflow, z } from ${dist};
const count: number = 'not a number';
export default defineWorkflow({ name: 'broken', version: '1', input: z.object({}), output: z.number(),
  async run() { return count; } });`,
);
const held = workflowFile(
  'held.workflow.mts',
  `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineWorkflow, z } from ${dist};
export default defineWorkflow({ name: 'held', version: '1', input: z.object({ gate: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    return ctx.step('gate', { input: input.gate, schema: z.string(), run: async ({ signal }) => {
      while (!existsSync(input.gate)) { signal.throwIfAborted(); await delay(50); }
      return 'released';
    } });
  } });`,
);
const hanging = workflowFile(
  'hanging.workflow.mts',
  `import { defineWorkflow, z } from ${dist};
await new Promise(() => { setInterval(() => {}, 1000); });
export default defineWorkflow({ name: 'hanging', version: '1', input: z.object({}), output: z.number(),
  async run() { return 1; } });`,
);

try {
  // 1. A named run: start returns its ID only once inspect can read the record.
  const began = Date.now();
  const first = documentOf(
    start(join(repository, 'examples/local.workflow.ts'), '--run-id', 'x'),
    0,
  );
  const elapsed = Date.now() - began;
  console.log(`workflow start returned in ${String(elapsed)} ms (status ${first.status})`);
  assert.ok(elapsed < 20_000, `start took ${String(elapsed)} ms`);
  assert.equal(first.kind, 'workflow.start.result');
  assert.equal(first.ok, true);
  assert.equal(first.exitCode, 0);
  assert.equal(first.runId, 'x');
  assert.equal(first.stateDir, stateDir);
  assert.equal(first.log, join(stateDir, 'x', 'launch', '1.log'));
  assert.equal(first.result, join(stateDir, 'x', 'launch', '1.result.json'));
  assert.deepEqual(first.next[0].argv, [
    process.execPath,
    cliPath,
    'workflow',
    'inspect',
    'x',
    '--state-dir',
    stateDir,
    '--json',
    '--summary',
  ]);
  const inspected = inspectSummary('x');
  assert.equal(inspected.status, 0, inspected.stdout || inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).id, 'x');

  // 2. A generated run ID has the same guarantee.
  const generated = documentOf(start(echo, '--input', '{"word":"generated"}'), 0);
  assert.match(generated.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(inspectSummary(generated.runId).status, 0);

  // 3. A type error fails before any record: the runner's error, no started run ID, the log kept.
  const typecheck = documentOf(start(broken, '--run-id', 'broken'), 4);
  assert.equal(typecheck.ok, false);
  assert.equal(typecheck.error.code, 'load.typecheck');
  assert.equal(typecheck.runId, null);
  assert.ok(typecheck.diagnostics.length > 0);
  assert.equal(typecheck.launch.runId, 'broken');
  assert.equal(typecheck.launch.exitCode, 4);
  assert.ok(existsSync(typecheck.launch.log));
  assert.match(readFileSync(typecheck.launch.log, 'utf8'), /not assignable/u);
  assert.equal(existsSync(join(stateDir, 'broken', 'run.json')), false);
  assert.equal(inspectSummary('broken').status, 3);
  // Its runner has exited, so list reports the leftover launch directory and rm removes it.
  const listed = documentOf(cli(['list', '--state-dir', stateDir, '--json']), 0);
  assert.deepEqual(
    listed.leftoverLaunches.map((entry) => [entry.runId, entry.log]),
    [['broken', typecheck.launch.log]],
  );
  const leftover = documentOf(cli(['rm', 'broken', '--state-dir', stateDir, '--json']), 0);
  assert.equal(leftover.kind, 'workflow.rm.result');
  assert.equal(leftover.launchOnly, true);
  assert.equal(existsSync(join(stateDir, 'broken')), false);

  // 4. A usage refusal by the runner comes back the same way.
  const usage = documentOf(start(echo, '--run-id', 'usage', '--max-agents', '0'), 2);
  assert.equal(usage.error.code, 'usage.flag');
  assert.equal(usage.runId, null);
  assert.equal(usage.launch.exitCode, 2);
  assert.equal(existsSync(join(stateDir, 'usage', 'run.json')), false);

  // 5. The runner outlives start: start returns (no inherited pipe holds it) while the runner
  // waits for the release file, then the run completes into the launch result file.
  const survivor = documentOf(start(gated, '--run-id', 'survivor'), 0);
  assert.equal(survivor.status, 'running');
  assert.ok(alive(survivor.pid), 'the runner must outlive start');
  writeFileSync(release, '');
  await gone(survivor.pid);
  const completion = JSON.parse(readFileSync(survivor.result, 'utf8'));
  assert.equal(completion.kind, 'workflow.run.result');
  assert.equal(completion.status, 'completed');
  assert.equal(completion.output, 'released');
  const launchDir = join(stateDir, 'survivor', 'launch');
  assert.equal(mode(launchDir), 0o700);
  assert.equal(mode(join(launchDir, '1.log')), 0o600);
  assert.equal(mode(join(launchDir, '1.result.json')), 0o600);

  // 6. An existing run is refused before anything is spawned or written.
  const before = readdirSync(join(stateDir, 'x', 'launch')).sort();
  const exists = documentOf(
    start(join(repository, 'examples/local.workflow.ts'), '--run-id', 'x'),
    3,
  );
  assert.equal(exists.error.code, 'run.exists');
  assert.equal(exists.launch, undefined);
  assert.deepEqual(readdirSync(join(stateDir, 'x', 'launch')).sort(), before);

  // 7. Stdin input reaches the runner, whose own stdin is /dev/null.
  const piped = documentOf(
    cli(['start', echo, '--run-id', 'piped', '--input', '-', '--state-dir', stateDir, '--json'], {
      input: '{"word":"from stdin"}',
    }),
    0,
  );
  await gone(piped.pid);
  assert.equal(JSON.parse(readFileSync(piped.result, 'utf8')).output, 'from stdin');
  assert.equal(mode(join(stateDir, 'piped', 'launch', '1.input.json')), 0o600);

  // 8. A runner that never creates its record is stopped at the start timeout.
  const timedOut = documentOf(
    start(hanging, '--run-id', 'hanging', '--start-timeout', '3s', '--kill-grace-ms', '500'),
    124,
  );
  assert.equal(timedOut.error.code, 'start.timeout');
  assert.equal(timedOut.runId, null);
  assert.equal(alive(timedOut.launch.pid), false);

  // 9. A detached resume of an interrupted run returns once its new runner records an execution.
  const gate = join(root, 'held-gate');
  const held1 = documentOf(
    start(held, '--run-id', 'resumed', '--input', JSON.stringify({ gate })),
    0,
  );
  process.kill(held1.pid, 'SIGTERM');
  await gone(held1.pid);
  const suspended = inspectSummary('resumed');
  assert.equal(suspended.status, 0, suspended.stdout || suspended.stderr);
  assert.equal(JSON.parse(suspended.stdout).status, 'suspended');
  const executionsOf = (runId) =>
    documentOf(cli(['inspect', runId, '--state-dir', stateDir, '--json']), 0).executions;
  const before1 = executionsOf('resumed');
  const resumed = documentOf(start('--resume', '--run-id', 'resumed'), 0);
  assert.equal(resumed.kind, 'workflow.start.result');
  assert.equal(resumed.runId, 'resumed');
  assert.notEqual(resumed.pid, held1.pid);
  assert.equal(resumed.log, join(stateDir, 'resumed', 'launch', '2.log'));
  assert.ok(existsSync(resumed.log));
  assert.ok(existsSync(join(stateDir, 'resumed', 'launch', '1.log')));
  assert.ok(existsSync(join(stateDir, 'resumed', 'launch', '1.result.json')));
  const after1 = executionsOf('resumed');
  assert.equal(after1.length, before1.length + 1);
  assert.equal(after1.at(-1).pid, resumed.pid);

  // 10. A second resume while that runner holds the run is refused, never reported as started.
  const contended = documentOf(start('--resume', '--run-id', 'resumed'), 3);
  assert.equal(contended.error.code, 'run.locked');
  assert.equal(contended.runId, 'resumed');
  assert.ok(alive(resumed.pid), 'the refused resume must not stop the owner');

  // 11. Releasing the gate completes the resumed run; resuming the completed run reports it.
  writeFileSync(gate, '');
  await gone(resumed.pid);
  assert.equal(JSON.parse(inspectSummary('resumed').stdout).status, 'completed');
  const replayed = documentOf(start('--resume', '--run-id', 'resumed'), 0);
  assert.equal(replayed.status, 'completed');
  await gone(replayed.pid);

  // 12. A missing run or a missing --run-id is refused before anything is launched.
  const missing = documentOf(start('--resume', '--run-id', 'unknown'), 3);
  assert.equal(missing.error.code, 'run.not_found');
  assert.equal(missing.launch, undefined);
  assert.equal(existsSync(join(stateDir, 'unknown')), false);
  const noRunId = documentOf(start('--resume'), 2);
  assert.equal(noRunId.error.code, 'usage.resume_requires_run_id');

  // 13. Rehearsal and --full stay foreground-only: a usage error naming the execute command.
  for (const flag of ['--dry-run', '--full']) {
    const refused = documentOf(
      start(echo, '--run-id', 'rehearsal', flag, '--start-timeout', '5s'),
      2,
    );
    assert.equal(refused.error.code, 'usage.flag');
    assert.match(refused.error.message, /workflow execute in the foreground/u);
    assert.deepEqual(refused.next[0].argv, [
      process.execPath,
      cliPath,
      'workflow',
      'execute',
      echo,
      '--run-id',
      'rehearsal',
      flag,
      '--state-dir',
      stateDir,
      '--json',
    ]);
    assert.equal(existsSync(join(stateDir, 'rehearsal')), false);
  }

  console.log(
    'workflow start: readiness, failures, survival, stdin, timeout, resume and refusals passed',
  );
} finally {
  for (const pid of runners)
    await gone(pid).catch(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    });
  rmSync(root, { recursive: true, force: true });
}

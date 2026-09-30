import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readRun } from '../dist/index.js';

// Tick recovers runs whose owner process died, and stops after three recoveries without progress.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-tick-recovery-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const dist = JSON.stringify(join(repository, 'dist/index.js'));
const cliArgs = (args) => [cliPath, 'workflow', ...args, '--state-dir', stateDir];
function command(...args) {
  const result = spawnSync(process.execPath, cliArgs(args), {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(...args);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
/** A CLI invocation that must die by SIGKILL, from the test or from its own workflow step. */
function killed(...args) {
  const result = command(...args);
  assert.equal(result.signal, 'SIGKILL', result.stderr || result.stdout);
}
async function until(condition, what) {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(25);
  }
}
/** Every file under a run directory, to prove that a tick changed nothing. */
function runBytes(runId) {
  const base = join(stateDir, runId);
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[relative(base, path)] = readFileSync(path, 'utf8');
    }
  };
  visit(base);
  return files;
}

try {
  // Part 1: SIGKILL the tick process while its resumed step runs; the next tick recovers the run.
  const started = join(root, 'started.txt');
  const go = join(root, 'go.txt');
  const slowFile = join(root, 'slow.mts');
  writeFileSync(
    slowFile,
    `import { defineWorkflow, z } from ${dist};
import { appendFileSync, existsSync } from 'node:fs';
export default defineWorkflow({ name: 'slow', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    await ctx.sleep('nap', 1500);
    return ctx.step('slow', { input: null, schema: z.string(), run: async () => {
      appendFileSync(${JSON.stringify(started)}, 'started\\n');
      const deadline = Date.now() + 60000;
      while (!existsSync(${JSON.stringify(go)})) {
        if (Date.now() > deadline) throw new Error('go file never appeared');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return 'done';
    } });
  } });`,
  );
  const suspended = document(75, 'execute', slowFile, '--run-id', 'R', '--json');
  assert.equal(suspended.kind, 'workflow.run.suspended');
  const wakeAt = suspended.run.nextWakeAt;
  assert.ok(wakeAt);
  await delay(Math.max(0, wakeAt - Date.now() + 100));
  const doomed = spawn(process.execPath, cliArgs(['tick', '--run', 'R', '--json']), {
    cwd: root,
    stdio: 'ignore',
  });
  const exited = once(doomed, 'exit');
  await until(() => existsSync(started), 'the resumed step to start');
  doomed.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.equal((await readRun({ stateDir, runId: 'R' })).status, 'running');
  assert.ok(statSync(join(stateDir, 'R', 'lock')).isDirectory());
  assert.equal(document(0, 'inspect', 'R', '--json', '--summary').status, 'stale');
  writeFileSync(go, 'go');
  const recovered = document(0, 'tick', '--run', 'R', '--json');
  assert.deepEqual(recovered.resumed, [{ runId: 'R', outcome: 'completed' }]);
  assert.deepEqual(recovered.skipped, []);
  const completed = await readRun({ stateDir, runId: 'R' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output, 'done');
  assert.equal(completed.staleRecovery, undefined);

  // Part 2: a step that SIGKILLs its own process on every attempt, across separate processes.
  const crash = join(root, 'crash.flag');
  const crashFile = join(root, 'crash.mts');
  const imports = join(root, 'imports.txt');
  writeFileSync(crash, 'crash');
  writeFileSync(
    crashFile,
    `import { defineWorkflow, z } from ${dist};
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(${JSON.stringify(imports)}, 'import\\n');
export default defineWorkflow({ name: 'crash', version: '1', input: z.object({}), output: z.null(),
  async run(ctx) {
    await ctx.step('before', { input: null, schema: z.null(), run: () => null });
    return ctx.step('crash', { input: null, schema: z.null(), run: () => {
      if (existsSync(${JSON.stringify(crash)})) process.kill(process.pid, 'SIGKILL');
      return null;
    } });
  } });`,
  );
  killed('execute', crashFile, '--run-id', 'C', '--json');
  const crashed = await readRun({ stateDir, runId: 'C' });
  assert.equal(crashed.status, 'running');
  assert.equal(crashed.staleRecovery, undefined);
  assert.equal(crashed.steps.before.status, 'completed');
  for (const count of [1, 2, 3]) {
    killed('tick', '--run', 'C', '--json');
    const saved = await readRun({ stateDir, runId: 'C' });
    assert.equal(saved.status, 'running');
    assert.equal(saved.staleRecovery?.count, count);
    assert.equal(saved.staleRecovery?.completedSteps, 1);
  }
  const before = runBytes('C');
  const importsBefore = readFileSync(imports, 'utf8');
  assert.equal(importsBefore, 'import\n'.repeat(4));
  const capped = document(1, 'tick', '--run', 'C', '--json');
  assert.deepEqual(capped.resumed, []);
  assert.equal(capped.skipped.length, 1);
  const [skipped] = capped.skipped;
  assert.equal(skipped.runId, 'C');
  assert.equal(skipped.reason, 'crash-loop');
  assert.match(skipped.message, /cap 3/u);
  assert.match(skipped.message, /quiet-choir workflow resume C/u);
  assert.deepEqual(runBytes('C'), before);
  assert.equal(readFileSync(imports, 'utf8'), importsBefore);

  rmSync(crash);
  const resumed = document(0, 'resume', 'C', '--json');
  assert.equal(resumed.status, 'completed');
  assert.equal((await readRun({ stateDir, runId: 'C' })).staleRecovery, undefined);
  console.log(
    'Tick recovery CLI: a SIGKILLed tick is recovered by the next tick, and a crash loop stops at the persisted cap until an explicit resume.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

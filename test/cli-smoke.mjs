import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedCommands = [
  'configuration:doctor',
  'configuration:get',
  'configuration:set',
  'info:version',
  'workflow:check-resume',
  'workflow:execute',
  'workflow:inspect',
  'workflow:typecheck',
  'workflow:validate',
];

const config = await Config.load({ root: projectRoot });
assert.deepEqual([...config.commandIDs].sort(), expectedCommands);

function cli(...args) {
  return spawnSync(process.execPath, ['./bin/run.js', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const help = cli('--help');
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /quiet-choir\/0\.0\.0/);
assert.match(help.stdout, /workflow\s+Execute and inspect workflows/);

const stub = cli('configuration', 'doctor');
assert.equal(stub.status, 2, stub.stderr);
assert.match(stub.stdout, /configuration doctor is not implemented yet\./);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'quiet-choir-smoke-'));
try {
  const validEntrypoint = join(fixtureRoot, 'valid.ts');
  const invalidEntrypoint = join(fixtureRoot, 'invalid.ts');
  writeFileSync(validEntrypoint, 'export const value: number = 1;\n', 'utf8');
  writeFileSync(invalidEntrypoint, "export const value: number = 'wrong';\n", 'utf8');

  const valid = cli('workflow', 'typecheck', validEntrypoint);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Type check passed/);

  const invalid = cli('workflow', 'typecheck', invalidEntrypoint);
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.match(invalid.stderr, /error TS2322/);
  const invalidExecute = cli('workflow', 'execute', invalidEntrypoint);
  assert.equal(invalidExecute.status, 1, invalidExecute.stdout);
  assert.match(invalidExecute.stderr, /error TS2322/);

  const workflow = join(fixtureRoot, 'workflow.ts');
  const helper = join(fixtureRoot, 'helper.ts');
  const effects = join(fixtureRoot, 'effects.txt');
  const failureSwitch = join(fixtureRoot, 'fail');
  const stateDir = join(fixtureRoot, 'state');
  writeFileSync(join(fixtureRoot, 'package.json'), '{"type":"module"}');
  symlinkSync(join(projectRoot, 'node_modules'), join(fixtureRoot, 'node_modules'));
  writeFileSync(helper, 'export const factor = 2;');
  writeFileSync(failureSwitch, 'fail this attempt');
  writeFileSync(
    workflow,
    `
import { appendFile, access } from 'node:fs/promises';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'dist/index.js'))};
import { z } from 'zod';
import { factor } from './helper.js';
export default defineWorkflow({
  name: 'smoke', version: '1', input: z.object({ value: z.number() }), output: z.number(),
  async run(ctx, input) {
    const first = await ctx.step('first', { input: input.value, schema: z.number(), async run() {
      await appendFile(${JSON.stringify(effects)}, 'first\\n');
      return input.value;
    }});
    return ctx.step('second', { input: first, schema: z.number(), async run() {
      const fail = await access(${JSON.stringify(failureSwitch)}).then(() => true, () => false);
      if (fail) throw new Error('intentional smoke failure');
      return first * factor;
    }});
  },
});
`,
  );

  const validated = cli('workflow', 'validate', workflow, '--json');
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).workflow.name, 'smoke');
  assert.equal(existsSync(effects), false, 'Validation must not run the workflow body');

  const badInput = cli(
    'workflow',
    'execute',
    workflow,
    '--input',
    '{"value":"wrong"}',
    '--state-dir',
    stateDir,
  );
  assert.equal(badInput.status, 1, badInput.stdout);
  assert.equal(existsSync(effects), false, 'Input validation must precede effects');

  const failed = cli(
    'workflow',
    'execute',
    workflow,
    '--input',
    '{"value":21}',
    '--run-id',
    'smoke-run',
    '--state-dir',
    stateDir,
    '--json',
  );
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /Run ID: smoke-run/);
  assert.match(failed.stderr, /intentional smoke failure/);
  assert.equal(readFileSync(effects, 'utf8'), 'first\n');
  const failedInspection = cli(
    'workflow',
    'inspect',
    'smoke-run',
    '--state-dir',
    stateDir,
    '--json',
  );
  assert.equal(failedInspection.status, 0, failedInspection.stderr);
  assert.equal(JSON.parse(failedInspection.stdout).status, 'failed');

  rmSync(failureSwitch);
  const resumed = cli(
    'workflow',
    'execute',
    workflow,
    '--run-id',
    'smoke-run',
    '--state-dir',
    stateDir,
    '--resume',
    '--json',
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).output, 42);
  assert.equal(
    readFileSync(effects, 'utf8'),
    'first\n',
    'Completed effect must not repeat across processes',
  );

  writeFileSync(helper, 'export const factor = 3;');
  const drift = cli(
    'workflow',
    'execute',
    workflow,
    '--run-id',
    'smoke-run',
    '--state-dir',
    stateDir,
    '--resume',
  );
  assert.equal(drift.status, 1, drift.stdout);
  assert.match(drift.stderr, /fingerprint|changed|incompatible/i);

  rmSync(workflow);
  const inspected = cli('workflow', 'inspect', 'smoke-run', '--state-dir', stateDir, '--json');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).output, 42);

  const missing = cli('workflow', 'inspect', 'nope', '--state-dir', stateDir);
  assert.equal(missing.status, 1, missing.stdout);
  const missingMessage = missing.stderr.replace(/\n\s*›\s*/gu, '');
  assert.ok(missingMessage.includes(`Run nope not found in ${stateDir}`), missing.stderr);
  assert.match(missing.stderr, /1 runs present: smoke-run/);
  assert.doesNotMatch(missing.stderr, /ENOENT/);

  // A real host process with no rejection handler must survive detached observer/precheck failures.
  const promiseHost = join(fixtureRoot, 'promise-host.mjs');
  writeFileSync(
    promiseHost,
    `
import assert from 'node:assert/strict';
import { defineWorkflow, runWorkflow, readRun, z } from ${JSON.stringify(join(projectRoot, 'dist/index.js'))};
const stateDir = ${JSON.stringify(stateDir)};
const harness = { async invoke() { return { text: 'ok', sessionId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } }; } };
const definition = (run) => defineWorkflow({ name: 'host', version: '1', input: z.null(), output: z.string(), run });
const completed = await runWorkflow(definition(async (ctx) => (await ctx.claude.text('ask', { prompt: 'p' })).output), {
  stateDir, runId: 'observer', input: null, harness,
  onEvent: async () => { throw new Error('metrics endpoint down'); },
});
assert.equal(completed.status, 'completed');
for (const kind of ['sleep', 'agent']) {
  await assert.rejects(runWorkflow(definition(async (ctx) => {
    if (kind === 'sleep') void ctx.sleep('bad-sleep', -1);
    else void ctx.claude.text('bad-agent', { prompt: 'p', tools: ['Read', undefined] });
    return 'ok';
  }), { stateDir, runId: kind, input: null }), new RegExp('Unawaited workflow operation "bad-' + kind + '" failed:'));
  assert.equal((await readRun({ stateDir, runId: kind })).status, 'failed');
}
await new Promise((resolve) => setImmediate(resolve));
console.log('survived');
`,
  );
  const promiseResult = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', promiseHost],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(promiseResult.status, 0, promiseResult.stderr);
  assert.equal(promiseResult.stdout.trim(), 'survived');
  assert.equal(promiseResult.stderr, '');

  const warningWorkflow = join(fixtureRoot, 'warning.ts');
  writeFileSync(
    warningWorkflow,
    `
import { rm } from 'node:fs/promises';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'dist/index.js'))};
import { z } from 'zod';
export default defineWorkflow({
  name: 'warning', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    return ctx.step('remove-lock', { input: null, schema: z.string(), async run() {
      await rm(${JSON.stringify(join(stateDir, 'warning-run.json.lock'))}, { recursive: true });
      return 'done';
    }});
  },
});
`,
  );
  const warning = cli(
    'workflow',
    'execute',
    warningWorkflow,
    '--run-id',
    'warning-run',
    '--state-dir',
    stateDir,
    '--json',
  );
  assert.equal(warning.status, 0, warning.stderr);
  assert.equal(JSON.parse(warning.stdout).output, 'done');
  assert.equal(JSON.parse(warning.stdout).warnings.length, 1);
  assert.match(warning.stderr, /Warning: Could not release run warning-run lock/);
  assert.equal(
    JSON.parse(readFileSync(join(stateDir, 'warning-run.json'), 'utf8')).status,
    'completed',
  );

  const crashWorkflow = join(fixtureRoot, 'crash.ts');
  const crashEffects = join(fixtureRoot, 'crash-effects.txt');
  writeFileSync(
    crashWorkflow,
    `
import { appendFile } from 'node:fs/promises';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'dist/index.js'))};
import { z } from 'zod';
export default defineWorkflow({
  name: 'crash', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    await ctx.step('first', { input: null, schema: z.null(), async run() {
      await appendFile(${JSON.stringify(crashEffects)}, 'first\\n');
      return null;
    }});
    await ctx.sleep('wait', 250);
    return 'done';
  },
});
`,
  );
  const crashing = spawn(
    process.execPath,
    [
      './bin/run.js',
      'workflow',
      'execute',
      crashWorkflow,
      '--run-id',
      'crash-run',
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const exited = once(crashing, 'exit');
  let crashErrors = '';
  crashing.stderr.setEncoding('utf8').on('data', (chunk) => {
    crashErrors += chunk;
  });
  let wakeAt;
  try {
    const checkpoint = join(stateDir, 'crash-run.json');
    for (let attempt = 0; attempt < 1500; attempt++) {
      if (existsSync(checkpoint)) {
        const record = JSON.parse(readFileSync(checkpoint, 'utf8'));
        if (record.steps.wait?.status === 'running' && record.steps.wait.wakeAt !== null) {
          wakeAt = record.steps.wait.wakeAt;
          break;
        }
      }
      if (crashing.exitCode !== null || crashing.signalCode !== null) break;
      await delay(20);
    }
    assert.equal(typeof wakeAt, 'number', `Did not observe a sleeping checkpoint: ${crashErrors}`);
    crashing.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    assert.equal(readFileSync(crashEffects, 'utf8'), 'first\n');
    await delay(300);
    const crashResume = cli(
      'workflow',
      'execute',
      crashWorkflow,
      '--run-id',
      'crash-run',
      '--state-dir',
      stateDir,
      '--resume',
      '--json',
    );
    assert.equal(crashResume.status, 0, crashResume.stderr);
    const recovered = JSON.parse(crashResume.stdout);
    assert.equal(recovered.output, 'done');
    assert.equal(
      recovered.steps.wait.wakeAt,
      wakeAt,
      'Resume must preserve the original durable timer',
    );
    assert.equal(recovered.steps.wait.attempts, 2);
    assert.equal(
      readFileSync(crashEffects, 'utf8'),
      'first\n',
      'A process crash must not repeat a completed effect',
    );
  } finally {
    if (crashing.exitCode === null && crashing.signalCode === null) crashing.kill('SIGKILL');
    await exited;
  }
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

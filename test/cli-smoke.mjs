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

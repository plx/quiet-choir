// A run started with --harness fixture:<file> keeps that selection: `workflow tick --run ID`, a
// plain `workflow resume ID` and the emitted resumeCommand all continue it with the recorded fixture
// (#136). Zero cost: PATH resolves `claude` and `codex` to bombs that fail the smoke if anything
// launches them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'choir-launch-policy-cli-')));
const file = join(root, 'workflow.ts');
const fixture = join(root, 'f.json');
const state = join(root, 'state');
const bin = join(root, 'bin');
const elsewhere = join(root, 'elsewhere');
const forbidden = join(root, 'default-binary-ran');
const sleepMs = 1_500;
const env = {
  ...process.env,
  PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
  XDG_STATE_HOME: join(root, 'xdg'),
};

function check(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(existsSync(forbidden), false, 'A native harness binary was launched.');
  return result;
}

function run(args) {
  const result = check(
    spawnSync(
      process.execPath,
      [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', state, '--json'],
      { cwd: root, encoding: 'utf8', timeout: 60_000, env },
    ),
  );
  return { status: result.status, stderr: result.stderr, value: JSON.parse(result.stdout) };
}

const record = (id) => JSON.parse(readFileSync(join(state, id, 'run.json'), 'utf8'));
/** Wait for the run's own wake time, so a loaded machine cannot make the resume early. */
const untilDue = async (id) => {
  const wakeAt = record(id).nextWakeAt;
  assert.equal(typeof wakeAt, 'number');
  await delay(Math.max(0, wakeAt + 200 - Date.now()));
};

try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(bin);
  mkdirSync(elsewhere);
  for (const name of ['claude', 'codex']) {
    const bomb = join(bin, name);
    writeFileSync(
      bomb,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'bad'); process.exit(99);`,
    );
    chmodSync(bomb, 0o700);
  }
  writeFileSync(fixture, JSON.stringify({ version: 1, calls: [{ step: 'call', text: 'fixed' }] }));
  writeFileSync(
    file,
    `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({ name: 'launch-policy-cli', version: '1', input: z.null(), output: z.string(),
  strictProfiles: false,
  async run(ctx) {
    await ctx.sleep('timer', ${String(sleepMs)});
    return (await ctx.claude.text('call', { prompt: 'hi' })).output;
  } });
`,
  );
  const resumeCommands = {};
  for (const id of ['ticked', 'emitted', 'plain']) {
    // A relative fixture path is recorded, and emitted, as the absolute path it resolved to.
    const execute = run([
      'execute',
      file,
      '--run-id',
      id,
      '--input',
      'null',
      '--grant',
      'exec',
      '--harness',
      'fixture:f.json',
    ]);
    assert.equal(execute.status, 75, execute.stderr);
    assert.deepEqual(execute.value.resumeCommand.slice(-2), ['--harness', `fixture:${fixture}`]);
    resumeCommands[id] = execute.value.resumeCommand;
    assert.equal(record(id).launch.policy.harness.kind, 'fixture');
    assert.equal(record(id).launch.policy.harness.fixtures[0].path, fixture);
  }

  // workflow tick --run ID continues the fixture run to completion, and reports it exactly once.
  await untilDue('ticked');
  const ticked = run(['tick', '--run', 'ticked']);
  assert.equal(ticked.status, 0, ticked.stderr);
  assert.deepEqual(ticked.value.resumed, [{ runId: 'ticked', outcome: 'completed' }]);
  assert.deepEqual(ticked.value.skipped, []);
  assert.equal(record('ticked').status, 'completed');
  assert.equal(record('ticked').harness.kind, 'fixture');

  // The emitted resumeCommand runs verbatim from another directory.
  await untilDue('emitted');
  const argv = resumeCommands['emitted'];
  const resumed = check(
    spawnSync(argv[0], argv.slice(1), { cwd: elsewhere, encoding: 'utf8', timeout: 60_000, env }),
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(record('emitted').status, 'completed');

  // A plain resume without --harness keeps the recorded fixture.
  await untilDue('plain');
  const plain = run(['resume', 'plain']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.value.status, 'completed');
  assert.equal(plain.value.output, 'fixed');
  console.log('launch policy CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// A failure document, rootCause and the inspect summaries carry the classified error kind and
// whether it is transient (#275). Zero cost: the configured claude is the repository's fake replay
// binary, and PATH resolves a default `claude` or `codex` to a bomb that fails the smoke if
// anything launches it, so nothing reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-error-kind-cli-'));
const state = join(root, 'state');
const bin = join(root, 'bin');
const forbidden = join(root, 'default-binary-ran');
const fake = join(project, 'test/bin/fake-claude.mjs');
const harnessConfig = JSON.stringify({ claudeBinary: fake });

function run(args, scenario = 'claude-text-success') {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', state, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
        XDG_STATE_HOME: join(root, 'xdg'),
        QUIET_CHOIR_FAKE_SCENARIO: scenario,
      },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(existsSync(forbidden), false, 'A default harness binary was launched.');
  return { status: result.status, stderr: result.stderr, value: JSON.parse(result.stdout) };
}
function text(args) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', state],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, XDG_STATE_HOME: join(root, 'xdg') },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const runJson = (id) => join(state, id, 'run.json');
const record = (id) => JSON.parse(readFileSync(runJson(id), 'utf8'));

function execute(file, id, scenario) {
  return run(
    ['execute', file, '--run-id', id, '--input', 'null', '--harness-config', harnessConfig],
    scenario,
  );
}

try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    const bomb = join(bin, name);
    writeFileSync(
      bomb,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'bad'); process.exit(99);`,
    );
    chmodSync(bomb, 0o700);
  }
  const header = `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};`;
  const agent = join(root, 'agent.workflow.ts');
  writeFileSync(
    agent,
    `${header}
export default defineWorkflow({ name: 'error-kind-agent', version: '1', input: z.null(), output: z.string(),
  strictProfiles: false,
  async run(ctx) {
    await ctx.exec('probe', [${JSON.stringify(process.execPath)}, '-e', '0']);
    return (await ctx.claude.text('call', { prompt: 'hi' })).output;
  } });
`,
  );
  const body = join(root, 'body.workflow.ts');
  writeFileSync(
    body,
    `${header}
export default defineWorkflow({ name: 'error-kind-body', version: '1', input: z.null(), output: z.string(),
  run() { throw new Error('body bug'); } });
`,
  );

  // An authentication failure is not retryable; the kind reaches every surface.
  const auth = execute(agent, 'auth', 'claude-auth');
  assert.equal(auth.status, 1, auth.stderr);
  assert.equal(auth.value.error.code, 'workflow.failed');
  assert.equal(auth.value.failedSteps.length, 1);
  assert.deepEqual(auth.value.failedSteps[0], {
    id: 'call',
    kind: 'agent',
    attempts: 1,
    error: auth.value.failedSteps[0].error,
    errorKind: 'authentication',
    retryable: false,
  });
  assert.deepEqual(auth.value.error.details, { errorKind: 'authentication', retryable: false });
  assert.deepEqual(auth.value.summary.rootCause, {
    stepId: 'call',
    error: auth.value.failedSteps[0].error,
    errorKind: 'authentication',
  });
  assert.equal(record('auth').rootCause.errorKind, 'authentication');

  const summary = run(['inspect', 'auth', '--summary']);
  assert.equal(summary.status, 0, summary.stderr);
  const rows = Object.fromEntries(summary.value.steps.map((step) => [step.id, step.errorKind]));
  assert.deepEqual(rows, { probe: null, call: 'authentication' });
  assert.equal(summary.value.rootCause.errorKind, 'authentication');
  const view = text(['inspect', 'auth']);
  assert.match(view, /^failed call .*\[authentication\] \[root cause\]/mu);
  assert.match(view, /^Root cause \(call, authentication\): /mu);

  // A synthetic HTTP 529 is overloaded, which is transient.
  const busy = execute(agent, 'busy', 'claude-overloaded-529');
  assert.equal(busy.status, 1, busy.stderr);
  assert.equal(busy.value.error.code, 'workflow.failed');
  assert.deepEqual(
    {
      errorKind: busy.value.failedSteps[0].errorKind,
      retryable: busy.value.failedSteps[0].retryable,
    },
    { errorKind: 'overloaded', retryable: true },
  );
  assert.deepEqual(busy.value.error.details, { errorKind: 'overloaded', retryable: true });
  assert.equal(busy.value.summary.rootCause.errorKind, 'overloaded');

  // A local body failure has no kind and is not retryable.
  const bug = execute(body, 'bug');
  assert.equal(bug.status, 1, bug.stderr);
  assert.equal(bug.value.error.code, 'workflow.failed');
  assert.deepEqual(bug.value.failedSteps, []);
  assert.deepEqual(bug.value.error.details, { errorKind: null, retryable: false });
  assert.equal(bug.value.summary.rootCause.stepId, null);
  assert.equal(bug.value.summary.rootCause.errorKind, null);
  assert.equal(record('bug').rootCause.errorKind, null);
  assert.match(text(['inspect', 'bug']), /^Root cause \(workflow\): body bug/mu);

  // A record from before the field existed still loads, inspects and resumes; the summaries fall
  // back to the root step's last attempt and the stored record keeps no kind.
  const legacy = record('auth');
  assert.ok('errorKind' in legacy.rootCause);
  delete legacy.rootCause.errorKind;
  writeFileSync(runJson('auth'), JSON.stringify(legacy));
  const old = run(['inspect', 'auth', '--summary']);
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.value.rootCause.errorKind, 'authentication');
  assert.equal(old.value.steps.find((step) => step.id === 'call').errorKind, 'authentication');
  const resumed = run(['resume', 'auth', '--harness-config', harnessConfig], 'claude-auth');
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.equal(resumed.value.error.code, 'workflow.failed');
  assert.deepEqual(resumed.value.error.details, { errorKind: 'authentication', retryable: false });
  assert.equal(record('auth').rootCause.errorKind, 'authentication');
  console.log('error kind CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

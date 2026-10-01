// A run records a digest of its CLI harness configuration; resume and tick refuse a different one
// (omitted means the default) unless --allow-harness-config-change accepts it. Zero cost: the
// configured claude is the repository's fake replay binary, and PATH resolves a default `claude`
// or `codex` to a bomb that fails the smoke if anything launches it.
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
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-harness-config-cli-'));
const file = join(root, 'workflow.ts');
const state = join(root, 'state');
const bin = join(root, 'bin');
const forbidden = join(root, 'default-binary-ran');
const calls = join(root, 'calls.jsonl');
const fake = join(project, 'test/bin/fake-claude.mjs');
const other = join(root, 'other-claude.mjs');
const sleepMs = 1_500;

function run(args) {
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
        QUIET_CHOIR_FAKE_SCENARIO: 'claude-text-success',
        QUIET_CHOIR_FAKE_LOG: calls,
      },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(existsSync(forbidden), false, 'A default harness binary was launched.');
  return { status: result.status, stderr: result.stderr, value: JSON.parse(result.stdout) };
}
const record = (id) => JSON.parse(readFileSync(join(state, id, 'run.json'), 'utf8'));
const checkpoint = (id) =>
  ['run.json', 'journal.jsonl'].map((name) => {
    const path = join(state, id, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
const config = (claudeBinary) => JSON.stringify({ claudeBinary });
const callCount = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0;

try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  symlinkSync(fake, other);
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    const bomb = join(bin, name);
    writeFileSync(
      bomb,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'bad'); process.exit(99);`,
    );
    chmodSync(bomb, 0o700);
  }
  writeFileSync(
    file,
    `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({ name: 'harness-config-cli', version: '1', input: z.null(), output: z.string(),
  strictProfiles: false,
  async run(ctx) {
    await ctx.sleep('timer', ${String(sleepMs)});
    return (await ctx.claude.text('call', { prompt: 'hi' })).output;
  } });
`,
  );
  const started = Date.now();
  for (const id of ['resumed', 'ticked']) {
    const execute = run([
      'execute',
      file,
      '--run-id',
      id,
      '--input',
      'null',
      '--grant',
      'exec',
      '--harness-config',
      config(fake),
    ]);
    assert.equal(execute.status, 75, execute.stderr);
    assert.match(record(id).harness.configDigest, /^[a-f0-9]{64}$/u);
  }
  const digest = record('resumed').harness.configDigest;
  assert.equal(record('ticked').harness.configDigest, digest);

  // Resume without --harness-config means the default configuration: refused, nothing written.
  const before = checkpoint('resumed');
  const refused = run(['resume', 'resumed']);
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(refused.value.error.code, 'run.incompatible');
  assert.equal(refused.value.error.details.previousConfigDigest, digest);
  assert.match(refused.value.error.message, /--allow-harness-config-change/u);
  assert.deepEqual(checkpoint('resumed'), before);

  await delay(Math.max(0, started + sleepMs + 200 - Date.now()));
  const ticked = checkpoint('ticked');
  const tickRefused = run(['tick', '--run', 'ticked']);
  assert.equal(tickRefused.status, 1, tickRefused.stderr);
  assert.equal(tickRefused.value.resumed[0].outcome, 'incompatible');
  const tickChanged = run(['tick', '--run', 'ticked', '--harness-config', config(other)]);
  assert.equal(tickChanged.status, 1, tickChanged.stderr);
  assert.equal(tickChanged.value.resumed[0].outcome, 'incompatible');
  assert.deepEqual(checkpoint('ticked'), ticked);
  assert.equal(callCount(), 0);

  // The original configuration resumes; another one needs the explicit override.
  const same = run(['tick', '--run', 'ticked', '--harness-config', config(fake)]);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.value.resumed[0].outcome, 'completed');
  assert.equal(record('ticked').harness.configDigest, digest);
  const accepted = run([
    'resume',
    'resumed',
    '--harness-config',
    config(other),
    '--allow-harness-config-change',
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.value.status, 'completed');
  const changed = record('resumed').harness.configDigest;
  assert.match(changed, /^[a-f0-9]{64}$/u);
  assert.notEqual(changed, digest);
  assert.equal(callCount(), 2);
  console.log('harness config CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

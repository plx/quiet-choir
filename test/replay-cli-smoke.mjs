import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-replay-cli-'));
const state = join(root, 'state');
const file = join(root, 'workflow.ts');
const calls = join(root, 'calls.txt');
const effects = join(root, 'effects.txt');
function cli(...args) {
  return spawnSync(process.execPath, [join(repository, 'bin/run.js'), 'workflow', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      QC_REPLAY_CALLS: calls,
    },
  });
}
function run(id, ...args) {
  const result = cli('execute', file, '--state-dir', state, '--run-id', id, '--json', ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function source(
  review = 'review',
  tail = 'return value;',
  callback = `() => { appendFileSync(${JSON.stringify(effects)}, 'local\\n'); return 'done'; }`,
) {
  return `import { appendFileSync } from 'node:fs';
import { defineWorkflow, z } from 'quiet-choir';
export default defineWorkflow({ name: 'cli-replay', version: '1', input: z.object({}), output: z.string(), async run(ctx) {
  for (const prompt of ['plan', ${JSON.stringify(review)}, 'write']) await ctx.claude.text(prompt === 'changed' ? 'review' : prompt, { prompt });
  const value = await ctx.step('local', { input: null, schema: z.string(), run: ${callback} });
  ${tail}
}});`;
}
try {
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(repository, join(root, 'node_modules/quiet-choir'));
  symlinkSync(join(repository, 'node_modules/@types'), join(root, 'node_modules/@types'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(root, 'bin/claude'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => { appendFileSync(process.env.QC_REPLAY_CALLS, prompt + '\\n'); console.log(JSON.stringify({type:'result', subtype:'success', result:'ok', is_error:false})); });
`,
    { mode: 0o700 },
  );
  writeFileSync(file, source());
  const validation = cli('validate', file, '--json');
  assert.equal(validation.status, 0, validation.stderr);
  const metadata = JSON.parse(validation.stdout).workflow;
  assert.deepEqual(Object.keys(metadata.identity.files), ['workflow.ts']); // Linked dist declarations excluded.
  const original = run('source');
  assert.equal(original.workflow.fingerprint, metadata.fingerprint);
  const before = readFileSync(join(state, 'source.json'), 'utf8');
  writeFileSync(file, source('changed'));
  const prefix = run('prefix', '--fork-from', 'source');
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
    'plan',
    'review',
    'write',
    'changed',
    'write',
  ]);
  assert.equal(prefix.steps.plan.reusedFrom.runId, 'source');
  assert.equal(prefix.steps.local.reusedFrom, undefined);
  const count = readFileSync(calls, 'utf8').trim().split('\n').length;
  const matching = run(
    'matching',
    '--fork-from',
    'source',
    '--reuse',
    'matching',
    '--invalidate',
    'write',
  );
  assert.equal(matching.forkedFrom.reuse, 'matching');
  assert.deepEqual(matching.forkedFrom.invalidate, ['write']);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').slice(count), [
    'changed',
    'write',
  ]);
  assert.equal(matching.steps.local.reusedFrom.runId, 'source');
  assert.equal(readFileSync(join(state, 'source.json'), 'utf8'), before);

  const report = cli('check-resume', file, '--run-id', 'source', '--state-dir', state, '--json');
  assert.equal(report.status, 1, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).check.files, ['workflow.ts']);
  assert.equal(readFileSync(join(state, 'source.json'), 'utf8'), before);
  const failedResume = cli('execute', file, '--run-id', 'source', '--state-dir', state, '--resume');
  assert.equal(failedResume.status, 1);
  assert.match(failedResume.stderr, /workflow\.ts/);

  // A tail-only edit can re-finalize a failed run without repeating any effect.
  writeFileSync(file, source('review', 'return undefined as unknown as string;'));
  const tail = cli('execute', file, '--run-id', 'tail', '--state-dir', state);
  assert.equal(tail.status, 1);
  assert.match(tail.stderr, /All recorded effects completed/);
  const callsBefore = readFileSync(calls, 'utf8');
  const effectsBefore = readFileSync(effects, 'utf8');
  writeFileSync(file, source('review', 'return `${value}-fixed`;'));
  const acceptedCheck = cli(
    'check-resume',
    file,
    '--run-id',
    'tail',
    '--state-dir',
    state,
    '--accept-code-change',
    '--json',
  );
  assert.equal(acceptedCheck.status, 0, acceptedCheck.stderr);
  assert.equal(JSON.parse(acceptedCheck.stdout).check.refinalizable, true);
  const finalized = run('tail', '--resume', '--accept-code-change');
  assert.equal(finalized.output, 'done-fixed');
  assert.deepEqual(finalized.codeChanges[0].files, ['workflow.ts']);
  assert.equal(readFileSync(calls, 'utf8'), callsBefore);
  assert.equal(readFileSync(effects, 'utf8'), effectsBefore);
  const inspect = cli('inspect', 'tail', '--state-dir', state, '--json');
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout).codeChanges, finalized.codeChanges);

  const alias = join(root, 'alias');
  symlinkSync(root, alias);
  const normal = cli('validate', file, '--json');
  const aliased = cli('validate', join(alias, 'workflow.ts'), '--json');
  assert.equal(aliased.status, 0, aliased.stderr);
  assert.equal(
    JSON.parse(normal.stdout).workflow.fingerprint,
    JSON.parse(aliased.stdout).workflow.fingerprint,
  );
  appendFileSync(file, '\n// comment-only edit\n');
  const comment = run('comment', '--fork-from', 'tail');
  assert.equal(comment.steps.local.reusedFrom.runId, 'tail');
  assert.equal(readFileSync(calls, 'utf8'), callsBefore);
  assert.equal(readFileSync(effects, 'utf8'), effectsBefore);
  console.log(
    'PASS CLI fork prefix/matching/invalidation, immutable source, canonical hash, check-resume, and zero-effect re-finalization',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

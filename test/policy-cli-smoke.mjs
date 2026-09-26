import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-policy-cli-'));
const state = join(fixture, 'state');
const file = join(fixture, 'recovery.ts');
const calls = join(fixture, 'calls.jsonl');
function cli(...args) {
  return spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(fixture, 'bin')}:${process.env.PATH}`,
      QC_POLICY_CALLS: calls,
    },
  });
}
try {
  mkdirSync(join(fixture, 'bin'));
  mkdirSync(join(fixture, 'node_modules'));
  symlinkSync(root, join(fixture, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(fixture, 'node_modules/@types'));
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(fixture, 'bin/claude'),
    `#!/usr/bin/env node
import fs from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.QC_POLICY_CALLS, JSON.stringify({prompt, args: process.argv.slice(2)}) + '\\n');
  setTimeout(() => console.log(JSON.stringify({type:'result', subtype:'success', result:'ok', is_error:false})), prompt === 'review' ? 1500 : 0);
});
`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';
import { defineWorkflow, z } from 'quiet-choir';
export default defineWorkflow({ name: 'policy-cli', version: '1', input: z.object({}), output: z.string(), async run(ctx) {
  await ctx.claude.text('plan', { prompt: 'plan' });
  const review = await ctx.claude.text('review', { prompt: 'review', timeoutMs: 1000 });
  return ctx.step('write', { input: review.output, schema: z.string(), run() { appendFileSync('writes.txt', 'write\\n'); return 'done'; } });
}});
`,
  );
  const args = ['execute', file, '--run-id', 'recovery', '--state-dir', state];
  const first = cli(...args);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /1000ms deadline/);
  const initial = JSON.parse(readFileSync(join(state, 'recovery.json'), 'utf8'));
  assert.equal(initial.steps.plan.status, 'completed');
  assert.equal(initial.steps.review.status, 'failed');
  const resume = cli(
    ...args,
    '--resume',
    '--policy',
    '{"match":"review","timeoutMs":600000}',
    '--json',
  );
  assert.equal(resume.status, 0, resume.stderr);
  const result = JSON.parse(resume.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.plan.attempts, 1);
  assert.equal(result.steps.review.attempts, 2);
  assert.equal(result.steps.write.attempts, 1);
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    invocations.map((call) => call.prompt),
    ['plan', 'review', 'review'],
  );
  const inspect = cli('inspect', 'recovery', '--state-dir', state, '--json');
  assert.equal(inspect.status, 0, inspect.stderr);
  const saved = JSON.parse(inspect.stdout);
  const attempts = saved.steps.review.attemptHistory;
  assert.equal(attempts[0].policy.timeoutMs, 1000);
  assert.equal(attempts[0].sources.timeoutMs, 'call-site');
  assert.equal(attempts[1].policy.timeoutMs, 600000);
  assert.equal(attempts[1].sources.timeoutMs, 'override:0');
  assert.equal(attempts[1].policy.maxTurns, 25);
  assert.equal(attempts[1].sources.maxTurns, 'harness');
  assert.equal(attempts[1].policy.maxBudgetUsd, 0.25);
  assert.equal(attempts[1].policy.binary, 'claude');
  assert.deepEqual(saved.policy, [{ match: 'review', timeoutMs: 600000 }]);
  const bare = cli(...args, '--resume', '--json');
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(JSON.parse(bare.stdout).policy, saved.policy);
  assert.equal(readFileSync(join(fixture, 'writes.txt'), 'utf8'), 'write\n');
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  const unauthorized = cli(...args, '--resume', '--policy', '{"model":"new"}');
  assert.equal(unauthorized.status, 2, unauthorized.stderr);
  assert.match(unauthorized.stderr, /allow-model-override/);
  const allowed = cli(
    ...args,
    '--resume',
    '--policy',
    '{"model":"new"}',
    '--allow-model-override',
    '--json',
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).allowModelOverride, true);
  const authorizedBare = cli(...args, '--resume', '--json');
  assert.equal(authorizedBare.status, 0, authorizedBare.stderr);
  assert.equal(JSON.parse(authorizedBare.stdout).allowModelOverride, true);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  const reset = cli(...args, '--resume', '--policy-reset', '--json');
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(JSON.parse(reset.stdout).policy, []);
  const ordered = cli(
    ...args,
    '--resume',
    '--policy',
    '{"timeoutMs":100}',
    '--policy',
    '{"match":"review","timeoutMs":200}',
    '--json',
  );
  assert.equal(ordered.status, 0, ordered.stderr);
  assert.deepEqual(JSON.parse(ordered.stdout).policy, [
    { timeoutMs: 100 },
    { match: 'review', timeoutMs: 200 },
  ]);
  const invalid = cli(...args, '--resume', '--policy', '{"timeoutMs":0}');
  assert.equal(invalid.status, 2, invalid.stderr);
  console.log(
    'PASS CLI timeout recovery, saved attempt policy, sticky resume, model authorization, and reset',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

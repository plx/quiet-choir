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
      QC_REPLAY_EFFECTS: effects,
    },
  });
}
function run(id, ...args) {
  const result = cli(
    'execute',
    file,
    '--state-dir',
    state,
    '--run-id',
    id,
    '--json',
    '--full',
    ...args,
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function source(
  review = 'review',
  tail = 'return value;',
  callback = `() => { appendFileSync(String(process.env.QC_REPLAY_EFFECTS), 'local\\n'); return 'done'; }`,
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
if (process.argv.includes("--version")) { console.log("2.1.283"); process.exit(0); }
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
  const before = readFileSync(join(state, 'source', 'run.json'), 'utf8');
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
  assert.equal(readFileSync(join(state, 'source', 'run.json'), 'utf8'), before);

  const report = cli('check-resume', file, '--run-id', 'source', '--state-dir', state, '--json');
  assert.equal(report.status, 3, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).error.details.files, ['workflow.ts']);
  assert.equal(readFileSync(join(state, 'source', 'run.json'), 'utf8'), before);
  const failedResume = cli('execute', file, '--run-id', 'source', '--state-dir', state, '--resume');
  assert.equal(failedResume.status, 3);
  assert.match(failedResume.stderr, /workflow\.ts/);

  // A tail-only edit can re-finalize a failed run without repeating any effect.
  writeFileSync(file, source('review', 'return undefined as unknown as string;'));
  const tail = cli('execute', file, '--run-id', 'tail', '--state-dir', state);
  assert.equal(tail.status, 1);
  assert.match(tail.stderr, /All recorded work has terminal outcomes/);
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

  // An edited completed callback cannot be accepted: the preflight refuses before any write.
  const tailBytes = readFileSync(join(state, 'tail', 'run.json'), 'utf8');
  writeFileSync(
    file,
    source(
      'review',
      'return `${value}-fixed`;',
      `() => { appendFileSync(String(process.env.QC_REPLAY_EFFECTS), 'edited\\n'); return 'done'; }`,
    ),
  );
  const divergent = cli(
    'execute',
    file,
    '--run-id',
    'tail',
    '--state-dir',
    state,
    '--resume',
    '--accept-code-change',
    '--json',
  );
  assert.equal(divergent.status, 3, divergent.stderr);
  const refusal = JSON.parse(divergent.stdout).error;
  assert.equal(refusal.code, 'run.incompatible');
  assert.deepEqual(refusal.details.divergent, [{ stepId: 'local', components: ['callback'] }]);
  assert(refusal.details.next[0].includes('--fork-from'));
  assert.match(refusal.message, /--fork-from tail --reuse matching --invalidate local/u);
  assert.equal(readFileSync(join(state, 'tail', 'run.json'), 'utf8'), tailBytes);
  assert.equal(readFileSync(calls, 'utf8'), callsBefore);
  assert.equal(readFileSync(effects, 'utf8'), effectsBefore);
  writeFileSync(file, source('review', 'return `${value}-fixed`;'));

  // #217: the preflight consumes a delivered but unconsumed answer on its copy, so an edited
  // completed step moved after the question is still refused before any write.
  const asked = join(root, 'asked.ts');
  const askedEffects = join(root, 'asked-effects.txt');
  const askedSource = (moved) => `import { appendFileSync } from 'node:fs';
import { defineWorkflow, z } from 'quiet-choir';
const local = { input: null, schema: z.string(), run: () => { appendFileSync(${JSON.stringify(askedEffects)}, '${moved ? 'moved' : 'asked'}\\n'); return 's'; } };
export default defineWorkflow({ name: 'cli-asked', version: '1', input: z.object({}), output: z.string(), async run(ctx) {
  ${moved ? '' : "await ctx.step('s', local);"}
  const answer = await ctx.ask('q', { prompt: 'Text?', schema: z.string() });
  ${moved ? "await ctx.step('s', local);" : ''}
  return answer;
}});`;
  writeFileSync(asked, askedSource(false));
  const suspended = cli('execute', asked, '--state-dir', state, '--run-id', 'asked', '--json');
  assert.equal(suspended.status, 75, suspended.stderr);
  const answered = cli('answer', 'asked', 'q', '--json', '"yes"', '--state-dir', state);
  assert.equal(answered.status, 0, answered.stderr);
  const askedBytes = readFileSync(join(state, 'asked', 'run.json'), 'utf8');
  const delivery = JSON.parse(answered.stdout).delivery.path;
  const deliveryBytes = readFileSync(delivery, 'utf8');
  writeFileSync(asked, askedSource(true));
  const moved = cli(
    'execute',
    asked,
    '--run-id',
    'asked',
    '--state-dir',
    state,
    '--resume',
    '--accept-code-change',
    '--json',
  );
  assert.equal(moved.status, 3, moved.stderr);
  const movedRefusal = JSON.parse(moved.stdout).error;
  assert.equal(movedRefusal.code, 'run.incompatible');
  assert.deepEqual(movedRefusal.details.divergent, [{ stepId: 's', components: ['callback'] }]);
  assert(movedRefusal.details.next[0].includes('--fork-from'));
  assert.equal(readFileSync(join(state, 'asked', 'run.json'), 'utf8'), askedBytes);
  assert.equal(readFileSync(delivery, 'utf8'), deliveryBytes);
  assert.equal(readFileSync(askedEffects, 'utf8'), 'asked\n');

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

  // A Promise.all sibling launched with a failing step does not depend on its failure, so
  // `workflow resume --strict-replay` heals the step and completes.
  const help = cli('resume', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--strict-replay/u);
  const fanIn = join(root, 'fan-in.ts');
  writeFileSync(
    fanIn,
    `import { existsSync } from 'node:fs';
import { defineWorkflow, z } from 'quiet-choir';
const local = (id: string) => ({ input: null, schema: z.string(), run: () => {
  if (id === 'impl' && !existsSync('healed')) throw new Error('impl failed');
  return id;
} });
export default defineWorkflow({ name: 'fan-in', version: '1', input: z.object({}), output: z.string(), async run(ctx) {
  const [impl] = await Promise.all([ctx.step('impl', local('impl')), ctx.step('followups', local('followups'))]);
  return impl + (await ctx.step('ship', local('ship')));
}});`,
  );
  const broken = cli('execute', fanIn, '--state-dir', state, '--run-id', 'fan-in');
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /impl failed/u);
  writeFileSync(join(root, 'healed'), '');
  const strict = cli('resume', 'fan-in', '--state-dir', state, '--strict-replay', '--json');
  assert.equal(strict.status, 0, strict.stderr);
  const healed = JSON.parse(strict.stdout);
  assert.equal(healed.status, 'completed', strict.stdout);
  assert.equal(healed.output, 'implship');
  assert.deepEqual(healed.warnings, []);
  console.log(
    'PASS CLI fork prefix/matching/invalidation, immutable source, canonical hash, check-resume, zero-effect re-finalization, divergent accept refusals (also past a delivered answer), and strict workflow resume after a healed fan-in',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

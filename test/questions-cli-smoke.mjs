import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-questions-cli-'));
const stateDir = join(root, 'state');
const file = join(root, 'questions.mts');
const calls = join(root, 'effects.jsonl');
const imported = join(root, 'imported');
const cli = (...args) =>
  spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', stateDir],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
const source = `import { defineWorkflow,z } from ${JSON.stringify(join(project, 'dist/index.js'))};
import { appendFileSync,writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(imported)},'imported');
export default defineWorkflow({name:'questions',version:'1',input:z.object({}),output:z.object({approved:z.boolean()}),async run(ctx){
  await ctx.step('plan',{input:null,schema:z.string(),run:()=>{appendFileSync(${JSON.stringify(calls)},'plan\\n');return 'plan A';}});
  const answer = await ctx.approve('approve',{prompt:'Apply plan A?',subject:{revision:'A'},audience:'human'});
  if(answer.approved) await ctx.step('apply',{input:null,schema:z.null(),run:()=>{appendFileSync(${JSON.stringify(calls)},'apply\\n');return null;}});
  return {approved:answer.approved};
}});`;
try {
  writeFileSync(file, source);
  const executed = cli('execute', file, '--run-id', 'gate', '--json');
  assert.equal(executed.status, 75, executed.stderr);
  const suspended = JSON.parse(executed.stdout);
  assert.equal(suspended.kind, 'workflow.run.suspended');
  assert.equal(suspended.runId, 'gate');
  assert.equal(suspended.pending[0].stepId, 'approve');
  assert.equal(suspended.pending[0].codeChanged, false);
  assert.equal(suspended.run.launch.entrypoint, realpathSync(file));
  assert.equal(suspended.run.launch.tsconfig, null);
  assert.equal(existsSync(join(stateDir, 'gate', 'lock')), false);
  assert.equal(readFileSync(calls, 'utf8'), 'plan\n');
  rmSync(imported);
  writeFileSync(file, 'this is deliberately invalid TypeScript');
  const pending = cli('pending', '--json');
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).pending[0].codeChanged, true);
  assert.equal(existsSync(imported), false);
  const invalid = cli(
    'answer',
    'gate',
    'approve',
    '--json',
    '{"approved":"yes"}',
    '--by',
    'human:Pat',
  );
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'answer.invalid');
  assert.equal(existsSync(join(stateDir, 'gate', 'inbox')), false);
  const guard = cli('answer', 'gate', 'approve', '--json', '{"approved":true}');
  assert.equal(guard.status, 2, guard.stderr);
  const answered = cli(
    'answer',
    'gate',
    'approve',
    '--json={"approved":true}',
    '--by',
    'human:Pat',
  );
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(JSON.parse(answered.stdout).kind, 'workflow.answer.result');
  assert.equal(existsSync(imported), false);
  const duplicate = cli(
    'answer',
    'gate',
    'approve',
    '--json',
    '{"approved":false}',
    '--by',
    'human:Pat',
  );
  assert.equal(duplicate.status, 3, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).error.code, 'answer.conflict');
  writeFileSync(file, source);
  const resumed = cli('resume', 'gate', '--json');
  assert.equal(resumed.status, 0, resumed.stderr);
  const completed = JSON.parse(resumed.stdout);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output, { approved: true });
  assert.ok(Object.values(completed.steps).every((step) => step.attempts === 1));
  assert.equal(readFileSync(calls, 'utf8'), 'plan\napply\n');
  assert.deepEqual(JSON.parse(cli('pending', '--json').stdout).pending, []);
  assert.equal(cli('execute', file, '--run-id', 'answer-resume', '--json').status, 75);
  const combined = cli(
    'answer',
    'answer-resume',
    'approve',
    '--json',
    '{"approved":false}',
    '--by',
    'human:Pat',
    '--resume',
  );
  assert.equal(combined.status, 0, combined.stderr);
  assert.deepEqual(JSON.parse(combined.stdout).output, { approved: false });
  assert.equal(cli('resume', 'missing', '--json').status, 3);
  const preview = cli('execute', file, '--run-id', 'preview', '--dry-run', '--json');
  assert.equal(preview.status, 75, preview.stderr);
  const previewResult = JSON.parse(preview.stdout);
  assert.equal(previewResult.rehearsal.kind, 'workflow.rehearsal');
  assert.equal(previewResult.pending[0].answerCommand, null);
  assert.equal(previewResult.resumeCommand, null);
  assert.ok(
    previewResult.rehearsal.warnings.some((warning) => warning.includes('unanswered question')),
  );
  assert.equal(previewResult.stateDir, null);
  assert.equal(existsSync(join(stateDir, 'preview', 'run.json')), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

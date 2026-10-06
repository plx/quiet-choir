import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compact `--json` results of execute, resume and answer --resume, with the full record behind
// --full, through the built CLI with stdout as a pipe.
const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-run-result-cli-'));
const stateDir = join(root, 'state');
const file = join(root, 'many.mts');
const fixtures = join(root, 'fixtures.json');
const harness = `fixture:${fixtures}`;
// answer takes its JSON output request from `--json VALUE`, so only the other commands get one added.
const cli = (...args) =>
  spawnSync(
    process.execPath,
    [
      join(project, 'bin/run.js'),
      'workflow',
      ...args,
      '--state-dir',
      stateDir,
      ...(args[0] === 'answer' ? [] : ['--json']),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, XDG_STATE_HOME: join(root, 'xdg') },
    },
  );
const bytes = (result) => Buffer.byteLength(result.stdout);
const document = (result, status) => {
  assert.equal(result.status, status, `${result.stderr}\n${result.stdout.slice(0, 500)}`);
  assert.equal(result.stdout.trim().split('\n').length, 1, 'exactly one JSON document');
  return JSON.parse(result.stdout);
};
const execute = (runId, calls, ...flags) =>
  cli(
    'execute',
    file,
    '--run-id',
    runId,
    '--harness',
    harness,
    '--input',
    JSON.stringify({ calls }),
    ...flags,
  );

try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    fixtures,
    JSON.stringify({
      version: 1,
      calls: [
        {
          step: 'call-*',
          output: { text: 'y'.repeat(300) },
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        },
      ],
    }),
  );
  writeFileSync(
    file,
    `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({name:'many',version:'1',input:z.object({calls:z.number()}),output:z.object({approved:z.boolean().nullable(),calls:z.number()}),async run(ctx,input){
  for (let index = 0; index < input.calls; index++)
    await ctx.claude.value('call-' + String(index), { prompt: 'p' + String(index), schema: z.object({ text: z.string() }) });
  if (input.calls === 60) {
    const answer = await ctx.approve('gate', { prompt: 'Go on?', subject: null, audience: 'human' });
    return { approved: answer.approved, calls: input.calls };
  }
  return { approved: null, calls: input.calls };
}});`,
  );

  // A 180-call run: the default document is small, --full is the record, the outputs agree.
  const compact = execute('big', 180);
  const result = document(compact, 0);
  assert.ok(bytes(compact) < 8192, `compact result is ${String(bytes(compact))} bytes`);
  assert.equal(result.kind, 'workflow.run.result');
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.runId, 'big');
  assert.equal(result.status, 'completed');
  assert.equal(result.counts.total, 180);
  assert.equal(result.usage.attempts, 180);
  assert.equal(result.usage.undercounted, false);
  assert.ok(Math.abs(result.usage.costUsd - 0.18) < 1e-9, String(result.usage.costUsd));
  assert.equal(result.rootCause, null);
  assert.equal(Object.hasOwn(result, 'run'), false);
  assert.equal(Object.hasOwn(result, 'steps'), false);
  const fullRun = execute('big-full', 180, '--full');
  const full = document(fullRun, 0);
  assert.equal(Object.keys(full.steps).length, 180);
  assert.equal(full.id, 'big-full');
  assert.equal(typeof full.stateDir, 'string');
  assert.equal(Object.hasOwn(full, 'kind'), false);
  assert.ok(bytes(fullRun) > 20 * bytes(compact));
  assert.deepStrictEqual(result.output, full.output);

  // A suspension keeps its commands; the record returns under --full.
  const suspended = execute('gate', 60);
  const suspension = document(suspended, 75);
  assert.ok(bytes(suspended) < 8192, `suspension is ${String(bytes(suspended))} bytes`);
  assert.equal(suspension.kind, 'workflow.run.suspended');
  assert.equal(suspension.ok, true);
  assert.equal(suspension.exitCode, 75);
  assert.equal(suspension.runId, 'gate');
  assert.equal(suspension.summary.status, 'suspended');
  assert.equal(suspension.summary.counts.total, 61);
  assert.ok(Array.isArray(suspension.pending[0].answerCommand));
  assert.deepStrictEqual(suspension.pending[0].answerCommand.slice(-4), [
    '--json',
    '<ANSWER_JSON>',
    '--by',
    'human:<NAME>',
  ]);
  assert.ok(Array.isArray(suspension.resumeCommand));
  assert.equal(Object.hasOwn(suspension, 'run'), false);
  const suspendedFull = document(cli('resume', 'gate', '--harness', harness, '--full'), 75);
  assert.equal(suspendedFull.kind, 'workflow.run.suspended');
  assert.equal(suspendedFull.run.id, 'gate');
  assert.equal(Object.keys(suspendedFull.run.steps).length, 61);
  assert.ok(Array.isArray(suspendedFull.pending[0].answerCommand));
  assert.equal(Object.hasOwn(suspendedFull, 'summary'), false);

  // answer.invalid on a run with many steps: small by default, the run under --full.
  for (const value of ['{"approved":"yes"}', '{not json']) {
    const invalid = cli('answer', 'gate', 'gate', '--json', value, '--by', 'human:Pat');
    const failure = document(invalid, 2);
    assert.ok(bytes(invalid) < 4096, `answer.invalid is ${String(bytes(invalid))} bytes`);
    assert.equal(failure.kind, 'workflow.error');
    assert.equal(failure.error.code, 'answer.invalid');
    assert.equal(failure.summary.runId, 'gate');
    assert.equal(failure.summary.status, 'suspended');
    assert.equal(Object.hasOwn(failure, 'run'), false);
    const detailed = document(
      cli('answer', 'gate', 'gate', '--json', value, '--by', 'human:Pat', '--full'),
      2,
    );
    assert.equal(detailed.error.code, 'answer.invalid');
    assert.equal(detailed.run.id, 'gate');
    assert.equal(Object.hasOwn(detailed, 'summary'), false);
  }

  // answer --resume: the compact result carries stateDir; --full is the record plus stateDir.
  const answered = cli(
    'answer',
    'gate',
    'gate',
    '--json',
    '{"approved":true}',
    '--by',
    'human:Pat',
    '--resume',
    '--harness',
    harness,
  );
  const completed = document(answered, 0);
  assert.ok(bytes(answered) < 8192);
  assert.equal(completed.kind, 'workflow.run.result');
  assert.equal(completed.status, 'completed');
  assert.deepStrictEqual(completed.output, { approved: true, calls: 60 });
  assert.equal(typeof completed.stateDir, 'string');
  assert.equal(Object.hasOwn(completed, 'run'), false);
  document(execute('gate-full', 60), 75);
  const answeredFull = document(
    cli(
      'answer',
      'gate-full',
      'gate',
      '--json',
      '{"approved":true}',
      '--by',
      'human:Pat',
      '--resume',
      '--harness',
      harness,
      '--full',
    ),
    0,
  );
  assert.equal(answeredFull.id, 'gate-full');
  assert.equal(answeredFull.stateDir, completed.stateDir);
  assert.equal(Object.hasOwn(answeredFull, 'kind'), false);
  assert.equal(Object.keys(answeredFull.steps).length, 61);

  // The emitted human answerCommand is runnable once its placeholders are substituted: with only
  // <ANSWER_JSON> replaced it is refused as answer_author, and replacing <NAME> too delivers.
  const emitted = document(execute('gate-cmd', 60), 75).pending[0].answerCommand;
  const emittedRun = (replacements, ...extra) => {
    const [program, ...argv] = emitted.map((word) => replacements[word] ?? word);
    return spawnSync(program, [...argv, ...extra], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, XDG_STATE_HOME: join(root, 'xdg') },
    });
  };
  const approved = '{"approved":true}';
  const unnamed = document(emittedRun({ '<ANSWER_JSON>': approved }), 2);
  assert.equal(unnamed.error.code, 'answer.invalid');
  assert.match(JSON.stringify(unnamed.error), /answer_author/u);
  const named = document(
    emittedRun(
      { '<ANSWER_JSON>': approved, 'human:<NAME>': 'human:Pat' },
      '--resume',
      '--harness',
      harness,
    ),
    0,
  );
  assert.equal(named.status, 'completed');

  console.log(
    'Run result CLI: compact success, suspension and answer.invalid documents and --full passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

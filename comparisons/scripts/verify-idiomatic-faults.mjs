import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readRun } from 'quiet-choir';
import {
  command,
  drive,
  fixture,
  harnessFor,
  inputFor,
  load,
  lifecycle,
  names,
  project,
  runOptions,
  snapshot,
  pristine,
} from './idiomatic-fixtures.mjs';
import { verificationStage } from '../batches/02-idiomatic-ports/ported/lifecycle-stages.ts';

export async function killCase(root, batch, name) {
  const env = await fixture(root),
    marker = join(env.root, 'kill-marker');
  const config = join(env.root, 'worker.json');
  await writeFile(config, JSON.stringify({ ...env, processRunner: undefined, batch, name }));
  if (batch === 2 && name === 'test-gap-filler') {
    await writeFile(
      join(env.cwd, 'kill-check.mjs'),
      `import assert from 'node:assert/strict';\nimport {existsSync,writeFileSync} from 'node:fs';\nimport {value} from './target.mjs';\nif(value===0&&!existsSync(${JSON.stringify(join(env.root, 'resume-marker'))})){writeFileSync(${JSON.stringify(marker)},JSON.stringify({stepId:'mutants/zero/check',writeLocation:'source-checkout',boundary:'test running with mutated target'}));setInterval(()=>{},1000);}else assert.equal(value,1);\n`,
    );
    command(env.cwd, 'add', '.');
    command(
      env.cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'kill fixture',
    );
  }
  const worker = join(project, 'comparisons/scripts/idiomatic-kill-worker.mjs');
  const child = spawn(process.execPath, ['--import', 'tsx', worker, config], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 60_000;
    while (
      !existsSync(marker) &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    )
      await delay(20);
    assert.ok(
      existsSync(marker),
      `Worker did not reach its write boundary: ${output.slice(-3000)}`,
    );
    // The worker creates the marker before writing its JSON, so a poll can see it still empty.
    let text = await readFile(marker, 'utf8');
    while (text === '' && Date.now() < deadline) {
      await delay(20);
      text = await readFile(marker, 'utf8');
    }
    const point = JSON.parse(text);
    const filesystemAfterKill = await snapshot(env.cwd);
    if (batch === 2 && name === 'test-gap-filler') {
      assert.equal(filesystemAfterKill.targetPristine, false);
      child.kill('SIGKILL');
    }
    const exit = await exited;
    assert.equal(exit.signal, 'SIGKILL', output.slice(-3000));
    const beforeRecord = await readRun({ stateDir: env.stateDir, runId: 'kill-case' });
    assert.notEqual(
      beforeRecord.steps[point.stepId]?.status,
      'completed',
      'Kill must precede the terminal checkpoint',
    );
    const before = (await readFile(join(env.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    await writeFile(join(env.root, 'resume-marker'), 'resume');
    const resumed = spawnSync(process.execPath, ['--import', 'tsx', worker, config, '--resume'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(resumed.status, 0, (resumed.stderr + resumed.stdout).slice(-5000));
    const result = JSON.parse(await readFile(join(env.root, 'result.json'), 'utf8'));
    const calls = (await readFile(join(env.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const old = new Set(before.map((call) => call.stepId));
    const callsPaidAgain = calls.slice(before.length).filter((call) => old.has(call.stepId)).length;
    const completedCallsPaidAgain = calls
      .slice(before.length)
      .filter((call) => beforeRecord.steps[call.stepId]?.status === 'completed').length;
    const filesystem = await snapshot(env.cwd);
    assert.equal(completedCallsPaidAgain, 0);
    assert.equal(result.status, 'completed');
    if (batch === 2) assert.equal(filesystem.targetPristine, true);
    if (name === 'test-gap-filler') {
      assert.equal(filesystem.targetPristine, batch === 2);
      assert.equal(callsPaidAgain, batch === 2 ? 0 : 1);
    }
    return {
      initialStatus: 'SIGKILL',
      finalStatus: result.status,
      callsPaidAgain,
      completedCallsPaidAgain,
      filesystemAfterKill,
      filesystem,
      outputAdmitsDegradation: false,
      boundary: point.boundary,
      writeLocation: point.writeLocation,
      evidence:
        batch === 1
          ? 'Inert writer leaves partial bytes before kill, then returns its schema-valid success reply on retry. This measures lack of code reconciliation, not actual model behavior.'
          : 'Real filesystem write and actual SIGKILL before terminal checkpoint; resume with identity-checked orphan cleanup.',
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

const killSelf = "process.kill(process.pid, 'SIGKILL')";
const settledSteps = (run, pattern) =>
  Object.entries(run.steps)
    .filter(([id, step]) => pattern.test(id) && step.status === 'settled-failed')
    .map(([, step]) => step);

export async function extraContracts(root) {
  const results = [];
  for (const [name, mode] of [
    ['release-notes', 'missing-coverage'],
    ['test-gap-filler', 'no-gaps'],
    ['project-bootstrap', 'red-verify'],
    ['project-bootstrap', 'signal-verify'],
    ['test-gap-filler', 'baseline-signal'],
    ['test-gap-filler', 'baseline-timeout'],
    ['incident-investigation', 'dirty'],
    ['bug-hunt', 'failed-skeptic'],
    ['bug-hunt', 'failed-finders'],
    ['bug-hunt', 'call-cap'],
    ['sdlc-orchestrator', 'redo'],
    ['sdlc-orchestrator', 'full-lifecycle'],
  ]) {
    const env = await fixture(join(root, `${name}-${mode}`)),
      definition = await load(2, name);
    const { harness, calls } = harnessFor(2, name, env, { mode });
    const opts = runOptions(env, mode, harness, inputFor(2, name, env));
    if (mode === 'full-lifecycle') {
      opts.input.allowedStages = lifecycle;
      opts.input.since = env.since;
    }
    if (mode === 'call-cap') opts.input.maxCalls = 3;
    if (mode === 'baseline-signal') opts.input.testCommand = [process.execPath, '-e', killSelf];
    if (mode === 'baseline-timeout') {
      opts.input.testCommand = [process.execPath, '-e', 'setTimeout(() => {}, 60000)'];
      // Scoped to the baseline so git helper commands keep their default deadline.
      opts.policy = [{ kind: 'exec', match: 'baseline', timeoutMs: 1000 }];
    }
    if (mode === 'dirty') {
      await assert.rejects(drive(definition, opts), /Expected a clean repository/u);
      const failed = await readRun(opts);
      assert.equal(failed.status, 'failed');
      assert.equal(calls.length, 3);
      results.push({
        workflow: name,
        fixture: mode,
        status: 'passed',
        finalStatus: 'failed',
        agentCalls: calls.length,
      });
      continue;
    }
    const { result } = await drive(definition, opts, { redo: mode === 'redo' });
    if (mode === 'no-gaps') {
      assert.equal(result.output.status, 'no-gaps');
      assert.equal(calls.length, 2);
      assert.equal(existsSync(join(env.cwd, 'target.test.mjs')), false);
    }
    if (mode === 'missing-coverage') {
      assert.equal(result.output.status, 'needs-review');
      assert.deepEqual(result.output.missing, [env.until]);
    }
    if (mode === 'full-lifecycle') {
      assert.equal(result.output.status, 'complete');
      assert.equal(result.output.stages.length, 10);
      assert.equal(Object.keys(result.children).length, 10);
      assert.equal(command(env.cwd, 'status', '--porcelain'), '');
    }
    if (mode === 'call-cap') {
      assert.equal(result.output.status, 'call-limit');
      assert.equal(result.output.skippedSkeptics, 3);
      assert.equal(result.output.undecided, 1);
      assert.equal(calls.length, 3);
    }
    if (mode === 'red-verify') {
      assert.equal(result.output.status, 'verification-failed');
      assert.equal(result.output.verification[0].code, 7);
      assert.equal(result.output.verification[0].failure, 'process');
      assert.equal(existsSync(join(env.cwd, 'setup.txt')), false);
    }
    if (mode === 'signal-verify') {
      assert.equal(result.status, 'completed');
      assert.equal(result.output.status, 'verification-failed');
      assert.equal(result.output.verification[0].code, null);
      assert.equal(typeof result.output.verification[0].failure, 'string');
      assert.equal(existsSync(join(env.cwd, 'setup.txt')), false);
      const settled = settledSteps(await readRun(opts), /^verify/u);
      assert.equal(settled.length, 1);
      assert.equal(settled[0].settledError.kind, result.output.verification[0].failure);
      assert.equal(settled[0].settledError.signal, 'SIGKILL');
    }
    if (mode === 'baseline-signal' || mode === 'baseline-timeout') {
      assert.equal(result.status, 'completed');
      assert.equal(result.output.status, 'baseline-failed');
      assert.equal(result.output.baselineCode, null);
      assert.deepEqual(result.output.mutations, []);
      const baseline = (await readRun(opts)).steps['baseline'];
      assert.equal(baseline.status, 'settled-failed');
      if (mode === 'baseline-timeout') assert.equal(baseline.settledError.kind, 'timeout');
      else assert.equal(baseline.settledError.signal, 'SIGKILL');
    }
    if (mode === 'failed-skeptic') {
      assert.equal(result.output.undecided, 1);
      assert.equal(result.output.failedSkeptics, 1);
      assert.equal(result.output.status, 'degraded');
    }
    if (mode === 'failed-finders') {
      assert.equal(result.output.dryRounds, 0);
      assert.equal(result.output.failedFinders, 6);
      assert.equal(result.output.status, 'degraded');
    }
    if (mode === 'redo') {
      const redone = calls.filter((call) => call.call.stepId.startsWith('requirements/1/'));
      assert.equal(redone.length, 2);
      assert.ok(
        redone.every((call) => call.options.prompt.includes('HUMAN_STAGE_REQUIREMENTS_ONLY')),
      );
      assert.ok(
        calls
          .filter((call) => call.call.stepId.startsWith('spec/'))
          .every((call) => !call.options.prompt.includes('HUMAN_STAGE_REQUIREMENTS_ONLY')),
      );
      assert.equal(result.output.runId, opts.runId);
      assert.equal(Object.keys(result.children).length, 3);
    }
    const before = calls.length;
    await drive(definition, { ...opts, resume: true });
    assert.equal(calls.length, before);
    results.push({
      workflow: name,
      fixture: mode,
      status: 'passed',
      finalStatus: result.status,
      outputStatus: result.output.status,
      agentCalls: calls.length,
      completedCallsPaidAgain: 0,
    });
  }
  const qa = await fixture(join(root, 'lifecycle-verify-timeout')),
    verifyStage = verificationStage;
  const qaOptions = {
    ...runOptions(qa, 'lifecycle-verify-timeout', undefined, {
      stage: 'qa',
      testCommand: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    }),
    policy: [{ kind: 'exec', match: 'test', timeoutMs: 1000 }],
  };
  delete qaOptions.harness;
  const verified = await drive(verifyStage, qaOptions);
  assert.equal(verified.result.status, 'completed');
  assert.equal(verified.result.output.gate, 'blocked');
  assert.match(verified.result.output.details.join('\n'), /timeout/u);
  const qaStep = (await readRun(qaOptions)).steps['test'];
  assert.equal(qaStep.status, 'settled-failed');
  assert.equal(qaStep.settledError.kind, 'timeout');
  await drive(verifyStage, { ...qaOptions, resume: true });
  assert.equal(
    (await readRun(qaOptions)).steps['test'].attemptHistory?.length,
    qaStep.attemptHistory?.length,
  );
  results.push({
    workflow: 'sdlc-orchestrator',
    fixture: 'lifecycle-verification-timeout-blocks-gate',
    status: 'passed',
    gate: 'blocked',
    completedCallsPaidAgain: 0,
  });
  const env = await fixture(join(root, 'spend-gate')),
    definition = await load(2, 'bug-hunt');
  const { harness, calls } = harnessFor(2, 'bug-hunt', env);
  const opts = runOptions(env, 'spend', harness, inputFor(2, 'bug-hunt', env));
  await assert.rejects(drive(definition, { ...opts, maxRunCostUsd: 0.025 }), /maxRunCostUsd/u);
  const before = calls.length,
    stopped = await readRun(opts);
  assert.equal(before, 3);
  assert.equal(stopped.budgetStop.metric, 'maxRunCostUsd');
  const { result } = await drive(definition, { ...opts, resume: true, maxRunCostUsd: 1 });
  assert.equal(result.status, 'completed');
  assert.ok(
    calls
      .slice(before)
      .every((call) => !calls.slice(0, before).some((old) => old.call.stepId === call.call.stepId)),
  );
  results.push({
    workflow: 'bug-hunt',
    fixture: 'reported-spend-gate-and-higher-cap-resume',
    status: 'passed',
    admittedBeforeStop: before,
    completedCallsPaidAgain: 0,
  });
  const target = await fixture(join(root, 'unknown-mutation'));
  const mutation = await load(2, 'test-gap-filler');
  const inert = harnessFor(2, 'test-gap-filler', target);
  const mutationOptions = runOptions(
    target,
    'unknown',
    inert.harness,
    inputFor(2, 'test-gap-filler', target),
  );
  let inject = true;
  mutationOptions.processRunner = {
    async run(request, invocation) {
      if (inject && request.capture === 'error') {
        inject = false;
        await writeFile(join(target.cwd, 'target.mjs'), 'external edit\n');
      }
      return target.processRunner.run(request, invocation);
    },
  };
  await assert.rejects(drive(mutation, mutationOptions), /Command exited with 1/u);
  const refused = await readRun(mutationOptions);
  assert.match(refused.steps['mutants/zero/check'].execError.stderrTail, /Unknown target bytes/u);
  assert.equal(await readFile(join(target.cwd, 'target.mjs'), 'utf8'), 'external edit\n');
  await writeFile(join(target.cwd, 'target.mjs'), pristine);
  const recovered = await drive(mutation, { ...mutationOptions, resume: true });
  assert.equal(recovered.result.output.status, 'covered');
  assert.equal(inert.calls.length, 4);
  results.push({
    workflow: 'test-gap-filler',
    fixture: 'unknown-external-edit-refused-then-operator-restores',
    status: 'passed',
    completedCallsPaidAgain: 0,
  });
  return results;
}

export async function cliContracts(root) {
  const results = [];
  for (const name of names) {
    const validated = spawnSync(
      process.execPath,
      [
        join(project, 'bin/run.js'),
        'workflow',
        'validate',
        join(project, 'comparisons/batches/02-idiomatic-ports/ported', `${name}.workflow.ts`),
        '--json',
      ],
      { cwd: project, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    results.push({ workflow: name, fixture: 'cli-validate', status: 'passed' });
  }
  const env = await fixture(join(root, 'cli-sdlc'));
  const fixtures = join(env.root, 'fixtures.json');
  await writeFile(
    fixtures,
    JSON.stringify({
      version: 1,
      unmatched: 'error',
      calls: [
        {
          step: 'intake',
          output: { plan: ['requirements', 'spec'], rationale: 'Fixture lifecycle' },
        },
        { step: '**/draft', text: 'Fixture document' },
        { step: '**/review', output: { summary: 'Ready', gate: 'pass', details: [] } },
      ],
    }),
  );
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', env.stateDir],
      {
        cwd: env.cwd,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          XDG_STATE_HOME: join(env.root, 'xdg-state'),
          XDG_CACHE_HOME: join(env.root, 'xdg-cache'),
        },
      },
    );
  const executed = cli(
    'execute',
    join(project, 'comparisons/batches/02-idiomatic-ports/ported/sdlc-orchestrator.workflow.ts'),
    '--run-id',
    'cli-lifecycle',
    '--input',
    JSON.stringify(inputFor(2, 'sdlc-orchestrator', env)),
    '--harness',
    `fixture:${fixtures}`,
    '--grant',
    'all',
    '--json',
  );
  assert.equal(executed.status, 75, executed.stderr + executed.stdout);
  let waiting = JSON.parse(executed.stdout),
    count = 0;
  while (waiting.pending) {
    assert.ok(count++ < 4);
    const answer = cli(
      'answer',
      'cli-lifecycle',
      waiting.pending[0].stepId,
      '--json',
      JSON.stringify({ decision: 'continue', answer: '' }),
      '--by',
      'human:fixture',
      '--resume',
      '--harness',
      `fixture:${fixtures}`,
    );
    assert.ok([0, 75].includes(answer.status), answer.stderr + answer.stdout);
    waiting = JSON.parse(answer.stdout);
  }
  assert.equal(waiting.status, 'completed');
  assert.equal(waiting.output.runId, 'cli-lifecycle');
  results.push({
    workflow: 'sdlc-orchestrator',
    fixture: 'cli-exit-75-answer-resume',
    status: 'passed',
    waitingExit: 75,
    runIds: 1,
    suspensions: count,
  });
  return results;
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import { readRun, runWorkflow } from 'quiet-choir';
import {
  command,
  drive,
  fixture,
  harnessFor,
  inputFor,
  load,
  names,
  project,
  runOptions,
  snapshot,
} from './idiomatic-fixtures.mjs';

import { cliContracts, extraContracts, killCase } from './verify-idiomatic-faults.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.length > 1)
  throw new Error('Usage: verify-idiomatic-ports.mjs [--check]');
const root = await mkdtemp(join(tmpdir(), 'choir-idiomatic-'));
const batchDir = join(project, 'comparisons/batches/02-idiomatic-ports');
const metrics = [],
  results = [];
const stderr = console.error;
console.error = () => {};
let sequence = 0;
const setup = async () => fixture(join(root, String(sequence++)));
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const degradation = (record) =>
  record.status !== 'completed'
    ? null
    : [
        'degraded',
        'call-limit',
        'needs-review',
        'verification-failed',
        'baseline-failed',
        'gaps-remain',
      ].includes(record.output?.status);
function repeated(calls, before) {
  const old = new Set(calls.slice(0, before).map((call) => call.call.stepId));
  return calls.slice(before).filter((call) => old.has(call.call.stepId)).length;
}
function options(env, batch, name, harness) {
  return runOptions(env, `batch-${batch}-${name}`, harness, inputFor(batch, name, env));
}
async function scenario(batch, name, fault) {
  const env = await setup(),
    definition = await load(batch, name);
  const { harness, calls } = harnessFor(batch, name, env, { fault });
  const opts = options(env, batch, name, harness);
  let first;
  try {
    first = (await drive(definition, opts)).result;
  } catch {
    first = await readRun(opts);
  }
  const afterFault = await snapshot(env.cwd),
    before = calls.length;
  const completedIDs = new Set(
    Object.entries(first.steps)
      .filter(([, step]) => step.status === 'completed')
      .map(([id]) => id),
  );
  const { result: final } = await drive(definition, { ...opts, resume: true });
  assert.equal(final.status, 'completed');
  const completedCallsPaidAgain = calls
    .slice(before)
    .filter((call) => completedIDs.has(call.call.stepId)).length;
  assert.equal(completedCallsPaidAgain, 0);
  return {
    initialStatus: first.status,
    finalStatus: final.status,
    callsPaidAgain: repeated(calls, before),
    completedCallsPaidAgain,
    filesystemAfterFault: afterFault,
    filesystem: await snapshot(env.cwd),
    outputAdmitsDegradation: degradation(final),
  };
}
async function fixResume(batch, name) {
  const env = await setup(),
    base = await load(batch, name);
  const { harness, calls } = harnessFor(batch, name, env),
    opts = options(env, batch, name, harness);
  // Only the final statement changes. No workflow/effect contract is redefined.
  const beforeSource =
    'const output = await base.run(ctx, input); throw new Error("one-line fixture tail");';
  const afterSource = beforeSource.replace(
    'throw new Error("one-line fixture tail")',
    'return output',
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const wrap = (source) => ({
    ...base,
    run: (ctx, input) => new AsyncFunction('base', 'ctx', 'input', source)(base, ctx, input),
  });
  const fingerprint = (source) => createHash('sha256').update(source).digest('hex');
  await assert.rejects(
    drive(wrap(beforeSource), { ...opts, fingerprint: fingerprint(beforeSource) }),
    /one-line fixture tail/u,
  );
  const before = calls.length;
  await assert.rejects(
    runWorkflow(wrap(afterSource), {
      ...opts,
      resume: true,
      fingerprint: fingerprint(afterSource),
    }),
    /changed|fingerprint/iu,
  );
  const { result } = await drive(wrap(afterSource), {
    ...opts,
    resume: true,
    fingerprint: fingerprint(afterSource),
    acceptCodeChange: true,
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, before);
  return {
    initialStatus: 'failed',
    finalStatus: result.status,
    callsPaidAgain: 0,
    completedCallsPaidAgain: 0,
    filesystem: await snapshot(env.cwd),
    outputAdmitsDegradation: degradation(result),
    evidence:
      'Actual one-statement wrapper fix; source fingerprint refused until acceptCodeChange. Embedded API, not a CLI edit.',
  };
}

try {
  const sharedFormattedLines = {};
  for (const id of ['01-direct-ports', '02-idiomatic-ports']) {
    const directory = join(project, 'comparisons/batches', id);
    const checked = spawnSync(
      join(project, 'node_modules/.bin/tsc'),
      ['-p', join(directory, 'tsconfig.json')],
      { cwd: project, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    sharedFormattedLines[id] = {};
    for (const file of (await readdir(join(directory, 'ported')))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.workflow.ts'))
      .sort()) {
      sharedFormattedLines[id][file] = (
        await format(await readFile(join(directory, 'ported', file), 'utf8'), {
          parser: 'typescript',
          ...JSON.parse(await readFile(join(project, '.prettierrc.json'), 'utf8')),
        })
      )
        .trimEnd()
        .split('\n').length;
    }
  }
  for (const name of names) {
    const row = { workflow: name, batches: {} };
    for (const batch of [1, 2]) {
      const env = await setup(),
        definition = await load(batch, name);
      const { harness, calls } = harnessFor(batch, name, env),
        opts = options(env, batch, name, harness);
      let approvedPlan;
      const { result, suspended } = await drive(definition, opts, {
        onSuspended: (record) => {
          if (name === 'project-bootstrap' && batch === 2) approvedPlan = record.pending[0].subject;
        },
      });
      assert.equal(result.status, 'completed');
      const before = calls.length;
      assert.equal(
        new Set(calls.map((call) => call.call.stepId)).size,
        calls.length,
        'Question resumes must not repeat completed calls',
      );
      await drive(definition, { ...opts, resume: true });
      assert.equal(calls.length, before);
      if (batch === 2) {
        if (name === 'release-notes') {
          assert.deepEqual(
            result.output.manifest,
            command(env.cwd, 'rev-list', '--reverse', `${env.since}..${env.until}`, '--').split(
              '\n',
            ),
          );
          assert.deepEqual(result.output.covered, result.output.manifest);
          assert.deepEqual(result.output.missing, []);
          assert.equal(
            await readFile(join(env.cwd, 'RELEASE_NOTES.md'), 'utf8'),
            `${result.output.notes}\n`,
          );
        }
        if (name === 'project-bootstrap') {
          assert.equal(result.output.status, 'applied');
          assert.equal(
            result.output.approvedDigest,
            createHash('sha256')
              .update(JSON.stringify(stable(approvedPlan.plan)))
              .digest('hex'),
          );
          assert.equal(result.output.appliedDigest, result.output.approvedDigest);
          const setters = calls.filter((call) => call.call.stepId.endsWith('/apply'));
          assert.equal(setters.length, 2);
          assert.equal(new Set(setters.map((call) => call.cwd)).size, 2);
          for (const call of setters) {
            assert.notEqual(call.cwd, env.cwd);
            assert.deepEqual(
              JSON.parse(call.options.prompt.split('Approved plan:\n')[1]),
              approvedPlan.plan,
            );
          }
          assert.ok(result.output.verification.every((check) => check.code === 0));
          assert.equal(await readFile(join(env.cwd, 'setup.txt'), 'utf8'), 'foundation\n');
          assert.equal(command(env.cwd, 'status', '--porcelain'), '');
        }
        if (name === 'test-gap-filler') {
          assert.equal(result.output.status, 'covered');
          assert.equal(result.output.mutations.length, 1);
          assert.equal(result.output.mutations[0].code, 1);
          assert.equal((await snapshot(env.cwd)).targetPristine, true);
        }
        if (name === 'incident-investigation') assert.equal(result.output.clean, true);
        if (name === 'sdlc-orchestrator') {
          assert.equal(result.output.runId, opts.runId);
          assert.equal(result.output.status, 'complete');
          assert.equal(Object.keys(result.children).length, 2);
        }
        if (!['project-bootstrap'].includes(name))
          assert.ok(calls.every((call) => !(call.options.tools ?? []).includes('Write')));
        results.push({
          workflow: name,
          fixture: 'success-and-completed-replay',
          status: 'passed',
          agentCalls: calls.length,
          completedCallsPaidAgain: 0,
          suspensions: suspended,
        });
      }
      const path = join(
        project,
        'comparisons/batches',
        batch === 1 ? '01-direct-ports' : '02-idiomatic-ports',
        'ported',
        `${name}.workflow.ts`,
      );
      const formattedLines = (
        await format(await readFile(path, 'utf8'), {
          parser: 'typescript',
          ...JSON.parse(await readFile(join(project, '.prettierrc.json'), 'utf8')),
        })
      )
        .trimEnd()
        .split('\n').length;
      row.batches[batch] = {
        formattedLines,
        agentCalls: calls.length,
        writeToolCalls: calls.filter(
          (call) =>
            (call.options.tools ?? []).some((tool) => /^(?:Write|Edit|Bash)(?:\(|$)/u.test(tool)) ||
            call.options.sandbox === 'workspace-write',
        ).length,
        strictErrors: 0,
        faults: {
          F1: await scenario(batch, name, 'F1'),
          F2: await scenario(batch, name, 'F2'),
          F3: ['incident-investigation', 'bug-hunt'].includes(name)
            ? {
                finalStatus: 'not-applicable',
                callsPaidAgain: 0,
                filesystem: await snapshot(env.cwd),
                outputAdmitsDegradation: null,
                reason: 'Read-only intent: no prescribed write effect to kill',
              }
            : await killCase(join(root, `kill-${batch}-${name}`), batch, name),
          F4: await fixResume(batch, name),
          F5: suspended
            ? {
                initialStatus: 'suspended',
                finalStatus: 'completed',
                suspensions: suspended,
                callsPaidAgain: 0,
                completedCallsPaidAgain: 0,
                filesystem: await snapshot(env.cwd),
                outputAdmitsDegradation: degradation(result),
                evidence: 'Real inbox answers and same-run replay in the success case',
              }
            : {
                finalStatus: 'not-applicable',
                callsPaidAgain: 0,
                filesystem: await snapshot(env.cwd),
                outputAdmitsDegradation: null,
                reason: 'This port has no human question effect',
              },
        },
      };
    }
    metrics.push(row);
    console.log(`${name}: paired success, F1, F2, F4 and question fixtures passed`);
  }
  {
    // writeCommittedArtifact's containment check must accept a same-repository parent directory
    // whose name merely begins with '..' (a segment boundary, not a bare prefix match).
    const env = await setup(),
      definition = await load(2, 'release-notes'),
      { harness } = harnessFor(2, 'release-notes', env),
      out = '..generated/notes.md',
      opts = runOptions(env, 'batch-2-release-notes-dotted-parent', harness, {
        since: env.since,
        out,
        publication: 'commit',
      });
    const { result } = await drive(definition, opts);
    assert.equal(result.status, 'completed');
    assert.equal(await readFile(join(env.cwd, out), 'utf8'), `${result.output.notes}\n`);
    results.push({
      workflow: 'release-notes',
      fixture: 'committed-artifact-parent-name-begins-with-two-dots',
      status: 'passed',
    });
    console.log('release-notes: committed artifact parent name beginning with two dots passed');
  }
  results.push(
    ...(await extraContracts(join(root, 'contracts'))),
    ...(await cliContracts(join(root, 'cli'))),
  );
  for (const row of metrics)
    for (const [batch, measurement] of Object.entries(row.batches)) {
      for (const [fault, cell] of Object.entries(measurement.faults))
        results.push({
          workflow: row.workflow,
          batch: Number(batch),
          fixture: fault,
          status: cell.finalStatus === 'not-applicable' ? 'not-applicable' : 'passed',
          finalStatus: cell.finalStatus,
          callsPaidAgain: cell.callsPaidAgain,
        });
    }
  const report = {
    method:
      'Real engine and temporary Git/process fixtures; inert agent replies; no live model calls',
    results,
  };
  const measurements = {
    method:
      'Matched six intents with deterministic schema-valid replies; Batch 01 receives global Read/Grep/Glob/Write/Edit/Bash, Batch 02 uses named least-privilege profiles. Counts are fixture path observations, not quality or billing savings. Formatted entrypoint lines exclude shared helpers and typed children. Strict errors are verified separately by tsc.',
    sharedFormattedLines,
    rows: metrics,
  };
  for (const [file, value] of [
    ['verification.json', report],
    ['metrics.json', measurements],
  ]) {
    const text = await format(JSON.stringify(value), {
      parser: 'json',
      ...JSON.parse(await readFile(join(project, '.prettierrc.json'), 'utf8')),
    });
    if (args.includes('--check'))
      assert.equal(await readFile(join(batchDir, file), 'utf8'), text, `Regenerate ${file}`);
    else await writeFile(join(batchDir, file), text);
  }
} finally {
  console.error = stderr;
  await rm(root, { recursive: true, force: true });
}

// The F1, F2 and F4 rows of the paired fault matrix, shared by the Batch 02 and Batch 03
// verifiers. `setup` creates a fresh fixture repository for each scenario.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRun, runWorkflow } from 'quiet-choir';
import {
  assertNoReplyErrors,
  drive,
  harnessFor,
  inputFor,
  load,
  packagedFixtures,
  prepare,
  runOptions,
  snapshot,
} from './idiomatic-fixtures.mjs';

export const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
// A status that admits it, or (Batch 03 incident-investigation, which has no status) a domain
// left uncollected or a hypothesis left unchallenged by a failed settled member, or a Batch 03
// fixture module's own `degraded(output)` rule for the workflow `name`.
export const degradation = (record, name) =>
  record.status !== 'completed'
    ? null
    : [
        'degraded',
        'call-limit',
        'needs-review',
        'verification-failed',
        'baseline-failed',
        'gaps-remain',
      ].includes(record.output?.status) ||
      Boolean(record.output?.uncollected?.length) ||
      Boolean(record.output?.hypotheses?.some((hypothesis) => hypothesis.verdict === null)) ||
      Boolean(packagedFixtures[name]?.degraded?.(record.output));
export function repeated(calls, before) {
  const old = new Set(calls.slice(0, before).map((call) => call.call.stepId));
  return calls.slice(before).filter((call) => old.has(call.call.stepId)).length;
}
export async function options(env, batch, name, harness) {
  return runOptions(env, `batch-${batch}-${name}`, harness, await inputFor(batch, name, env));
}
export async function scenario(setup, batch, name, fault) {
  const env = await prepare(batch, name, await setup()),
    definition = await load(batch, name);
  // A Batch 03 fixture module's replies must not throw, and its F2 holds until the resume.
  const packaged = batch === 3 && Boolean(packagedFixtures[name]);
  const { harness, calls, replyErrors, faultedStep, endFault } = harnessFor(batch, name, env, {
    fault,
  });
  const opts = await options(env, batch, name, harness);
  let first;
  try {
    first = (await drive(definition, opts)).result;
  } catch {
    first = await readRun(opts);
  }
  const named = packaged && packagedFixtures[name].faults?.[fault];
  if (named) assert.ok(faultedStep(), `${name} ${fault}: no step matched /${named}/u`);
  if (packaged) endFault();
  const afterFault = await snapshot(env.cwd),
    before = calls.length;
  const completedIDs = new Set(
    Object.entries(first.steps)
      .filter(([, step]) => step.status === 'completed')
      .map(([id]) => id),
  );
  let final;
  try {
    ({ result: final } = await drive(definition, { ...opts, resume: true }));
  } finally {
    // A reply that threw explains a failed resume better than the run's own error.
    if (packaged) assertNoReplyErrors(replyErrors, `${name} ${fault}`);
  }
  assert.equal(final.status, 'completed');
  const completedCallsPaidAgain = calls
    .slice(before)
    .filter((call) => completedIDs.has(call.call.stepId)).length;
  assert.equal(completedCallsPaidAgain, 0);
  return {
    initialStatus: first.status,
    finalStatus: final.status,
    ...(packaged ? { faultedStep: faultedStep() } : {}),
    callsPaidAgain: repeated(calls, before),
    completedCallsPaidAgain,
    filesystemAfterFault: afterFault,
    filesystem: await snapshot(env.cwd),
    outputAdmitsDegradation: degradation(final, name),
  };
}
export async function fixResume(setup, batch, name) {
  const env = await prepare(batch, name, await setup()),
    base = await load(batch, name);
  const { harness, calls, replyErrors } = harnessFor(batch, name, env),
    opts = await options(env, batch, name, harness);
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
  let result;
  try {
    ({ result } = await drive(wrap(afterSource), {
      ...opts,
      resume: true,
      fingerprint: fingerprint(afterSource),
      acceptCodeChange: true,
    }));
  } finally {
    if (batch === 3 && packagedFixtures[name]) assertNoReplyErrors(replyErrors, `${name} F4`);
  }
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, before);
  return {
    initialStatus: 'failed',
    finalStatus: result.status,
    callsPaidAgain: 0,
    completedCallsPaidAgain: 0,
    filesystem: await snapshot(env.cwd),
    outputAdmitsDegradation: degradation(result, name),
    evidence:
      'Actual one-statement wrapper fix; source fingerprint refused until acceptCodeChange. Embedded API, not a CLI edit.',
  };
}

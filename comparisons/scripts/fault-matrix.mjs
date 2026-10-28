// The F1, F2 and F4 rows of the paired fault matrix, shared by the Batch 02 and Batch 03
// verifiers. `setup` creates a fresh fixture repository for each scenario.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRun, runWorkflow } from 'quiet-choir';
import { drive, harnessFor, inputFor, load, runOptions, snapshot } from './idiomatic-fixtures.mjs';

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
// left uncollected or a hypothesis left unchallenged by a failed settled member.
export const degradation = (record) =>
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
      Boolean(record.output?.hypotheses?.some((hypothesis) => hypothesis.verdict === null));
export function repeated(calls, before) {
  const old = new Set(calls.slice(0, before).map((call) => call.call.stepId));
  return calls.slice(before).filter((call) => old.has(call.call.stepId)).length;
}
export function options(env, batch, name, harness) {
  return runOptions(env, `batch-${batch}-${name}`, harness, inputFor(batch, name, env));
}
export async function scenario(setup, batch, name, fault) {
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
export async function fixResume(setup, batch, name) {
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

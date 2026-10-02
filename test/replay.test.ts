/* eslint-disable @typescript-eslint/no-deprecated -- Exercise the supported legacy map/replay contract. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  checkResume,
  type RunRecord,
  type WorkflowEvent,
  ConfigurationError,
  defineWorkflow,
  readRun,
  runWorkflow,
  StepIdentityChangedError,
  WorkflowRunError,
  z,
  type Harness,
  type RunOptions,
  type WorkflowContext,
} from '../src/index.js';
import {
  findStepIdentityChange,
  ReplayDivergenceError,
} from '../src/workflow/runtime/run-errors.js';
import type * as images from '../src/workflow/runtime/images.js';
import { hasTerminalOutcomes, lockRun } from '../src/workflow/runtime/store.js';

// A gate on Codex image snapshots: the only await an agent call makes before its effect starts.
const preparation = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('../src/workflow/runtime/images.js', async (importOriginal) => {
  const original = await importOriginal<typeof images>();
  return {
    ...original,
    snapshotImages: async (...args: Parameters<typeof original.snapshotImages>) => {
      await preparation.gate;
      return original.snapshotImages(...args);
    },
  };
});

let stateDir: string;
const reply = {
  text: 'ok',
  sessionId: 'fixture',
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
const workflow = (run: (ctx: WorkflowContext, input: { n: number }) => Promise<string>) =>
  defineWorkflow({
    name: 'replay',
    version: '1',
    input: z.object({ n: z.number().default(1) }),
    output: z.string(),
    run,
  });
const options = (runId = 'source'): RunOptions => ({
  runId,
  stateDir,
  input: { n: 1 },
  fingerprint: 'code-1',
});
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-replay-'));
});
afterEach(async () => {
  preparation.gate = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

it('forks the unchanged launch prefix, records differences/provenance, and never writes its source', async () => {
  let edited = false;
  const calls: string[] = [];
  const harness: Harness = {
    invoke(request) {
      calls.push(request.options.prompt);
      return Promise.resolve(reply);
    },
  };
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('plan', { prompt: 'plan' });
    await ctx.claude.text('review', { prompt: edited ? 'new review' : 'review' });
    return (await ctx.claude.text('write', { prompt: 'write' })).output;
  });
  await runWorkflow(definition, { ...options(), harness });
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
  calls.length = 0;
  edited = true;
  const events: string[] = [];
  const fork = await runWorkflow(
    { ...definition, version: '2' },
    {
      ...options('fork'),
      fingerprint: 'code-2',
      input: { n: 2 },
      harness,
      forkFrom: { runId: 'source' },
      onEvent(e) {
        events.push(e.type);
      },
    },
  );
  expect(calls).toEqual(['new review', 'write']);
  expect(events.slice(0, 2)).toEqual(['run.started', 'step.reused']);
  expect(fork.steps['plan']?.reusedFrom).toMatchObject({ runId: 'source', stepId: 'plan' });
  expect(fork.steps['review']?.reusedFrom).toBeUndefined();
  expect(fork.forkedFrom).toMatchObject({
    reuse: 'prefix',
    invalidate: [],
    differences: ['version', 'code', 'input'],
    cursor: 1,
    reuseClosed: true,
  });
  expect(Object.values(fork.steps).map((step) => step.seq)).toEqual([1, 2, 3]);
  expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
});

it('supports matching reuse and explicit invalidation globs, while prefix misses close reuse', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  let edited = false;
  const definition = workflow(async (ctx) => {
    for (const id of ['plan', 'review', 'write/report'])
      await ctx.codex.text(id, { prompt: id === 'review' && edited ? 'new' : id });
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  edited = true;
  invoke.mockClear();
  const matched = await runWorkflow(definition, {
    ...options('matching'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching' },
  });
  expect(invoke.mock.calls.map(([request]) => request.options.prompt)).toEqual(['new']);
  expect(matched.steps['write/report']?.reusedFrom?.runId).toBe('source');
  invoke.mockClear();
  const invalidated = await runWorkflow(definition, {
    ...options('invalidate'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching', invalidate: ['write/**'] },
  });
  expect(invoke.mock.calls.map(([request]) => request.options.prompt)).toEqual([
    'new',
    'write/report',
  ]);
  expect(invalidated.forkedFrom?.invalidate).toEqual(['write/**']);
  const skipped = workflow(
    async (ctx) => (await ctx.codex.text('write/report', { prompt: 'write/report' })).output,
  );
  invoke.mockClear();
  await runWorkflow(skipped, {
    ...options('skip-prefix'),
    harness: { invoke },
    forkFrom: { runId: 'source' },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('closes prefix reuse synchronously when concurrent launches encounter a miss', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  let edited = false;
  const definition = workflow(async (ctx) => {
    await ctx.map(['a', 'b', 'c'], 3, (id) =>
      ctx.claude.text(id, { prompt: edited && id === 'a' ? 'changed' : id }),
    );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  edited = true;
  invoke.mockClear();
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness: { invoke },
    forkFrom: { runId: 'source' },
  });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(Object.values(fork.steps).every((step) => step.reusedFrom === undefined)).toBe(true);
});

it.each(['failed', 'running'] as const)('never copies a %s source record', async (status) => {
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('source failed'))
    .mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('a', { prompt: 'a' }).catch(() => undefined);
    return (await ctx.claude.text('b', { prompt: 'b' })).output;
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  const source = await readRun(options());
  const unfinished = source.steps['a'];
  if (!unfinished) throw new Error('missing fixture');
  unfinished.status = status;
  await writeFile(join(stateDir, 'source', 'run.json'), JSON.stringify(source));
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
  invoke.mockClear();
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching' },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(fork.steps['a']?.attempts).toBe(1);
  expect(fork.steps['a']?.reusedFrom).toBeUndefined();
  expect(fork.steps['b']?.reusedFrom).toBeDefined();
  expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
});

it.each(['unchanged', 'changed', 'missing'] as const)(
  'resumes a fork against an %s pinned source',
  async (state) => {
    let pause = false;
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = workflow(async (ctx) => {
      await ctx.codex.text('a', { prompt: 'a' });
      if (pause) throw new Error('pause');
      return (await ctx.codex.text('b', { prompt: 'b' })).output;
    });
    const base = { ...options(), harness: { invoke } };
    await runWorkflow(definition, base);
    pause = true;
    invoke.mockClear();
    await expect(
      runWorkflow(definition, {
        ...base,
        runId: 'fork',
        input: undefined,
        forkFrom: { runId: 'source' },
      }),
    ).rejects.toThrow('pause');
    expect((await readRun({ stateDir, runId: 'fork' })).input).toEqual({ n: 1 });
    if (state === 'changed')
      await runWorkflow(definition, { ...base, resume: true, policyReset: true });
    if (state === 'missing') await rm(join(stateDir, 'source', 'run.json'));
    pause = false;
    const result = await runWorkflow(definition, { ...base, runId: 'fork', resume: true });
    expect(invoke).toHaveBeenCalledTimes(state === 'unchanged' ? 0 : 1);
    expect(result.steps['a']?.reusedFrom).toBeDefined();
    if (state !== 'unchanged')
      expect(result.warnings?.[0]).toContain('remaining effects will execute live');
  },
);

it('rejects an old format, different name, existing target, invalid flags, or invalid globs without touching the source', async () => {
  const definition = workflow(() => Promise.resolve('done'));
  await runWorkflow(definition, options());
  const path = join(stateDir, 'source', 'run.json');
  const before = await readFile(path, 'utf8');
  await expect(
    runWorkflow(
      { ...definition, name: 'different' },
      { ...options('other'), forkFrom: { runId: 'source' } },
    ),
  ).rejects.toThrow('name');
  await expect(
    runWorkflow(definition, { ...options(), forkFrom: { runId: 'source' } }),
  ).rejects.toThrow('already exists');
  await expect(
    runWorkflow(definition, { ...options('other'), resume: true, forkFrom: { runId: 'source' } }),
  ).rejects.toThrow('cannot be combined');
  await expect(
    runWorkflow(definition, { ...options('other'), acceptCodeChange: true }),
  ).rejects.toThrow('requires resume');
  await expect(
    runWorkflow(definition, {
      ...options('other'),
      forkFrom: { runId: 'source', invalidate: ['[invalid'] },
    }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(before);
  await rm(join(stateDir, 'source'), { recursive: true });
  const legacyPath = join(stateDir, 'source.json');
  for (const formatVersion of [1, 2, 3, 4, 5]) {
    await writeFile(
      legacyPath,
      JSON.stringify({ ...(JSON.parse(before) as object), formatVersion }),
    );
    const legacy = await readFile(legacyPath, 'utf8');
    expect((await readRun(options())).formatVersion).toBe(formatVersion);
    await expect(
      runWorkflow(definition, { ...options('old-fork'), forkFrom: { runId: 'source' } }),
    ).rejects.toThrow(`format version ${String(formatVersion)}`);
    await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
      `format version ${String(formatVersion)}`,
    );
    expect((await checkResume(definition, options())).compatible).toBe(false);
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
  }
});

it('accepts a fix to an unfinished callback with both code-change and step-redefinition history', async () => {
  let callback = (): string => {
    throw new Error('bug');
  };
  const definition = workflow((ctx) =>
    ctx.step('local', { input: null, schema: z.string(), run: callback }),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('bug');
  callback = () => 'fixed';
  await expect(
    runWorkflow(definition, { ...options(), resume: true, fingerprint: 'code-2' }),
  ).rejects.toThrow('code changed');
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(resumed.output).toBe('fixed');
  expect(resumed.codeChanges?.[0]).toMatchObject({ components: ['code'], files: [] });
  expect(resumed.steps['local']?.redefinitions).toHaveLength(1);
  expect(resumed.steps['local']?.attemptHistory).toHaveLength(2);
  await runWorkflow(definition, { ...options(), resume: true, fingerprint: 'code-2' });
  const reaccepted = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(reaccepted.codeChanges).toHaveLength(1);
});

it('rejects edited completed callbacks on accepted resume and runs them live in a fork', async () => {
  let callback = () => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  callback = () => 'two';
  const rejected = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  }).catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(WorkflowRunError);
  expect((rejected as Error).message).toContain('callback changed on a completed step');
  expect((rejected as Error).message).toContain(
    '--fork-from RUN --reuse matching --invalidate local',
  );
  const change = findStepIdentityChange(rejected);
  expect(change).toBeInstanceOf(StepIdentityChangedError);
  expect(change).toMatchObject({ stepId: 'local', components: ['callback'], status: 'completed' });
  expect(findStepIdentityChange(new AggregateError([new Error('x'), change]))).toBe(change);
  expect(findStepIdentityChange(new Error('plain'))).toBeUndefined();
  const forked = await runWorkflow(
    {
      ...definition,
      run: (ctx) => ctx.step('local', { input: null, schema: z.string(), run: callback }),
    },
    { ...options('fork'), forkFrom: { runId: 'source' } },
  );
  expect(forked.output).toBe('two');
  expect(forked.steps['local']?.reusedFrom).toBeUndefined();
});

it('honors local versions and revalidates candidates even when callback source cannot see captured values', async () => {
  let value = 'one';
  let version = '1';
  let allowOld = true;
  const callback = () => value;
  const definition = workflow((ctx) =>
    ctx.step('local', {
      input: null,
      version,
      schema: z.string().refine((x) => allowOld || x === value),
      run: callback,
    }),
  );
  await runWorkflow(definition, options());
  value = 'two';
  const unchanged = await runWorkflow(definition, {
    ...options('unchanged'),
    forkFrom: { runId: 'source' },
  });
  expect(unchanged.output).toBe('one'); // Captured state is intentionally not guessed by toString.
  allowOld = false;
  const invalid = await runWorkflow(definition, {
    ...options('invalid-result'),
    forkFrom: { runId: 'source' },
  });
  expect(invalid.output).toBe('two');
  expect(invalid.steps['local']?.reusedFrom).toBeUndefined();
  version = '2';
  const changed = await runWorkflow(definition, {
    ...options('versioned'),
    forkFrom: { runId: 'source' },
  });
  expect(changed.output).toBe('two');
  expect(changed.steps['local']?.reusedFrom).toBeUndefined();
});

it('re-finalizes an output-validation failure with no repeated effects and records schema changes', async () => {
  const effect = vi.fn(() => 'done');
  let broken = true;
  const definition = workflow(async (ctx) => {
    const value = await ctx.step('effect', { input: null, schema: z.string(), run: effect });
    return broken ? (undefined as unknown as string) : value;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow();
  expect((await readRun(options())).recoveryHint).toContain(
    'All recorded work has terminal outcomes',
  );
  broken = false;
  const changed = {
    ...definition,
    output: z.literal('done'),
    run: definition.run as (ctx: WorkflowContext, input: { n: number }) => Promise<'done'>,
  };
  const before = await checkResume(changed, { ...options(), fingerprint: 'code-2' });
  expect(before).toMatchObject({
    compatible: false,
    canAcceptCodeChange: true,
    refinalizable: true,
  });
  expect(before.message).toContain('zero repeated effects');
  const result = await runWorkflow(changed, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(result.output).toBe('done');
  expect(result.codeChanges?.[0]?.components).toEqual(['code', 'output schema']);
  expect(result.recoveryHint).toBeUndefined();
  expect(effect).toHaveBeenCalledTimes(1);
});

it('clears stale output before re-finalizing, so a failed re-finalization reports null output', async () => {
  const definition = workflow(() => Promise.resolve('done'));
  await runWorkflow(definition, options());
  const before = await readRun(options());
  expect(before.status).toBe('completed');
  expect(before.output).toBe('done');
  // A deliberately mismatched output schema; schema-first inference would otherwise reject it.
  const broken = { ...definition, output: z.literal('other') } as unknown as typeof definition;
  await expect(
    runWorkflow(broken, {
      ...options(),
      resume: true,
      fingerprint: 'code-2',
      acceptCodeChange: true,
    }),
  ).rejects.toThrow();
  const after = await readRun(options());
  expect(after.status).toBe('failed');
  expect(after.output).toBeNull();
});

it('checks compatibility while a writer lock exists, itemizes changed files, and retains non-code gates', async () => {
  const run = vi.fn(() => Promise.resolve('done'));
  const definition = workflow(run);
  const source = { hash: 'old', files: { 'lib/report.ts': 'old', 'removed.ts': 'old' } };
  const setup = { runId: 'source', stateDir, input: { n: 1 }, source };
  await runWorkflow(definition, setup);
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
  const release = await lockRun(stateDir, 'source');
  try {
    const current = { hash: 'new', files: { 'lib/report.ts': 'new', 'added.ts': 'new' } };
    const report = await checkResume(definition, { ...setup, source: current });
    expect(report.files).toEqual(['added.ts', 'lib/report.ts', 'removed.ts']);
    expect(report.message).toContain('code (added.ts, lib/report.ts, removed.ts) changed');
    expect(report.unchanged).toContain('name');
    expect(
      (await checkResume(definition, { ...setup, source: current, acceptCodeChange: true }))
        .compatible,
    ).toBe(true);
    for (const next of [{ input: { n: 2 } }, { input: { n: 'bad' } }, { cwd: stateDir }]) {
      expect(
        (await checkResume(definition, { ...setup, ...next, acceptCodeChange: true }))
          .canAcceptCodeChange,
      ).toBe(false);
    }
    expect(
      (
        await checkResume(
          { ...definition, name: 'different' },
          { ...setup, acceptCodeChange: true },
        )
      ).compatible,
    ).toBe(false);
    expect(
      (await checkResume({ ...definition, version: '2' }, { ...setup, acceptCodeChange: true }))
        .compatible,
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
  } finally {
    await release();
  }
});

it.each([false, true])(
  'emits divergence before live work, with strictReplay=%s',
  async (strictReplay) => {
    let resumePath = false;
    const order: string[] = [];
    const first = () => 'saved';
    const definition = workflow(async (ctx) => {
      if (!resumePath) {
        await ctx.step('first', { input: null, schema: z.string(), run: first });
        throw new Error('pause');
      }
      await ctx.map(['live-a', 'live-b'], 2, (id) =>
        ctx.step(id, {
          input: null,
          schema: z.string(),
          run() {
            order.push(id);
            return 'live';
          },
        }),
      );
      return 'done';
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
    resumePath = true;
    await expect(
      runWorkflow(definition, {
        ...options(),
        resume: true,
        strictReplay,
        onEvent(event) {
          if (event.type === 'replay.divergence') {
            order.push('warning');
            expect(event.skippedStepIds).toEqual(['first']);
          }
        },
      }),
    ).rejects.toThrow(strictReplay ? 'Replay divergence' : 'skipped recorded steps');
    expect(order[0]).toBe('warning');
    expect(order).toHaveLength(strictReplay ? 1 : 3);
    const saved = await readRun(options());
    expect(saved.replayWarnings?.[0]).toContain('first');
    if (strictReplay) expect(saved.steps['live-a']).toBeUndefined();
    // The same source took a different path, so the hint blames a body-computed value even when
    // the strict stop cancelled map siblings.
    for (const phrase of ['ctx.now', 'ctx.step', '--strict-replay', '--fork-from source'])
      expect(saved.recoveryHint).toContain(phrase);
    expect(saved.recoveryHint).not.toContain('accept-code-change');
  },
);

const nondeterministicHint = (hint: string | undefined): void => {
  for (const phrase of ['ctx.now', 'ctx.step', '--strict-replay']) expect(hint).toContain(phrase);
  expect(hint).not.toContain('accept-code-change');
};

it.each([false, true])(
  'advises against body-computed values when an unchanged source skips recorded steps (strictReplay: %s)',
  async (strictReplay) => {
    // A closure flag stands in for a value the body computes outside a durable effect.
    let early = true;
    let fail = true;
    const definition = workflow(async (ctx) => {
      if (early) await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
      await ctx.step('shared', { input: null, schema: z.string(), run: () => 's' });
      if (fail) throw new Error('pause');
      return ctx.step('late', { input: null, schema: z.string(), run: () => 'l' });
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
    early = false;
    fail = false;
    const error: unknown = await runWorkflow(definition, {
      ...options(),
      resume: true,
      strictReplay,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowRunError);
    expect((error as Error).message).toContain(
      strictReplay ? 'Replay divergence before live step late' : 'Replay skipped recorded steps',
    );
    nondeterministicHint((await readRun(options())).recoveryHint);
  },
);

it('advises against body-computed values when strict replay stops after a healed step', async () => {
  let attempt = 0;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('flaky', {
        input: null,
        schema: z.string(),
        run: () => {
          attempt += 1;
          if (attempt === 1) throw new Error('flaky');
          return 'healed';
        },
      });
    } catch (error) {
      // Launched after the failure settled, so it may depend on it.
      await ctx.step('other', { input: null, schema: z.string(), run: () => 'o' });
      throw error;
    }
    return ctx.step('after', { input: null, schema: z.string(), run: () => 'a' });
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('flaky');
  expect((await readRun(options())).recoveryHint).toContain('Resume with --resume');
  const error: unknown = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay: true,
  }).catch((cause: unknown) => cause);
  expect((error as Error).message).toContain('Healed step flaky now succeeded');
  nondeterministicHint((await readRun(options())).recoveryHint);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function divergence(error: unknown): ReplayDivergenceError | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof ReplayDivergenceError) return cause;
  return undefined;
}

/** Rewrite a saved run without launch stamps, as a checkpoint written before they existed. */
async function stripStamps(runId: string): Promise<RunRecord> {
  const record = await readRun(options(runId));
  for (const step of Object.values(record.steps)) {
    delete step.launchStamp;
    delete step.settleStamp;
    delete step.failureStamp;
  }
  await writeFile(join(stateDir, runId, 'run.json'), JSON.stringify(record));
  await writeFile(join(stateDir, runId, 'journal.jsonl'), '');
  return record;
}

type FanInOrder = 'followups first' | 'impl first' | 'impl during followups preparation';

/**
 * `impl` (a local step) and `followups` (a Codex call whose image snapshot awaits before its
 * effect starts) launch in the same tick and fan in with Promise.all; impl fails only on the first
 * execution. 'impl first' completes followups while the failed body drains. In 'impl during
 * followups preparation', the snapshot waits until impl's failure is saved, so followups reaches
 * its record after the failure settled although the body requested it before; that body uses
 * Promise.allSettled, since a failed body launches no new effect. `ship` is the first live step
 * after the fan-in, where strict replay would stop.
 */
function fanIn(order: FanInOrder): {
  definition: ReturnType<typeof workflow>;
  harness: Harness;
  calls: string[];
  onEvent: (event: WorkflowEvent) => void;
  heal: () => void;
} {
  let broken = true;
  const calls: string[] = [];
  const implFailed = deferred();
  const followupsDone = deferred();
  const harness: Harness = {
    async invoke(request) {
      calls.push(request.options.prompt);
      if (broken && order === 'impl first') await implFailed.promise;
      return reply;
    },
  };
  const image = join(stateDir, 'shot.png');
  if (order === 'impl during followups preparation') preparation.gate = implFailed.promise;
  const definition = workflow(async (ctx) => {
    const launched = [
      ctx.step('impl', {
        input: null,
        schema: z.string(),
        run: async () => {
          if (!broken) return 'implemented';
          if (order === 'followups first') await followupsDone.promise;
          throw new Error('impl failed');
        },
      }),
      ctx.codex.text('followups', { prompt: 'followups', images: [image] }),
    ] as const;
    const [impl] =
      order === 'impl during followups preparation'
        ? await Promise.allSettled(launched).then((results) =>
            results.map((result) => {
              if (result.status === 'rejected') throw result.reason;
              return result.value;
            }),
          )
        : await Promise.all(launched);
    await ctx.step('ship', { input: null, schema: z.null(), run: () => null });
    return impl as string;
  });
  return {
    definition,
    harness,
    calls,
    onEvent: (event) => {
      if (event.type === 'step.failed' && event.stepId === 'impl') implFailed.resolve();
      if (event.type === 'step.completed' && event.stepId === 'followups') followupsDone.resolve();
    },
    heal: () => {
      broken = false;
    },
  };
}

it.each<FanInOrder>(['followups first', 'impl first', 'impl during followups preparation'])(
  'does not flag a Promise.all sibling launched with a healed step (%s)',
  async (order) => {
    const { definition, harness, calls, onEvent, heal } = fanIn(order);
    await writeFile(join(stateDir, 'shot.png'), 'png');
    await expect(runWorkflow(definition, { ...options(), harness, onEvent })).rejects.toThrow(
      'impl failed',
    );
    const failed = await readRun(options());
    const impl = failed.steps['impl'];
    const followups = failed.steps['followups'];
    expect(impl?.status).toBe('failed');
    expect(followups?.status).toBe('completed');
    expect(impl?.failureStamp).toBe(impl?.settleStamp);
    expect(followups?.launchStamp).toBeLessThan(impl?.failureStamp ?? 0);
    // Settle order shows in the stamps, launch order does not.
    if (order === 'followups first')
      expect(followups?.settleStamp).toBeLessThan(impl?.failureStamp ?? 0);
    else expect(followups?.settleStamp).toBeGreaterThan(impl?.failureStamp ?? 0);
    heal();
    calls.length = 0;
    const events: WorkflowEvent[] = [];
    const resumed = await runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      strictReplay: true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('implemented');
    expect(calls).toEqual([]);
    expect(events.filter((event) => event.type === 'replay.divergence')).toEqual([]);
    const saved = await readRun(options());
    expect(saved.replayWarnings).toEqual([]);
    expect(saved.steps['impl']?.failureStamp).toBeUndefined();
    expect(saved.steps['impl']?.settleStamp).toBeGreaterThan(impl?.failureStamp ?? 0);
  },
);

it.each([false, true])(
  'flags a step launched after the healed failure settled (strictReplay: %s)',
  async (strictReplay) => {
    let broken = true;
    const ran: string[] = [];
    const local = (id: string) => ({
      input: null,
      schema: z.string(),
      run: () => {
        ran.push(id);
        if (broken && id === 'primary') throw new Error('primary failed');
        return id;
      },
    });
    const definition = workflow(async (ctx) => {
      try {
        await ctx.step('primary', local('primary'));
      } catch {
        await ctx.step('fallback', local('fallback'));
      }
      if (broken) throw new Error('tail');
      return ctx.step('later', local('later'));
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    broken = false;
    ran.length = 0;
    const healed: WorkflowEvent[] = [];
    const outcome = await runWorkflow(definition, {
      ...options(),
      resume: true,
      strictReplay,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }).catch((error: unknown) => error);
    expect(healed.filter((event) => event.healedStepId)).toMatchObject([
      { healedStepId: 'primary', skippedStepIds: ['fallback'] },
    ]);
    expect((await readRun(options())).replayWarnings?.[0]).toContain(
      'Healed step primary now succeeded; later recorded steps (fallback)',
    );
    if (strictReplay) {
      expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
      expect(divergence(outcome)?.message).toContain('Healed step primary now succeeded');
      expect(ran).toEqual(['primary']);
    } else {
      // The plain resume runs on and then reports the skipped fallback with the healed step.
      expect(divergence(outcome)?.message).toContain('Healed steps: primary');
      expect(ran).toEqual(['primary', 'later']);
    }
  },
);

it('keeps the earliest failure stamp across repeated failures until the step completes', async () => {
  let failures = 2;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('healer', {
        input: null,
        schema: z.string(),
        run: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('healer failed');
          }
          return 'h';
        },
      });
    } catch {
      await ctx.step('dependent', { input: null, schema: z.string(), run: () => 'd' });
      throw new Error('tail');
    }
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  const firstFailure = first.steps['healer']?.failureStamp;
  expect(firstFailure).toBeDefined();
  expect(first.steps['dependent']?.launchStamp).toBeGreaterThanOrEqual(firstFailure ?? 0);
  // The second failure settles after the dependent launched; only the first one explains it.
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow('tail');
  const second = await readRun(options());
  expect(second.steps['healer']?.failureStamp).toBe(firstFailure);
  expect(second.steps['healer']?.settleStamp).toBeGreaterThan(
    second.steps['dependent']?.launchStamp ?? 0,
  );
  expect(second.steps['dependent']?.launchStamp).toBe(first.steps['dependent']?.launchStamp);
  const healed: WorkflowEvent[] = [];
  await expect(
    runWorkflow(definition, {
      ...options(),
      resume: true,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }),
  ).rejects.toThrow('Healed steps: healer');
  expect(healed).toMatchObject([{ healedStepId: 'healer', skippedStepIds: ['dependent'] }]);
  const third = await readRun(options());
  expect(third.steps['healer']).toMatchObject({ status: 'completed' });
  expect(third.steps['healer']?.failureStamp).toBeUndefined();
  expect(third.steps['healer']?.settleStamp).toBeGreaterThan(
    second.steps['healer']?.settleStamp ?? 0,
  );
});

it.each([false, true])(
  'falls back to launch order for a checkpoint without launch stamps (strictReplay: %s)',
  async (strictReplay) => {
    const { definition, harness, calls, onEvent, heal } = fanIn('followups first');
    await writeFile(join(stateDir, 'shot.png'), 'png');
    await expect(runWorkflow(definition, { ...options(), harness, onEvent })).rejects.toThrow(
      'impl failed',
    );
    const stripped = await stripStamps('source');
    expect(stripped.steps['followups']?.seq).toBeGreaterThan(stripped.steps['impl']?.seq ?? 0);
    const loaded = await readRun(options());
    expect(loaded.steps['followups']?.launchStamp).toBeUndefined();
    expect(loaded.steps['impl']?.failureStamp).toBeUndefined();
    heal();
    calls.length = 0;
    const healed: WorkflowEvent[] = [];
    const outcome = await runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      strictReplay,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }).catch((error: unknown) => error);
    expect(calls).toEqual([]);
    expect(healed).toMatchObject([{ healedStepId: 'impl', skippedStepIds: ['followups'] }]);
    if (strictReplay) {
      expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
      expect((await readRun(options())).steps['ship']).toBeUndefined();
    } else expect(outcome).toMatchObject({ status: 'completed', output: 'implemented' });
    expect((await readRun(options())).replayWarnings?.[0]).toContain(
      'later recorded steps (followups)',
    );
  },
);

it('stamps live launches, settlements and fork-reused copies in the target run', async () => {
  const definition = workflow(async (ctx) => {
    const a = await ctx.step('a', { input: null, schema: z.string(), run: () => 'a' });
    const b = await ctx.step('b', { input: null, schema: z.string(), run: () => 'b' });
    return a + b;
  });
  await runWorkflow(definition, options());
  const source = await readRun(options());
  expect(source.steps['a']).toMatchObject({ launchStamp: 0, settleStamp: 1 });
  expect(source.steps['b']).toMatchObject({ launchStamp: 1, settleStamp: 2 });
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    forkFrom: { runId: 'source', invalidate: ['b'] },
  });
  expect(fork.steps['a']?.reusedFrom).toBeDefined();
  expect(fork.steps['a']).toMatchObject({ launchStamp: 0, settleStamp: 1 });
  expect(fork.steps['b']?.reusedFrom).toBeUndefined();
  expect(fork.steps['b']).toMatchObject({ launchStamp: 1, settleStamp: 2 });
  const asked = await runWorkflow(
    workflow(async (ctx) => {
      await ctx.step('a', { input: null, schema: z.string(), run: () => 'a' });
      return ctx.ask('q', { prompt: 'Text?', schema: z.string() });
    }),
    options('asks'),
  );
  expect(asked.status).toBe('suspended');
  expect(asked.steps['q']).toMatchObject({ status: 'waiting', launchStamp: 1 });
  expect(asked.steps['q']?.settleStamp).toBeUndefined();
});

it('advises against body-computed values when a completed step identity changes', async () => {
  let stamp = 'monday';
  let fail = true;
  const definition = workflow(async (ctx) => {
    await ctx.step('stamped', { input: stamp, schema: z.string(), run: () => 'done' });
    if (fail) throw new Error('pause');
    return 'ok';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
  stamp = 'tuesday';
  fail = false;
  const error: unknown = await runWorkflow(definition, { ...options(), resume: true }).catch(
    (cause: unknown) => cause,
  );
  expect(findStepIdentityChange(error)?.stepId).toBe('stamped');
  nondeterministicHint((await readRun(options())).recoveryHint);
});

it('saves no resume advice for a run that fails before recording anything', async () => {
  const definition = workflow(() => Promise.reject(new Error('body bug')));
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect((error as Error).message).not.toContain('--resume');
  const saved = await readRun(options());
  expect(saved.recoveryHint).toBeUndefined();
  expect(hasTerminalOutcomes(saved)).toBe(false);
  expect((await checkResume(definition, options())).refinalizable).toBe(false);
});

it('suggests a plain resume for an effect failure and re-finalizing for a later configuration failure', async () => {
  let broken = true;
  const failing = workflow(async (ctx) => {
    await ctx.step('ok', { input: null, schema: z.string(), run: () => 'ok' });
    return ctx.step('effect', {
      input: null,
      schema: z.string(),
      run: () => {
        if (broken) throw new Error('remote down');
        return 'done';
      },
    });
  });
  await expect(runWorkflow(failing, options())).rejects.toThrow('remote down');
  const hint = (await readRun(options())).recoveryHint;
  expect(hint).toBe(
    'Resume with --resume once the cause is fixed or has passed; completed steps are reused and the failed step runs again.',
  );
  expect(hint).not.toContain('accept-code-change');
  broken = false;
  expect((await runWorkflow(failing, { ...options(), resume: true })).output).toBe('done');

  const configured = workflow(async (ctx) => {
    await ctx.step('ok', { input: null, schema: z.string(), run: () => 'ok' });
    throw new ConfigurationError('missing deploy target');
  });
  await expect(runWorkflow(configured, options('configured'))).rejects.toThrow(
    'missing deploy target',
  );
  const refinalize = (await readRun(options('configured'))).recoveryHint;
  expect(refinalize).toContain('All recorded work has terminal outcomes');
  expect(refinalize).toContain('re-finalize');
  expect(refinalize).toContain('--resume --accept-code-change');
});

it('names the call-site effect kind for a failure before the step has a record', async () => {
  const definition = workflow(async (ctx) => {
    await ctx.readFile('notes', 'notes.txt', { bogus: true } as never);
    return 'never';
  });
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect((error as Error).message).toMatch(/^Step notes \(read-file\) failed:/u);
  expect((error as Error).message).not.toContain('(unknown)');
  const saved = await readRun(options());
  expect(saved.steps['notes']).toBeUndefined();
  expect(saved.rootCause).toMatchObject({ stepId: 'notes', effect: 'read-file' });
});

it('counts only recorded work as terminal outcomes', () => {
  const empty = { steps: {}, maps: {} } as unknown as Parameters<typeof hasTerminalOutcomes>[0];
  expect(hasTerminalOutcomes(empty)).toBe(false);
  const completed = {
    steps: { done: { status: 'completed' } },
    maps: {},
  } as unknown as Parameters<typeof hasTerminalOutcomes>[0];
  expect(hasTerminalOutcomes(completed)).toBe(true);
});

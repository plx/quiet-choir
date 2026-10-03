import { WorkflowRunError } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CancelledError,
  CheckpointError,
  FanOutError,
  defineWorkflow,
  checkResume,
  readRun,
  runWorkflow,
  writeAnswer,
  z,
  type MapStepError,
  type Settled,
  type WorkflowContext,
} from '../src/index.js';
import { validateRunRecord } from '../src/workflow/runtime/record.js';

let stateDir: string;
const options = () => ({ stateDir, runId: 'fanout', input: null });
const workflow = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'fanout', version: '1', input: z.null(), output: z.unknown(), run });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-fanout-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it.each(['drain', 'cancelSiblings', 'return'] as const)(
  'recovers outside a %s map without aborting the run signal',
  async (policy) => {
    const result = await runWorkflow(
      workflow(async (ctx) => {
        const runSignal = ctx.signal;
        try {
          const mapper = async (index: number) => {
            expect(ctx.signal).not.toBe(runSignal);
            return ctx.step('item', {
              input: index,
              schema: z.number(),
              run() {
                throw new Error('item failed');
              },
            });
          };
          if (policy === 'return')
            await ctx.map('items', [0], { concurrency: 1, onError: 'return' }, mapper);
          else
            await ctx.map(
              'items',
              [0],
              { concurrency: 1, cancelSiblings: policy === 'cancelSiblings' },
              mapper,
            );
        } catch (error) {
          expect(error).toBeInstanceOf(FanOutError);
        }
        expect(ctx.signal).toBe(runSignal);
        expect(ctx.signal.aborted).toBe(false);
        return ctx.step('after', { input: null, schema: z.string(), run: () => 'continued' });
      }),
      options(),
    );
    expect(result.output).toBe('continued');
    expect(result.rootCause).toBeNull();
  },
);

it('drains by default, stops scheduling promptly, and replays finished siblings on resume', async () => {
  let broken = true;
  const started = deferred();
  const failed = deferred();
  const work = vi.fn(async (index: number, signal: AbortSignal) => {
    if (index === 0 && broken) {
      await started.promise;
      throw new Error('primary failed');
    }
    if (index === 1) {
      started.resolve();
      await failed.promise;
      await nextTurn();
    }
    expect(signal.aborted).toBe(false);
    return index;
  });
  const definition = workflow((ctx) =>
    ctx.map('item', [0, 1, 2, 3], { concurrency: 2 }, (index) =>
      ctx.step('run', {
        input: index,
        schema: z.number(),
        run: ({ signal }) => work(index, signal),
      }),
    ),
  );
  const error: unknown = await runWorkflow(definition, {
    ...options(),
    onEvent: (event) => {
      if (event.type === 'step.failed') failed.resolve();
    },
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkflowRunError);
  if (!(error instanceof WorkflowRunError)) throw error;
  expect(error.stepId).toBe('item/0/run');
  expect(error.cause).toBeInstanceOf(FanOutError);
  expect(error.cause).toMatchObject({
    policy: 'drain',
    failures: [{ index: 0, stepId: 'item/0/run' }],
    unscheduled: [2, 3],
  });
  const first = await readRun(options());
  expect(first.steps['item/1/run']?.status).toBe('completed');
  expect(first.rootCause).toEqual({
    stepId: 'item/0/run',
    error: 'primary failed',
    errorKind: 'unknown',
    effect: 'step',
  });
  broken = false;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    0, 1, 2, 3,
  ]);
  expect(work.mock.calls.map(([index]) => index)).toEqual([0, 1, 0, 2, 3]);
  expect((await readRun(options())).rootCause).toBeNull();
});

it('limits cancelSiblings to its subtree and identifies cancelled siblings separately from the cause', async () => {
  const started = deferred();
  const rootFailure = new Error('A/0 failed');
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.map('branch', ['A', 'B'], { concurrency: 2, key: (branch) => branch }, async (branch) => {
        if (branch === 'B')
          return ctx.step('run', {
            input: null,
            schema: z.string(),
            run: async ({ signal }) => {
              await delay(20);
              expect(signal.aborted).toBe(false);
              return 'B survived';
            },
          });
        try {
          await ctx.map('inner', [0, 1], { concurrency: 2, cancelSiblings: true }, (index) =>
            ctx.step('run', {
              input: index,
              schema: z.string(),
              run: async ({ signal }) => {
                if (index === 0) {
                  await started.promise;
                  throw rootFailure;
                }
                started.resolve();
                await delay(5000, undefined, { signal });
                return 'unreachable';
              },
            }),
          );
        } catch (error) {
          expect(error).toBeInstanceOf(FanOutError);
          if (!(error instanceof FanOutError)) throw error;
          expect(error.policy).toBe('abort');
          expect(error.cause).toBe(rootFailure);
          expect(error.failures[1]?.error).toBeInstanceOf(CancelledError);
        }
        expect(ctx.signal.aborted).toBe(false);
        return 'A recovered';
      }),
    ),
    options(),
  );
  expect(result.output).toEqual(['A recovered', 'B survived']);
  expect(result.steps['branch/A/inner/0/run']).toMatchObject({
    status: 'failed',
    error: 'A/0 failed',
  });
  expect(result.steps['branch/A/inner/1/run']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'branch/A/inner/0/run',
    error: 'Map cancelled by step branch/A/inner/0/run.',
  });
  expect(result.steps['branch/B/run']?.status).toBe('completed');
});

it('keeps a validated result returned after scope abort and replays it on resume', async () => {
  let broken = true;
  const started = deferred();
  const late = vi.fn(async (signal: AbortSignal) => {
    started.resolve();
    if (broken && !signal.aborted)
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
    if (broken) expect(signal.aborted).toBe(true);
    return 'saved despite abort';
  });
  const definition = workflow((ctx) =>
    ctx.map('items', [0, 1], { concurrency: 2, cancelSiblings: true }, async (index) => {
      if (index === 0)
        return ctx.step('failure', {
          input: null,
          schema: z.string(),
          run: async () => {
            await started.promise;
            if (broken) throw new Error('root failure');
            return 'healed';
          },
        });
      return ctx.step('late', {
        input: null,
        schema: z.string(),
        run: ({ signal }) => late(signal),
      });
    }),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('root failure');
  expect((await readRun(options())).steps['items/1/late']).toMatchObject({
    status: 'completed',
    output: 'saved despite abort',
  });
  broken = false;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    'healed',
    'saved despite abort',
  ]);
  expect(late).toHaveBeenCalledTimes(1);
});

it('drains Promise.all siblings without a signal and records the actual root cause', async () => {
  const started = deferred();
  const result = runWorkflow(
    workflow(async (ctx) => {
      await Promise.all([
        ctx.step('failure', {
          input: null,
          schema: z.null(),
          run: async () => {
            await started.promise;
            throw new Error('first cause');
          },
        }),
        ctx.step('writer', {
          input: null,
          schema: z.string(),
          run: async ({ signal }) => {
            started.resolve();
            await delay(20);
            expect(signal.aborted).toBe(false);
            return 'finished';
          },
        }),
      ]);
      return null;
    }),
    options(),
  );
  await expect(result).rejects.toThrow('first cause');
  expect(await readRun(options())).toMatchObject({
    status: 'failed',
    rootCause: { stepId: 'failure', error: 'first cause', errorKind: 'unknown' },
    steps: { writer: { status: 'completed', output: 'finished' } },
  });
});

it('refuses new launches after a body rejection while started effects checkpoint', async () => {
  let broken = true;
  const started = deferred();
  const reported = deferred();
  const first = vi.fn(async () => {
    started.resolve();
    // Finish only after the failure has rejected the body and closed the workflow.
    await reported.promise;
    await nextTurn();
    return 'a';
  });
  const second = vi.fn(() => 'b');
  const definition = workflow(async (ctx) => {
    await Promise.all([
      ctx.map('items', [0], { concurrency: 1 }, async () => {
        await ctx.step('a', { input: null, schema: z.string(), run: first });
        return ctx.step('b', { input: null, schema: z.string(), run: second });
      }),
      ctx.step('failure', {
        input: null,
        schema: z.null(),
        run: async () => {
          await started.promise;
          if (broken) throw new Error('first cause');
          return null;
        },
      }),
    ]);
    return 'done';
  });
  await expect(
    runWorkflow(definition, {
      ...options(),
      onEvent(event) {
        if (event.type === 'step.failed' && event.stepId === 'failure') reported.resolve();
      },
    }),
  ).rejects.toThrow('first cause');
  const saved = await readRun(options());
  expect(saved).toMatchObject({
    status: 'failed',
    rootCause: { stepId: 'failure', error: 'first cause', errorKind: 'unknown' },
    steps: { 'items/0/a': { status: 'completed', output: 'a' } },
  });
  // The closed workflow refused the active mapper's next launch, so it never started.
  expect(saved.steps['items/0/b']).toBeUndefined();
  expect(second).not.toHaveBeenCalled();
  broken = false;
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.output).toBe('done');
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it('journals all settled mapper outcomes, including body errors, and replays an identical array', async () => {
  let broken = true;
  const called: number[] = [];
  const tail = vi.fn(() => 'summary');
  const definition = workflow(async (ctx) => {
    const results = await ctx.map(
      'reviewers',
      [0, 1, 2],
      { concurrency: 2, onError: 'return' },
      async (index) => {
        called.push(index);
        if (index === 0 && broken) throw new Error('mapper body failed');
        return ctx.step('item', {
          input: index,
          schema: z.string(),
          run: () => {
            if (index === 1 && broken) throw new Error('effect failed');
            return 'success';
          },
        });
      },
    );
    expectTypeOf(results).toEqualTypeOf<Settled<string, MapStepError>[]>();
    const output = await ctx.step('summary', { input: results, schema: z.string(), run: tail });
    if (broken) throw new Error('tail failed');
    return output;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail failed');
  const before = (await readRun(options())).maps?.['reviewers'];
  expect((await checkResume(definition, options())).refinalizable).toBe(true);
  expect(before?.items.map((item) => item.outcome)).toEqual([
    {
      ok: false,
      error: { message: 'mapper body failed', kind: 'unknown', attempts: 1, stepId: null },
    },
    {
      ok: false,
      error: {
        message: 'effect failed',
        kind: 'unknown',
        attempts: 1,
        stepId: 'reviewers/1/item',
      },
    },
    { ok: true, value: 'success' },
  ]);
  broken = false;
  const result = await runWorkflow(definition, {
    ...options(),
    resume: true,
    policy: [{ match: 'reviewers/*/item', retry: { maxAttempts: 2 } }],
  });
  expect(result.output).toBe('summary');
  expect(result.maps?.['reviewers']).toEqual(before);
  expect(called).toEqual([0, 1, 2]);
  expect(tail).toHaveBeenCalledTimes(1);
  expect(result.policyWarnings).toEqual([]);
  expect(result.rootCause).toBeNull();
});

it('tracks and replays nested map journals and drains detached successful descendants before committing an item', async () => {
  let tail = true;
  const effect = vi.fn(async () => {
    await delay(10);
    return 'child';
  });
  const definition = workflow(async (ctx) => {
    const result = await ctx.map('outer', [0], { concurrency: 1, onError: 'return' }, () =>
      ctx.map('inner', [0], { concurrency: 1, onError: 'return' }, () => {
        void ctx.step('detached', { input: null, schema: z.string(), run: effect });
        return Promise.resolve('mapper');
      }),
    );
    if (tail) throw new Error('tail');
    return result;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const saved = await readRun(options());
  expect(saved.maps?.['outer']?.items[0]).toMatchObject({
    status: 'completed',
    steps: ['outer/0/inner/0/detached'],
    maps: ['outer/0/inner'],
  });
  tail = false;
  await runWorkflow(definition, { ...options(), resume: true });
  expect(effect).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'resumes an interrupted return map without rerunning committed items (cancelSiblings: %s)',
  async (cancelSiblings) => {
    const controller = new AbortController();
    const entered = deferred();
    let broken = true;
    const called: number[] = [];
    const definition = workflow((ctx) =>
      ctx.map(
        'items',
        [0, 1],
        { concurrency: 1, onError: 'return', cancelSiblings },
        async (index) => {
          called.push(index);
          return ctx.step('item', {
            input: index,
            schema: z.number(),
            run: async ({ signal }) => {
              if (index === 1 && broken) {
                entered.resolve();
                await delay(10_000, undefined, { signal });
              }
              return index;
            },
          });
        },
      ),
    );
    const pending = runWorkflow(definition, { ...options(), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('Workflow interrupted.');
    await entered.promise;
    controller.abort(new Error('Workflow interrupted.'));
    await rejected;
    const first = await readRun(options());
    expect(first).toMatchObject({
      status: 'cancelled',
      rootCause: { stepId: null, error: 'Workflow interrupted.', errorKind: null },
      steps: { 'items/1/item': { status: 'cancelled', cancelledBy: null } },
    });
    expect(first.maps?.['items']?.items.map((item) => item.status)).toEqual([
      'completed',
      'running',
    ]);
    broken = false;
    expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
      { ok: true, value: 0 },
      { ok: true, value: 1 },
    ]);
    expect(called).toEqual([0, 1, 1]);
  },
);

it('retains completed work from a signal-ignoring callback after a run interrupt', async () => {
  const controller = new AbortController();
  const started = deferred();
  const callback = vi.fn(async () => {
    started.resolve();
    await delay(10);
    return 'committed';
  });
  const definition = workflow((ctx) =>
    ctx.step('late', { input: null, schema: z.string(), run: callback }),
  );
  const pending = runWorkflow(definition, { ...options(), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('Workflow interrupted.');
  await started.promise;
  controller.abort(new Error('Workflow interrupted.'));
  await rejected;
  expect(await readRun(options())).toMatchObject({
    status: 'cancelled',
    rootCause: { stepId: null, error: 'Workflow interrupted.', errorKind: null },
    steps: { late: { status: 'completed', output: 'committed' } },
  });
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toBe('committed');
  expect(callback).toHaveBeenCalledTimes(1);
});

it('does not cache an item that ignored a failed operation', async () => {
  const definition = workflow((ctx) =>
    ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () => {
      void ctx.step('ignored', {
        input: null,
        schema: z.null(),
        run: () => {
          throw new Error('ignored failure');
        },
      });
      return Promise.resolve('apparently successful');
    }),
  );
  for (const resume of [false, true])
    await expect(runWorkflow(definition, { ...options(), resume })).rejects.toThrow(
      'Unawaited workflow operation',
    );
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

it.each([false, true])(
  'detects a skipped settled map before a later live step (strictReplay: %s)',
  async (strictReplay) => {
    let branch = true;
    let tail = true;
    const effect = vi.fn(() => 'published');
    const definition = workflow(async (ctx) => {
      // The mapper body owns its outcome; no leaf step records the map's path.
      if (branch)
        await ctx.map('reviews', [0, 1], { concurrency: 2, onError: 'return' }, (value) =>
          Promise.resolve(value * 2),
        );
      if (tail) throw new Error('tail');
      return ctx.step('publish', { input: null, schema: z.string(), run: effect });
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    expect((await readRun(options())).maps?.['reviews']).toMatchObject({
      seq: 1,
      status: 'completed',
    });
    branch = false;
    tail = false;
    const warnings: { message?: string; skippedStepIds?: readonly string[] }[] = [];
    await expect(
      runWorkflow(definition, {
        ...options(),
        resume: true,
        strictReplay,
        onEvent(event) {
          if (event.type === 'replay.divergence') {
            expect(effect).not.toHaveBeenCalled();
            warnings.push(event);
          }
        },
      }),
    ).rejects.toThrow(strictReplay ? 'Replay divergence' : 'Replay skipped settled maps (reviews)');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.skippedStepIds).toEqual([]);
    expect(warnings[0]?.message).toContain('earlier committed settled maps (reviews)');
    const saved = await readRun(options());
    expect(saved.replayWarnings).toEqual([warnings[0]?.message]);
    // Same source, different path: the hint blames a body-computed value, not a code change.
    for (const phrase of ['ctx.now', 'ctx.step', '--strict-replay'])
      expect(saved.recoveryHint).toContain(phrase);
    expect(saved.recoveryHint).not.toContain('accept-code-change');
    if (strictReplay) {
      expect(effect).not.toHaveBeenCalled();
      expect(saved.steps['publish']).toBeUndefined();
    } else {
      expect(effect).toHaveBeenCalledTimes(1);
      expect(saved.steps['publish']).toMatchObject({ status: 'completed', seq: 2 });
    }
  },
);

it('keeps empty-map identity and path checks, and allows concurrency changes', async () => {
  let skip = false;
  let changed = false;
  let concurrency = 1;
  let tail = true;
  const mapper = (value: number) => Promise.resolve(value);
  const definition = workflow(async (ctx) => {
    if (!skip)
      await ctx.map('empty', changed ? [1] : [], { concurrency, onError: 'return' }, mapper);
    if (tail) throw new Error('tail');
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  changed = true;
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'Settled map empty changed after an item completed (changed: items, keys)',
  );
  changed = false;
  skip = true;
  tail = false;
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'Replay skipped settled maps',
  );
  skip = false;
  concurrency = 5;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toBe('done');
});

it('processes the settled-map snapshot when the caller mutates items during the initial save', async () => {
  const seen: unknown[] = [];
  const definition = workflow(async (ctx) => {
    const second = { n: 1 };
    const items = [{ n: 0 }, second];
    const pending = ctx.map('items', items, { concurrency: 2, onError: 'return' }, (item) => {
      seen.push(structuredClone(item));
      return Promise.resolve(item.n);
    });
    // The mapper cannot start until the initial journal checkpoint save resolves.
    items[0] = { n: 99 };
    second.n = 98;
    items.push({ n: 2 });
    return pending;
  });
  const result = await runWorkflow(definition, options());
  expect(seen).toEqual([{ n: 0 }, { n: 1 }]);
  expect(result.output).toEqual([
    { ok: true, value: 0 },
    { ok: true, value: 1 },
  ]);
  const journal = (await readRun(options())).maps?.['items'];
  expect(journal?.items.map((item) => item.status)).toEqual(['completed', 'completed']);
  expect(journal?.status).toBe('completed');
});

it('schedules only the elements present when an ordinary map starts', async () => {
  const seen: unknown[] = [];
  const first = { n: 0 };
  const definition = workflow(async (ctx) => {
    const items = [first];
    const pending = ctx.map('items', items, { concurrency: 1 }, async (item) => {
      await nextTurn();
      seen.push(item);
      return item.n;
    });
    items.push({ n: 1 });
    return pending;
  });
  const result = await runWorkflow(definition, options());
  expect(result.output).toEqual([0]);
  expect(seen).toEqual([first]);
  expect(seen[0]).toBe(first);
});

it('rejects invalid or duplicate map identities and settings before invoking affected mappers', async () => {
  const mapper = vi.fn(() => Promise.resolve('value'));
  for (const [index, [id, settings, message]] of (
    [
      ['bad id', { concurrency: 1, onError: 'return' }, 'Invalid'],
      ['valid', { concurrency: 1, onError: 'return', version: '' }, 'Map version'],
      ['valid', { concurrency: 1, onError: 'ignore' }, "Map onError must be 'throw' or 'return'"],
      ['valid', { concurrency: 1, onError: 'drain' }, "Map onError must be 'throw' or 'return'"],
      ['valid', { concurrency: 1, onError: 'abort' }, "Map onError must be 'throw' or 'return'"],
      ['valid', { concurrency: 1, cancelSiblings: 'yes' }, 'Map cancelSiblings must be a boolean'],
      ['valid', { concurrency: 1, key: 'name' }, 'Map key must be a function'],
    ] as const
  ).entries()) {
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.map(id, [0], settings as never, mapper)),
        { ...options(), runId: `invalid-${String(index)}` },
      ),
    ).rejects.toThrow(message);
  }
  expect(mapper).not.toHaveBeenCalled();
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await ctx.map('duplicate', [], { concurrency: 1, onError: 'return' }, mapper);
        return ctx.map('duplicate', [0], { concurrency: 1, onError: 'return' }, mapper);
      }),
      options(),
    ),
  ).rejects.toThrow('Duplicate settled map ID');
  expect(mapper).not.toHaveBeenCalled();
});

it('rejects null nested map options as an authoring error instead of journaling it', async () => {
  const mapper = vi.fn(() => Promise.resolve('value'));
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.map('outer', [0], { concurrency: 1, onError: 'return' }, () =>
          ctx.map('inner', [0], null as never, mapper),
        ),
      ),
      options(),
    ),
  ).rejects.toThrow('Map options must be an object.');
  expect(mapper).not.toHaveBeenCalled();
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('does not convert nested validation errors into saved fallback values', async () => {
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.map('outer', [0], { concurrency: 1, onError: 'return' }, () =>
          ctx.map('inner', [0], { concurrency: 0 }, () => Promise.resolve(null)),
        ),
      ),
      options(),
    ),
  ).rejects.toThrow('positive integer');
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('rejects authoring failures wrapped by nested draining maps', async () => {
  const definition = workflow((ctx) =>
    ctx.map('outer', [0], { concurrency: 1, onError: 'return' }, () =>
      ctx.map('inner', [0], { concurrency: 1 }, () =>
        ctx.step('invalid id', { input: null, schema: z.null(), run: () => null }),
      ),
    ),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('Invalid step ID');
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('rejects a missing harness inside a settled map instead of journaling it', async () => {
  const definition = workflow((ctx) =>
    ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () =>
      ctx.claude.text('ask', { prompt: 'p' }),
    ),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('No harness adapter configured');
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

it('journals a domain error that reuses the CheckpointError class as a settled outcome', async () => {
  const definition = workflow((ctx) =>
    ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () =>
      ctx.step('domain', {
        input: null,
        schema: z.null(),
        run() {
          throw new CheckpointError('save', 'domain', null);
        },
      }),
    ),
  );
  const result = await runWorkflow(definition, options());
  expect(result.output).toEqual([
    {
      ok: false,
      error: { message: 'domain', kind: 'unknown', attempts: 1, stepId: 'items/0/domain' },
    },
  ]);
});

it('rejects non-JSON mapper outputs instead of committing a fallback', async () => {
  const definition = workflow((ctx) =>
    ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () => Promise.resolve(undefined)),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('JSON');
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

it('forks into fresh map outcomes while reusing eligible source leaves', async () => {
  let broken = true;
  const body = vi.fn(() => {
    if (broken) throw new Error('body failed');
    return 'reconsidered';
  });
  const leaf = vi.fn(() => 'saved');
  const definition = workflow((ctx) =>
    ctx.map('items', [0, 1], { concurrency: 1, onError: 'return' }, async (index) =>
      index === 0 ? body() : ctx.step('leaf', { input: null, schema: z.string(), run: leaf }),
    ),
  );
  const original = await runWorkflow(definition, options());
  broken = false;
  const result = await runWorkflow(definition, {
    ...options(),
    runId: 'fork',
    forkFrom: { runId: 'fanout' },
  });
  expect(result.output).toEqual([
    { ok: true, value: 'reconsidered' },
    { ok: true, value: 'saved' },
  ]);
  expect(body).toHaveBeenCalledTimes(2);
  expect(leaf).toHaveBeenCalledTimes(1);
  expect(result.steps['items/1/leaf']?.reusedFrom?.runId).toBe('fanout');
  expect(await readRun(options())).toEqual(original);
});

it('records cancellation during retry backoff without overwriting the failed attempt', async () => {
  const failed = deferred();
  const retried = vi.fn(() => {
    throw new Error('transient failure');
  });
  const events: string[] = [];
  const definition = workflow((ctx) =>
    ctx.map('items', [0, 1], { concurrency: 2, cancelSiblings: true }, (index) =>
      index === 0
        ? ctx.step('primary', {
            input: null,
            schema: z.null(),
            run: async () => {
              await failed.promise;
              throw new Error('primary cause');
            },
          })
        : ctx.step('backoff', {
            input: null,
            schema: z.null(),
            retry: { maxAttempts: 3, delayMs: 5000 },
            run: retried,
          }),
    ),
  );
  await expect(
    runWorkflow(definition, {
      ...options(),
      onEvent(event) {
        events.push(`${event.type}:${event.stepId ?? ''}`);
        if (event.type === 'step.failed' && event.stepId === 'items/1/backoff') failed.resolve();
      },
    }),
  ).rejects.toThrow('primary cause');
  const record = await readRun(options());
  expect(record.rootCause).toEqual({
    stepId: 'items/0/primary',
    error: 'primary cause',
    effect: 'step',
    errorKind: 'unknown',
  });
  expect(record.steps['items/1/backoff']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'items/0/primary',
    attempts: 1,
    error: 'Map cancelled by step items/0/primary.',
    attemptHistory: [{ status: 'failed', error: 'transient failure' }],
  });
  expect(events).toContain('step.cancelled:items/1/backoff');
  expect(retried).toHaveBeenCalledTimes(1);
});

it("records the root step's classified kind when a map failure surfaces through FanOutError", async () => {
  const slow = Object.assign(new Error('slow'), { code: 'ETIMEDOUT' });
  const definition = workflow((ctx) =>
    ctx.map('item', [0, 1], { concurrency: 2 }, (index) =>
      ctx.step('run', {
        input: index,
        schema: z.number(),
        retry: { maxAttempts: 1 },
        run: async () => {
          await delay(index * 20);
          throw slow;
        },
      }),
    ),
  );
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  if (!(error instanceof WorkflowRunError)) throw error;
  expect(error.cause).toBeInstanceOf(FanOutError);
  const saved = await readRun(options());
  // The effect label survives the FanOutError wrapper.
  expect(saved.rootCause).toEqual({
    stepId: 'item/0/run',
    error: 'slow',
    errorKind: 'timeout',
    effect: 'step',
  });
  expect(saved.steps['item/0/run']?.attemptHistory?.at(-1)?.errorKind).toBe('timeout');
});

it('records a null kind for a failure of the workflow body itself', async () => {
  const error: unknown = await runWorkflow(
    workflow(() => Promise.reject(new Error('body bug'))),
    options(),
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  const saved = await readRun(options());
  expect(saved.rootCause).toEqual({
    stepId: null,
    error: 'body bug',
    errorKind: null,
    effect: null,
  });
});

const cancelledBy = (stepId: string | null, attempts: number, by: string | null) => ({
  ok: false,
  error: {
    message: by === null ? 'Map cancelled.' : `Map cancelled by step ${by}.`,
    kind: 'cancelled',
    attempts,
    stepId,
  },
});

it('returns cancelled entries for return + cancelSiblings while work outside the map completes', async () => {
  const started = deferred();
  const cancelled = deferred();
  const calls: number[] = [];
  const outside: boolean[] = [];
  let runSignal: AbortSignal | undefined;
  const definition = workflow(async (ctx) => {
    runSignal = ctx.signal;
    const [results] = await Promise.all([
      ctx.map(
        'x',
        [0, 1, 2, 3],
        { concurrency: 2, onError: 'return', cancelSiblings: true },
        async (index) => {
          calls.push(index);
          if (index === 0) {
            await started.promise;
            return ctx.step('fail', {
              input: null,
              schema: z.string(),
              run() {
                throw new Error('item 0 failed');
              },
            });
          }
          return ctx.step('slow', {
            input: index,
            schema: z.string(),
            run: ({ signal }) => {
              started.resolve();
              return new Promise<string>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    reject(signal.reason as Error);
                  },
                  { once: true },
                );
              });
            },
          });
        },
      ),
      ctx.map('other', [0, 1], { concurrency: 2 }, (index) =>
        ctx.step('ok', { input: index, schema: z.number(), run: () => index }),
      ),
      ctx.step('outside', {
        input: null,
        schema: z.string(),
        run: async ({ signal }) => {
          // Still running when the map's own controller aborts.
          await cancelled.promise;
          outside.push(signal.aborted);
          return 'outside done';
        },
      }),
    ]);
    expectTypeOf(results).toEqualTypeOf<Settled<string, MapStepError>[]>();
    expect(ctx.signal.aborted).toBe(false);
    await ctx.ask('gate', { prompt: 'Continue?', schema: z.boolean() });
    return results;
  });
  const expected = [
    {
      ok: false,
      error: { message: 'item 0 failed', kind: 'unknown', attempts: 1, stepId: 'x/0/fail' },
    },
    // A started sibling keeps its own cancelled leaf, never the initiating error or step.
    cancelledBy('x/1/slow', 1, 'x/0/fail'),
    cancelledBy(null, 0, 'x/0/fail'),
    cancelledBy(null, 0, 'x/0/fail'),
  ];
  const first = await runWorkflow(definition, {
    ...options(),
    onEvent(event) {
      if (event.type === 'step.cancelled' && event.stepId === 'x/1/slow') cancelled.resolve();
    },
  });
  expect(first.status).toBe('suspended');
  expect(first.rootCause).toBeNull();
  expect(runSignal?.aborted).toBe(false);
  expect(outside).toEqual([false]);
  expect(first.steps['outside']).toMatchObject({ status: 'completed', output: 'outside done' });
  expect(first.steps['other/0/ok']?.status).toBe('completed');
  expect(first.steps['other/1/ok']?.status).toBe('completed');
  expect(first.steps['x/1/slow']).toMatchObject({ status: 'cancelled', cancelledBy: 'x/0/fail' });
  expect(calls).toEqual([0, 1]);
  const journal = first.maps?.['x'];
  expect(journal?.status).toBe('completed');
  expect(journal?.items.map((item) => item.outcome)).toEqual(expected);
  expect(journal?.items.map((item) => item.steps)).toEqual([['x/0/fail'], ['x/1/slow'], [], []]);
  // The journal holds cancellation only as this map's own unstarted or cancelled-leaf outcome.
  const saved = await readRun(options());
  expect(() => {
    validateRunRecord(saved);
  }).not.toThrow();
  const forged = structuredClone(saved);
  const unstarted = forged.maps?.['x']?.items[2]?.outcome;
  if (unstarted?.ok !== false) throw new Error('missing fixture');
  Object.assign(unstarted.error, { stepId: 'x/2/slow' });
  expect(() => {
    validateRunRecord(forged);
  }).toThrow('Invalid settled map journal');
  await writeAnswer({ ...options(), stepId: 'gate', value: true });
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.status).toBe('completed');
  expect(resumed.rootCause).toBeNull();
  expect(resumed.output).toEqual(expected);
  expect(calls).toEqual([0, 1]);
});

it('commits a sibling that resolves after its own map cancelled it and never blames the initiator', async () => {
  const late = deferred();
  const waiting = deferred();
  const definition = workflow((ctx) =>
    ctx.map(
      'x',
      [0, 1, 2, 3],
      { concurrency: 3, onError: 'return', cancelSiblings: true },
      async (index) => {
        if (index === 0) {
          await Promise.all([late.promise, waiting.promise]);
          return ctx.step('fail', {
            input: null,
            schema: z.string(),
            run() {
              throw new Error('item 0 failed');
            },
          });
        }
        if (index === 2) {
          // Rejects with the map's own reason, which no leaf remembers; its cause chain leads to
          // the initiating failure, which must not become this item's error.
          const signal = ctx.signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
            waiting.resolve();
          });
          signal.throwIfAborted();
        }
        return ctx.step('late', {
          input: index,
          schema: z.string(),
          run: async ({ signal }) => {
            late.resolve();
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
            });
            return 'kept';
          },
        });
      },
    ),
  );
  const result = await runWorkflow(definition, options());
  expect(result.status).toBe('completed');
  expect(result.output).toEqual([
    {
      ok: false,
      error: { message: 'item 0 failed', kind: 'unknown', attempts: 1, stepId: 'x/0/fail' },
    },
    { ok: true, value: 'kept' },
    cancelledBy(null, 1, 'x/0/fail'),
    cancelledBy(null, 0, 'x/0/fail'),
  ]);
  expect(result.steps['x/1/late']).toMatchObject({ status: 'completed', output: 'kept' });
});

it('cancels siblings in throw mode with policy abort and reports unscheduled indexes', async () => {
  const started = deferred();
  const later = vi.fn(() => Promise.resolve('never'));
  const definition = workflow((ctx) =>
    ctx.map('x', [0, 1, 2, 3], { concurrency: 2, cancelSiblings: true }, async (index) => {
      if (index === 0) {
        await started.promise;
        throw new Error('first failed');
      }
      if (index > 1) return later();
      return ctx.step('slow', {
        input: null,
        schema: z.string(),
        run: async ({ signal }) => {
          started.resolve();
          await delay(10_000, undefined, { signal });
          return 'unreachable';
        },
      });
    }),
  );
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  if (!(error instanceof WorkflowRunError)) throw error;
  expect(error.cause).toBeInstanceOf(FanOutError);
  if (!(error.cause instanceof FanOutError)) throw error;
  expect(error.cause.policy).toBe('abort');
  expect(error.cause.failures.map((failure) => failure.index)).toEqual([0, 1]);
  expect(error.cause.failures[1]?.error).toBeInstanceOf(CancelledError);
  expect(error.cause.unscheduled).toEqual([2, 3]);
  expect(later).not.toHaveBeenCalled();
  expect((await readRun(options())).steps['x/1/slow']?.status).toBe('cancelled');
});

it.each(['drain', 'abort'])(
  "rejects onError '%s' at runtime, naming 'throw', 'return' and cancelSiblings",
  async (onError) => {
    const mapper = vi.fn(() => Promise.resolve(null));
    const error: unknown = await runWorkflow(
      workflow((ctx) => ctx.map('items', [0], { concurrency: 1, onError } as never, mapper)),
      options(),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/'throw'/);
    expect(message).toMatch(/'return'/);
    expect(message).toMatch(/cancelSiblings/);
    expect(mapper).not.toHaveBeenCalled();
  },
);

it('rejects a positional call made at runtime with the removal message', async () => {
  const mapper = vi.fn(() => Promise.resolve(null));
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.map([0] as never, 1 as never, mapper as never, undefined as never)),
      options(),
    ),
  ).rejects.toThrow('ctx.map(id, items, { concurrency }, mapper)');
  expect(mapper).not.toHaveBeenCalled();
});

it("journals 'settle' and 'return' identically, so a 'settle' journal replays after the edit", async () => {
  const called = vi.fn();
  const definition = (onError: 'return') =>
    workflow(async (ctx) => {
      const results = await ctx.map('items', [0, 1], { concurrency: 2, onError }, (index) => {
        called(index);
        return ctx.step('leaf', {
          input: index,
          schema: z.number(),
          run() {
            if (index === 1) throw new Error('leaf failed');
            return index;
          },
        });
      });
      await ctx.ask('gate', { prompt: 'Continue?', schema: z.boolean() });
      return results;
    });
  const settle = definition('settle' as never);
  const run = (runId: string, workflowDefinition = settle, extra = {}) =>
    runWorkflow(workflowDefinition, { ...options(), runId, fingerprint: 'settle', ...extra });
  const settled = await run('settle');
  const returned = await run('return', definition('return'));
  expect(settled.status).toBe('suspended');
  expect(returned.status).toBe('suspended');
  expect(returned.maps?.['items']?.fingerprint).toBe(settled.maps?.['items']?.fingerprint);
  expect(returned.maps?.['items']?.components).toEqual(settled.maps?.['items']?.components);
  expect(returned.maps?.['items']?.items).toEqual(settled.maps?.['items']?.items);
  for (const id of ['items/0/leaf', 'items/1/leaf']) {
    expect(returned.steps[id]?.fingerprint).toBe(settled.steps[id]?.fingerprint);
    expect(returned.steps[id]?.identity).toEqual(settled.steps[id]?.identity);
  }
  const expected = [
    { ok: true, value: 0 },
    {
      ok: false,
      error: { message: 'leaf failed', kind: 'unknown', attempts: 1, stepId: 'items/1/leaf' },
    },
  ];
  expect(settled.maps?.['items']?.items.map((item) => item.outcome)).toEqual(expected);
  called.mockClear();
  // Unchanged source: the 'settle' journal replays and the run parks on its question again.
  expect((await run('settle', settle, { resume: true })).status).toBe('suspended');
  await writeAnswer({ ...options(), runId: 'settle', stepId: 'gate', value: true });
  // Edited source: 'return' with a new source fingerprint still reuses the committed items.
  const edited = await run('settle', definition('return'), {
    resume: true,
    fingerprint: 'return',
    acceptCodeChange: true,
  });
  expect(edited.status).toBe('completed');
  expect(edited.output).toEqual(expected);
  expect(called).not.toHaveBeenCalled();
});

it('aborts a resumed return + cancelSiblings map before scheduling after a committed failure', async () => {
  const interrupt = new AbortController();
  let first = true;
  const calls: number[] = [];
  const definition = workflow((ctx) =>
    ctx.map(
      'x',
      [0, 1],
      { concurrency: 2, onError: 'return', cancelSiblings: true },
      async (index) => {
        calls.push(index);
        if (index === 0) throw new Error('item 0 failed');
        // The map's own abort follows item 0's committed failure; then interrupt the run.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        if (first) interrupt.abort(new Error('Workflow interrupted.'));
        // Ignore the cancellation and resolve: parent cancellation never journals the item.
        return 'late';
      },
    ),
  );
  await expect(runWorkflow(definition, { ...options(), signal: interrupt.signal })).rejects.toThrow(
    'Workflow interrupted.',
  );
  const interrupted = await readRun(options());
  expect(interrupted.status).toBe('cancelled');
  expect(interrupted.maps?.['x']?.items.map((item) => item.status)).toEqual([
    'completed',
    'running',
  ]);
  expect(calls).toEqual([0, 1]);
  first = false;
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.status).toBe('completed');
  expect(resumed.output).toEqual([
    { ok: false, error: { message: 'item 0 failed', kind: 'unknown', attempts: 1, stepId: null } },
    cancelledBy(null, 0, null),
  ]);
  expect(calls).toEqual([0, 1]);
});

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
  z,
  type MapStepError,
  type Settled,
  type WorkflowContext,
} from '../src/index.js';

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

it.each(['drain', 'abort', 'settle'] as const)(
  'recovers outside a %s map without aborting the run signal',
  async (onError) => {
    const result = await runWorkflow(
      workflow(async (ctx) => {
        const runSignal = ctx.signal;
        try {
          const mapper = async (index: number) => {
            expect(ctx.signal).not.toBe(runSignal);
            return ctx.step(`item/${String(index)}`, {
              input: index,
              schema: z.number(),
              run() {
                throw new Error('item failed');
              },
            });
          };
          if (onError === 'settle') await ctx.map([0], 1, mapper, { onError, id: 'items' });
          else await ctx.map([0], 1, mapper, { onError });
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
    ctx.map([0, 1, 2, 3], 2, (index) =>
      ctx.step(`item/${String(index)}`, {
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
  expect(error).toBeInstanceOf(FanOutError);
  expect(error).toMatchObject({
    policy: 'drain',
    failures: [{ index: 0, stepId: 'item/0' }],
    unscheduled: [2, 3],
  });
  const first = await readRun(options());
  expect(first.steps['item/1']?.status).toBe('completed');
  expect(first.rootCause).toEqual({ stepId: 'item/0', error: 'primary failed' });
  broken = false;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    0, 1, 2, 3,
  ]);
  expect(work.mock.calls.map(([index]) => index)).toEqual([0, 1, 0, 2, 3]);
  expect((await readRun(options())).rootCause).toBeNull();
});

it('limits abort to its subtree and identifies cancelled siblings separately from the cause', async () => {
  const started = deferred();
  const rootFailure = new Error('A/0 failed');
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.map(['A', 'B'], 2, async (branch) => {
        if (branch === 'B')
          return ctx.step('B/0', {
            input: null,
            schema: z.string(),
            run: async ({ signal }) => {
              await delay(20);
              expect(signal.aborted).toBe(false);
              return 'B survived';
            },
          });
        try {
          await ctx.map(
            [0, 1],
            2,
            (index) =>
              ctx.step(`A/${String(index)}`, {
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
            { onError: 'abort' },
          );
        } catch (error) {
          expect(error).toBeInstanceOf(FanOutError);
          if (!(error instanceof FanOutError)) throw error;
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
  expect(result.steps['A/0']).toMatchObject({ status: 'failed', error: 'A/0 failed' });
  expect(result.steps['A/1']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'A/0',
    error: 'Map cancelled by step A/0.',
  });
  expect(result.steps['B/0']?.status).toBe('completed');
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
    ctx.map(
      [0, 1],
      2,
      async (index) => {
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
      },
      { onError: 'abort' },
    ),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('root failure');
  expect((await readRun(options())).steps['late']).toMatchObject({
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
    rootCause: { stepId: 'failure', error: 'first cause' },
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
      ctx.map([0], 1, async () => {
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
    rootCause: { stepId: 'failure', error: 'first cause' },
    steps: { a: { status: 'completed', output: 'a' } },
  });
  // The closed workflow refused the active mapper's next launch, so it never started.
  expect(saved.steps['b']).toBeUndefined();
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
      [0, 1, 2],
      2,
      async (index) => {
        called.push(index);
        if (index === 0 && broken) throw new Error('mapper body failed');
        return ctx.step(`item/${String(index)}`, {
          input: index,
          schema: z.string(),
          run: () => {
            if (index === 1 && broken) throw new Error('effect failed');
            return 'success';
          },
        });
      },
      { onError: 'settle', id: 'reviewers' },
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
      error: { message: 'effect failed', kind: 'unknown', attempts: 1, stepId: 'item/1' },
    },
    { ok: true, value: 'success' },
  ]);
  broken = false;
  const result = await runWorkflow(definition, {
    ...options(),
    resume: true,
    policy: [{ match: 'item/*', retry: { maxAttempts: 2 } }],
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
    const result = await ctx.map(
      [0],
      1,
      () =>
        ctx.map(
          [0],
          1,
          () => {
            void ctx.step('detached', { input: null, schema: z.string(), run: effect });
            return Promise.resolve('mapper');
          },
          { onError: 'settle', id: 'inner' },
        ),
      { onError: 'settle', id: 'outer' },
    );
    if (tail) throw new Error('tail');
    return result;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const saved = await readRun(options());
  expect(saved.maps?.['outer']?.items[0]).toMatchObject({
    status: 'completed',
    steps: ['detached'],
    maps: ['inner'],
  });
  tail = false;
  await runWorkflow(definition, { ...options(), resume: true });
  expect(effect).toHaveBeenCalledTimes(1);
});

it('resumes an interrupted settled map without rerunning committed items', async () => {
  const controller = new AbortController();
  const entered = deferred();
  let broken = true;
  const called: number[] = [];
  const definition = workflow((ctx) =>
    ctx.map(
      [0, 1],
      1,
      async (index) => {
        called.push(index);
        return ctx.step(`item/${String(index)}`, {
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
      { onError: 'settle', id: 'items' },
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
    rootCause: { stepId: null, error: 'Workflow interrupted.' },
    steps: { 'item/1': { status: 'cancelled', cancelledBy: null } },
  });
  expect(first.maps?.['items']?.items.map((item) => item.status)).toEqual(['completed', 'running']);
  broken = false;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    { ok: true, value: 0 },
    { ok: true, value: 1 },
  ]);
  expect(called).toEqual([0, 1, 1]);
});

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
    rootCause: { stepId: null, error: 'Workflow interrupted.' },
    steps: { late: { status: 'completed', output: 'committed' } },
  });
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toBe('committed');
  expect(callback).toHaveBeenCalledTimes(1);
});

it('does not cache an item that ignored a failed operation', async () => {
  const definition = workflow((ctx) =>
    ctx.map(
      [0],
      1,
      () => {
        void ctx.step('ignored', {
          input: null,
          schema: z.null(),
          run: () => {
            throw new Error('ignored failure');
          },
        });
        return Promise.resolve('apparently successful');
      },
      { onError: 'settle', id: 'items' },
    ),
  );
  for (const resume of [false, true])
    await expect(runWorkflow(definition, { ...options(), resume })).rejects.toThrow(
      'Unawaited workflow operation',
    );
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

it('keeps empty-map identity and path checks, and allows concurrency changes', async () => {
  let skip = false;
  let changed = false;
  let concurrency = 1;
  let tail = true;
  const mapper = (value: number) => Promise.resolve(value);
  const definition = workflow(async (ctx) => {
    if (!skip)
      await ctx.map(changed ? [1] : [], concurrency, mapper, { onError: 'settle', id: 'empty' });
    if (tail) throw new Error('tail');
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  changed = true;
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'changed after an item completed',
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
    const pending = ctx.map(
      items,
      2,
      (item) => {
        seen.push(structuredClone(item));
        return Promise.resolve(item.n);
      },
      { onError: 'settle', id: 'items' },
    );
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
    const pending = ctx.map(items, 1, async (item) => {
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

it('rejects invalid or duplicate map identities before invoking affected mappers', async () => {
  const mapper = vi.fn(() => Promise.resolve('value'));
  for (const [index, settings] of [
    { onError: 'settle' },
    { onError: 'settle', id: 'bad id' },
    { onError: 'settle', id: 'valid', version: '' },
    { onError: 'ignore' },
  ].entries()) {
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.map([0], 1, mapper, settings as never)),
        { ...options(), runId: `invalid-${String(index)}` },
      ),
    ).rejects.toThrow();
  }
  expect(mapper).not.toHaveBeenCalled();
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await ctx.map([], 1, mapper, { onError: 'settle', id: 'duplicate' });
        return ctx.map([0], 1, mapper, { onError: 'settle', id: 'duplicate' });
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
        ctx.map([0], 1, () => ctx.map([0], 1, mapper, null as never), {
          onError: 'settle',
          id: 'outer',
        }),
      ),
      options(),
    ),
  ).rejects.toThrow('Map options must be an object when provided.');
  expect(mapper).not.toHaveBeenCalled();
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('does not convert nested validation errors into saved fallback values', async () => {
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.map([0], 1, () => ctx.map([0], 0, () => Promise.resolve(null)), {
          onError: 'settle',
          id: 'outer',
        }),
      ),
      options(),
    ),
  ).rejects.toThrow('positive integer');
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('rejects authoring failures wrapped by nested draining maps', async () => {
  const definition = workflow((ctx) =>
    ctx.map(
      [0],
      1,
      () =>
        ctx.map([0], 1, () =>
          ctx.step('invalid id', { input: null, schema: z.null(), run: () => null }),
        ),
      { onError: 'settle', id: 'outer' },
    ),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('Invalid step ID');
  expect((await readRun(options())).maps?.['outer']?.items[0]?.status).toBe('running');
});

it('rejects a missing harness inside a settled map instead of journaling it', async () => {
  const definition = workflow((ctx) =>
    ctx.map([0], 1, () => ctx.claude.text('ask', { prompt: 'p' }), {
      onError: 'settle',
      id: 'items',
    }),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('No harness adapter configured');
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

it('journals a domain error that reuses the CheckpointError class as a settled outcome', async () => {
  const definition = workflow((ctx) =>
    ctx.map(
      [0],
      1,
      () =>
        ctx.step('domain', {
          input: null,
          schema: z.null(),
          run() {
            throw new CheckpointError('save', 'domain', null);
          },
        }),
      { onError: 'settle', id: 'items' },
    ),
  );
  const result = await runWorkflow(definition, options());
  expect(result.output).toEqual([
    { ok: false, error: { message: 'domain', kind: 'unknown', attempts: 1, stepId: 'domain' } },
  ]);
});

it('rejects non-JSON mapper outputs instead of committing a fallback', async () => {
  const definition = workflow((ctx) =>
    ctx.map([0], 1, () => Promise.resolve(undefined), { onError: 'settle', id: 'items' }),
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
    ctx.map(
      [0, 1],
      1,
      async (index) =>
        index === 0 ? body() : ctx.step('leaf', { input: null, schema: z.string(), run: leaf }),
      { onError: 'settle', id: 'items' },
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
  expect(result.steps['leaf']?.reusedFrom?.runId).toBe('fanout');
  expect(await readRun(options())).toEqual(original);
});

it('records cancellation during retry backoff without overwriting the failed attempt', async () => {
  const failed = deferred();
  const retried = vi.fn(() => {
    throw new Error('transient failure');
  });
  const events: string[] = [];
  const definition = workflow((ctx) =>
    ctx.map(
      [0, 1],
      2,
      (index) =>
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
      { onError: 'abort' },
    ),
  );
  await expect(
    runWorkflow(definition, {
      ...options(),
      onEvent(event) {
        events.push(`${event.type}:${event.stepId}`);
        if (event.type === 'step.failed' && event.stepId === 'backoff') failed.resolve();
      },
    }),
  ).rejects.toThrow('primary cause');
  const record = await readRun(options());
  expect(record.rootCause).toEqual({ stepId: 'primary', error: 'primary cause' });
  expect(record.steps['backoff']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'primary',
    attempts: 1,
    error: 'Map cancelled by step primary.',
    attemptHistory: [{ status: 'failed', error: 'transient failure' }],
  });
  expect(events).toContain('step.cancelled:backoff');
  expect(retried).toHaveBeenCalledTimes(1);
});

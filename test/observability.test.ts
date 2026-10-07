import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  HarnessError,
  readRun,
  runWorkflow,
  WorkflowRunError,
  z,
  type Harness,
  type WorkflowContext,
  type WorkflowEvent,
} from '../src/index.js';
import { MAX_RUN_EVENTS } from '../src/workflow/runtime/observability.js';
import { summarizeRun } from '../src/workflow/loader/inspection.js';

let stateDir: string;
const options = () => ({ stateDir, runId: 'observe', input: null });
const workflow = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'observe', version: '1', input: z.null(), output: z.unknown(), run });
const response = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.1 },
};
const unlocked = { locked: false, owner: null, processes: [], locks: [] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-observe-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('persists resolved request diagnostics, monotonic attempt timing, and validation-failure usage', async () => {
  const failedUsage = { inputTokens: 3, outputTokens: 1, costUsd: 0.04 };
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(
      new HarnessError({
        harness: 'claude',
        kind: 'rate-limit',
        exit: { code: 1, signal: null },
        failure: null,
        reason: 'retry later',
        stderr: '',
        stdout: '',
        usage: failedUsage,
      }),
    )
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce({ ...response, text: 'invalid JSON' });
  const prompt = 'p'.repeat(250);
  const run = await runWorkflow(
    defineWorkflow({
      name: 'limits',
      version: '1',
      input: z.null(),
      output: z.null(),
      defaults: { claude: { model: 'sonnet' } },
      async run(ctx) {
        ctx.phase('verify', { total: 2 });
        await ctx.claude.text('z-first', {
          prompt,
          retry: { maxAttempts: 2, delayMs: 0 },
          timeoutMs: 100,
          maxTurns: 5,
        });
        await ctx.codex.object('a-second', {
          prompt: 'structured',
          schema: z.object({ answer: z.number() }),
          onError: 'return',
        });
        return null;
      },
    }),
    {
      ...options(),
      harness: { invoke },
      policy: [{ match: 'z-first', timeoutMs: 200, maxBudgetUsd: 0.3 }],
    },
  );
  expect(run.formatVersion).toBe(7);
  expect(run.executions).toMatchObject([{ n: 1, pid: process.pid, outcome: 'completed' }]);
  const first = run.steps['z-first'];
  expect(first).toMatchObject({
    seq: 1,
    phase: 'verify',
    status: 'completed',
    request: {
      harness: 'claude',
      model: 'sonnet',
      profile: 'text',
      structured: false,
      tools: [],
      limits: { timeoutMs: 200, maxTurns: 5, maxBudgetUsd: 0.3, sandbox: null },
      promptPreview: 'p'.repeat(200),
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
    },
  });
  expect(first?.attemptHistory).toMatchObject([
    { attempt: 1, execution: 1, status: 'failed', usage: failedUsage },
    { attempt: 2, execution: 1, status: 'completed', usage: response.usage },
  ]);
  expect(first?.attemptHistory?.[0]?.errorStack).toContain('HarnessError:');
  expect(first?.errorStack).toBeNull();
  for (const attempt of first?.attemptHistory ?? []) {
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(attempt.finishedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(attempt.startedAt),
    );
  }
  expect(run.steps['a-second']).toMatchObject({
    seq: 2,
    phase: 'verify',
    status: 'settled-failed',
    request: {
      harness: 'codex',
      model: null,
      structured: true,
      limits: { maxTurns: null, maxBudgetUsd: null, sandbox: 'read-only' },
    },
    attemptHistory: [{ usage: response.usage, status: 'failed' }],
  });
  expect(summarizeRun(run, unlocked).usage).toMatchObject({
    attempts: 3,
    incompleteAttempts: 0,
    unknownTokenAttempts: 0,
    inputTokens: 23,
    outputTokens: 9,
  });
  expect((await readRun(options())).executions).toEqual(run.executions);
});

it('preserves earlier failures and kth log occurrences across resume without fingerprinting observations', async () => {
  let fail = true;
  let count = 2;
  const events: WorkflowEvent[] = [];
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(response);
  const definition = workflow(async (ctx) => {
    ctx.phase('read', { total: 1 });
    for (let i = 0; i < count; i++) ctx.log('same', { a: 1 });
    await ctx.claude.text('read', { prompt: 'fixed' });
    if (fail) throw new Error('tail', { cause: new Error('underlying') });
    return 'done';
  });
  await expect(runWorkflow(definition, { ...options(), harness: { invoke } })).rejects.toThrow(
    'tail',
  );
  const first = await readRun(options());
  fail = false;
  count = 3;
  const run = await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    resume: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(run.steps['read']?.fingerprint).toBe(first.steps['read']?.fingerprint);
  expect(run.steps['read']?.startedAt).toBe(first.steps['read']?.startedAt);
  expect(run.executions).toMatchObject([
    { n: 1, outcome: 'failed', error: 'tail' },
    { n: 2, outcome: 'completed', error: null },
  ]);
  expect(run.executions?.[0]?.errorStack).toContain('Caused by: Error: underlying');
  expect(run.errorStack).toBeNull();
  expect(
    run.events?.filter((event) => event.type === 'log').map((event) => event.execution),
  ).toEqual([1, 1, 2]);
  expect(events.filter((event) => event.type === 'log').map((event) => event.replayed)).toEqual([
    true,
    true,
    false,
  ]);
  expect(events.filter((event) => event.type === 'phase').map((event) => event.replayed)).toEqual([
    true,
  ]);
  expect(
    events.every(
      (event) =>
        event.execution === 2 && event.runId === 'observe' && Number.isFinite(Date.parse(event.at)),
    ),
  ).toBe(true);
  const fast = await runWorkflow(definition, { ...options(), harness: { invoke }, resume: true });
  expect(fast.executions).toHaveLength(2);
});

it('isolates concurrent scoped phases through maps and bound contexts, then restores the root phase', async () => {
  const ready = deferred();
  const release = deferred();
  const run = await runWorkflow(
    workflow(async (ctx) => {
      const bound = ctx.within('group');
      ctx.phase('root');
      await Promise.all([
        bound.phase(
          'left',
          async () => {
            ready.resolve();
            await release.promise;
            bound.log('inside left');
            await bound.map('items', [0, 1], { concurrency: 2 }, async () => {
              await bound.sleep('wait', 0);
            });
          },
          { total: 2 },
        ),
        ctx.phase('right', async () => {
          await ready.promise;
          await ctx.sleep('right', 0);
          release.resolve();
        }),
      ]);
      ctx.log('back at root');
      await ctx.sleep('after', 0);
      return null;
    }),
    options(),
  );
  expect(run.steps['group/items/0/wait']?.phase).toBe('left');
  expect(run.steps['group/items/1/wait']?.phase).toBe('left');
  expect(run.steps['right']?.phase).toBe('right');
  expect(run.steps['after']?.phase).toBe('root');
  expect(run.phase).toEqual({ title: 'root', total: null });
  expect(run.events?.filter((event) => event.type === 'log').map((event) => event.phase)).toEqual([
    'left',
    'root',
  ]);
});

it('captures an agent phase before asynchronous attachment resolution and phase changes', async () => {
  const image = join(stateDir, 'image.png');
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const run = await runWorkflow(
    workflow(async (ctx) => {
      ctx.phase('original');
      const call = ctx.codex.text('ask', { prompt: 'image', images: [image] });
      ctx.phase('next');
      await call;
      return null;
    }),
    { ...options(), harness: { invoke: () => Promise.resolve(response) } },
  );
  expect(run.steps['ask']?.phase).toBe('original');
});

it('drains late callback logs and keeps the original root cause by identity', async () => {
  const started = deferred();
  const failing = deferred();
  const original = new Error('same message');
  const definition = workflow(async (ctx) => {
    const late = ctx.step('late', {
      input: null,
      schema: z.string(),
      async run() {
        started.resolve();
        await failing.promise;
        await nextTurn();
        ctx.log('late result');
        return 'valid';
      },
    });
    const broken = ctx.step('root', {
      input: null,
      schema: z.null(),
      async run() {
        await started.promise;
        throw original;
      },
    });
    await Promise.all([late, broken]);
    return null;
  });
  const error: unknown = await runWorkflow(definition, {
    ...options(),
    onEvent: (event) => {
      if (event.type === 'step.failed') failing.resolve();
    },
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect(error).toMatchObject({
    runId: 'observe',
    stepId: 'root',
    cause: original,
    message: 'Step root (step) failed: same message',
  });
  const run = await readRun(options());
  expect(run.rootCause).toEqual({
    stepId: 'root',
    error: 'same message',
    errorKind: 'unknown',
    effect: 'step',
  });
  expect(run.steps['late']?.status).toBe('completed');
  expect(run.events?.some((event) => event.message === 'late result')).toBe(true);
  expect(run.errorStack).toContain('same message');
});

it('records cancellation separately from the root agent failure and retains interrupted history on resume', async () => {
  const ready = deferred();
  let started = 0;
  const invoke: Harness['invoke'] = async (request, { signal }) => {
    if (++started === 3) ready.resolve();
    await ready.promise;
    if (request.options.prompt === '1') throw new Error('primary agent');
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return response;
  };
  const definition = workflow((ctx) =>
    ctx.map('agents', [0, 1, 2], { concurrency: 3, cancelSiblings: true }, (n) =>
      ctx.claude.text('ask', { prompt: String(n) }),
    ),
  );
  // The barrier needs all three siblings admitted, including on one-slot CI defaults.
  await expect(
    runWorkflow(definition, { ...options(), agentLimit: 3, harness: { invoke } }),
  ).rejects.toThrow('Step agents/1/ask (claude) failed:');
  const first = await readRun(options());
  expect(first.rootCause?.stepId).toBe('agents/1/ask');
  expect(first.steps['agents/0/ask']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'agents/1/ask',
    attemptHistory: [{ status: 'cancelled', execution: 1 }],
  });
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    harness: { invoke: () => Promise.resolve(response) },
  });
  expect(resumed.steps['agents/0/ask']?.attemptHistory).toMatchObject([
    { status: 'cancelled', execution: 1 },
    { status: 'completed', execution: 2 },
  ]);
});

it('caps event payloads and deduplicates entries even after the original occurrence is evicted', async () => {
  let fail = true;
  const definition = workflow(async (ctx) => {
    for (let n = 0; n < MAX_RUN_EVENTS + 5; n++) ctx.log(`entry ${String(n)}`);
    await ctx.sleep('wait', 0);
    if (fail) throw new Error('retry');
    return null;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('retry');
  const first = await readRun(options());
  expect(first.events).toHaveLength(MAX_RUN_EVENTS);
  expect(first.events?.some((event) => event.message === 'entry 0')).toBe(false);
  fail = false;
  const echoed: boolean[] = [];
  const run = await runWorkflow(definition, {
    ...options(),
    resume: true,
    onEvent: (event) => {
      if (event.type === 'log') echoed.push(event.replayed ?? false);
    },
  });
  expect(echoed).toHaveLength(MAX_RUN_EVENTS + 5);
  expect(echoed.every(Boolean)).toBe(true);
  expect(Object.keys(run.eventCounts ?? {})).toHaveLength(MAX_RUN_EVENTS + 5);
  expect(run.events).toHaveLength(MAX_RUN_EVENTS);
  expect(
    run.events?.filter((event) => event.type === 'log').every((event) => event.execution === 1),
  ).toBe(true);
});

it('validates observations and owns unawaited scoped failures without suppressing later logs', async () => {
  await expect(
    runWorkflow(
      workflow((ctx) => {
        expect(() => {
          ctx.phase('');
        }).toThrow('nonempty');
        expect(() => {
          ctx.phase('bad', { total: -1 });
        }).toThrow('nonnegative');
        expect(() => {
          ctx.log('bad', undefined);
        }).not.toThrow();
        expect(() => {
          ctx.log('bad', { invalid: Infinity });
        }).toThrow('lossless JSON');
        void ctx.phase('unobserved', () => Promise.reject(new Error('phase failed')));
        return Promise.resolve(null);
      }),
      options(),
    ),
  ).rejects.toThrow('Unawaited workflow operation "phase: unobserved"');
  expect((await readRun(options())).events?.some((event) => event.type === 'run.failed')).toBe(
    true,
  );
});

const cyclic: Record<string, unknown> = {};
cyclic['self'] = cyclic;
it.each([
  [
    'a function log payload',
    'lossless JSON',
    (ctx: WorkflowContext) => {
      ctx.log('m', (() => 1) as never);
    },
  ],
  [
    'a BigInt log payload',
    'lossless JSON',
    (ctx: WorkflowContext) => {
      ctx.log('m', 1n as never);
    },
  ],
  [
    'a cyclic log payload',
    'cycles cannot be checkpointed',
    (ctx: WorkflowContext) => {
      ctx.log('m', cyclic as never);
    },
  ],
  [
    'a non-string log message',
    'must be a string',
    (ctx: WorkflowContext) => {
      ctx.log(1 as never, null);
    },
  ],
  [
    'an empty phase title',
    'nonempty',
    (ctx: WorkflowContext) => {
      ctx.phase('');
    },
  ],
  [
    'a negative phase total',
    'nonnegative',
    (ctx: WorkflowContext) => {
      ctx.phase('p', { total: -1 });
    },
  ],
  [
    'an invalid scoped phase title',
    'nonempty',
    (ctx: WorkflowContext) => ctx.phase(' ', () => Promise.resolve(null)),
  ],
  [
    'an invalid scoped phase total',
    'nonnegative',
    (ctx: WorkflowContext) => ctx.phase('p', () => Promise.resolve(null), { total: 1.5 }),
  ],
] as const)(
  'rejects %s in a settled map instead of journaling it, then reruns the item',
  async (_, message, observe) => {
    let broken = true;
    const mapper = vi.fn(async (ctx: WorkflowContext, n: number) => {
      if (broken) await observe(ctx);
      ctx.log('ok', n);
      return n;
    });
    const definition = workflow((ctx) =>
      ctx.map('items', [0], { concurrency: 1, onError: 'return' }, (n) => mapper(ctx, n)),
    );
    await expect(runWorkflow(definition, options())).rejects.toThrow(message);
    const failed = await readRun(options());
    expect(failed.status).toBe('failed');
    expect(failed.maps?.['items']?.items[0]).toMatchObject({ status: 'running', outcome: null });
    broken = false;
    const resumed = await runWorkflow(definition, { ...options(), resume: true });
    expect(resumed.output).toEqual([{ ok: true, value: 0 }]);
    expect(mapper).toHaveBeenCalledTimes(2);
  },
);

it('still settles an error thrown by a valid phase body as an item failure', async () => {
  const body = vi.fn(() => Promise.reject(new Error('body failed')));
  const definition = workflow((ctx) =>
    ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () =>
      ctx.phase('work', body, { total: 1 }),
    ),
  );
  const result = await runWorkflow(definition, options());
  expect(result.output).toEqual([
    { ok: false, error: { message: 'body failed', kind: 'unknown', attempts: 1, stepId: null } },
  ]);
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('completed');
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.output).toEqual(result.output);
  expect(body).toHaveBeenCalledTimes(1);
});

it('keeps primitive failures and format-six required metadata readable without inventing stacks', async () => {
  await expect(
    runWorkflow(
      workflow(() => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve primitive user rejections.
        return Promise.reject(null);
      }),
      options(),
    ),
  ).rejects.toMatchObject({ message: 'null' });
  const run = await readRun(options());
  expect(run.executions?.[0]).toMatchObject({ outcome: 'failed', error: 'null', errorStack: null });
  const path = join(stateDir, 'observe', 'run.json');
  const bytes = await readFile(path, 'utf8');
  for (const field of ['events', 'executions', 'eventCounts', 'phase', 'errorStack']) {
    const malformed = JSON.parse(bytes) as Record<string, unknown>;
    Reflect.deleteProperty(malformed, field);
    await writeFile(path, JSON.stringify(malformed));
    await expect(readRun(options())).rejects.toThrow('observability metadata');
  }
});

it('isolates persisted log data from observers that mutate, throw, or reject', async () => {
  const run = await runWorkflow(
    workflow(async (ctx) => {
      const data = { count: 1 };
      ctx.log('first', data);
      data.count = 99;
      ctx.log('second', { count: 2 });
      await ctx.sleep('after', 0);
      return null;
    }),
    {
      ...options(),
      onEvent(event) {
        if (event.type !== 'log') return;
        if (event.data && typeof event.data === 'object' && !Array.isArray(event.data))
          event.data['count'] = 777;
        if (event.message === 'first') throw new Error('observer threw');
        return Promise.reject(new Error('observer rejected'));
      },
    },
  );
  expect(run.events?.filter((event) => event.type === 'log').map((event) => event.data)).toEqual([
    { count: 1 },
    { count: 2 },
  ]);
  expect((await readRun(options())).status).toBe('completed');
});

async function failureEvents(
  run: (ctx: WorkflowContext) => Promise<unknown>,
  extra: { signal?: AbortSignal; runId?: string } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  await runWorkflow(workflow(run), {
    ...options(),
    ...extra,
    onEvent: (event) => {
      events.push(event);
    },
  }).catch(() => undefined);
  return events;
}

it('carries each attempt of a failing step as the error of its step.failed event', async () => {
  let calls = 0;
  const events = await failureEvents((ctx) =>
    ctx.step('flaky', {
      input: null,
      schema: z.string(),
      retry: { maxAttempts: 2, delayMs: 0 },
      run: () => {
        calls += 1;
        throw new Error(calls === 1 ? 'first' : 'second');
      },
    }),
  );
  const failed = events.filter((event) => event.type === 'step.failed');
  expect(failed.map((event) => [event.attempt, event.error])).toEqual([
    [1, 'first'],
    [2, 'second'],
  ]);
  expect(failed.every((event) => event.message === undefined)).toBe(true);
  // Other step events never carry the field.
  expect(events.filter((event) => event.error !== undefined)).toHaveLength(2);
});

it('bounds a long multi-line step error to one line of at most 500 code points without a stack', async () => {
  const long = `${'x'.repeat(600)}\n${'😀'.repeat(600)}`;
  const events = await failureEvents(async (ctx) => {
    await ctx.step('long', {
      input: null,
      schema: z.string(),
      run: () => {
        throw new Error(long);
      },
    });
  });
  const error = events.find((event) => event.type === 'step.failed')?.error ?? '';
  expect(error).not.toMatch(/\n/);
  expect(Array.from(error)).toHaveLength(500);
  expect(error.endsWith('…')).toBe(true);
  const stacked = await failureEvents(
    async (ctx) => {
      await ctx.step('stacked', {
        input: null,
        schema: z.string(),
        run: () => {
          throw new Error('boom\n    at foo (file.js:1:1)\n    at bar (file.js:2:2)');
        },
      });
    },
    { runId: 'stacked-run' },
  );
  expect(stacked.find((event) => event.type === 'step.failed')?.error).toBe('boom');
  // The record keeps the full text.
  expect((await readRun({ ...options(), runId: 'stacked-run' })).steps['stacked']?.error).toContain(
    'at foo',
  );
});

it('carries the error on step.settled for onError: return and none on step.cancelled', async () => {
  const settled = await failureEvents(async (ctx) => {
    const result = await ctx.step('soft', {
      input: null,
      schema: z.string(),
      onError: 'return',
      run: () => {
        throw new Error('soft failure');
      },
    });
    return result.ok;
  });
  expect(settled.filter((event) => event.type === 'step.failed')).toEqual([]);
  expect(settled.find((event) => event.type === 'step.settled')?.error).toBe('soft failure');

  const controller = new AbortController();
  const cancelled = await failureEvents(
    async (ctx) => {
      await ctx.step('stopped', {
        input: null,
        schema: z.string(),
        run: () => {
          controller.abort(new Error('stop'));
          throw new Error('aborted work');
        },
      });
    },
    { signal: controller.signal, runId: 'cancelled-run' },
  );
  expect(cancelled.some((event) => event.type === 'step.cancelled')).toBe(true);
  expect(cancelled.filter((event) => event.error !== undefined)).toEqual([]);
});

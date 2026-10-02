import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, expectTypeOf, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  writeAnswer,
  listPending,
  RunInterruptedError,
  z,
  type WorkflowClock,
  type PollOptions,
  type PollContext,
  type PollErrorPolicy,
  type JsonValue,
} from '../src/index.js';
import { RunActivity } from '../src/workflow/runtime/activity.js';
import { RunQuestions } from '../src/workflow/runtime/questions.js';
import { stepIdentity } from '../src/workflow/runtime/identity.js';
import { digest, jsonValue } from '../src/workflow/runtime/json.js';
import { waitRequest } from '../src/workflow/runtime/wait-schema.js';
import type { WaitSources } from '../src/workflow/runtime/wait-model.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';

class Clock implements WorkflowClock {
  public time = 1_800_000_000_000;
  public constructor(private readonly automatic = false) {}
  public now(): number {
    return this.time;
  }
  public sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (this.automatic) {
      signal.throwIfAborted();
      this.time += milliseconds;
      return Promise.resolve();
    }
    return new Promise((_resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-waits-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('records now once and replays it after a tail failure despite a changed clock', async () => {
  const clock = new Clock();
  let fail = true;
  const definition = defineWorkflow({
    name: 'now',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) => {
      const value = await ctx.now('anchor');
      if (fail) throw new Error('tail');
      return value;
    },
  });
  const options = { stateDir, runId: 'now', input: null, clock };
  const first = clock.time;
  await expect(runWorkflow(definition, options)).rejects.toThrow('tail');
  clock.time += 100_000;
  fail = false;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe(first);
  expect((await readRun(options)).steps['anchor']?.attempts).toBe(1);
});

it('parks a long timeout after a sibling completes and retains its original deadline on resume', async () => {
  const clock = new Clock();
  let calls = 0;
  const definition = defineWorkflow({
    name: 'park',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: async (ctx) => {
      const [wait, value] = await Promise.all([
        ctx.wait('ready', { timeoutMs: 10_000 }),
        ctx.step('sibling', {
          input: null,
          schema: z.number(),
          run: async () => {
            await delay(10);
            return ++calls;
          },
        }),
      ]);
      return { wait, value };
    },
  });
  const options = { stateDir, runId: 'park', input: null, clock };
  const first = await runWorkflow(definition, options);
  expect(first.status).toBe('suspended');
  expect(calls).toBe(1);
  expect(first.nextWakeAt).toBe(clock.time + 10_000);
  expect(first.steps['ready']?.wait?.checks).toBe(0);
  clock.time += 11_000;
  const second = await runWorkflow(definition, { ...options, resume: true });
  expect(second.output).toEqual({ wait: { by: 'deadline', at: clock.time, note: null }, value: 1 });
  expect(calls).toBe(1);
  expect(second.steps['ready']?.attempts).toBe(1);
});

it('keeps one bounded wait record across hundreds of nonterminal observations', async () => {
  const sizes: number[] = [];
  for (const count of [10, 200]) {
    const clock = new Clock(true);
    let checks = 0;
    const definition = defineWorkflow({
      name: 'bounded',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ready', {
          input: null,
          schema: z.object({ answer: z.number() }),
          every: 1,
          timeoutMs: 1_000_000,
          observe: () =>
            Promise.resolve(
              ++checks >= count
                ? { done: true as const, value: { answer: 42 } }
                : { done: false as const, note: { ready: false } },
            ),
        }),
    });
    const id = `n${String(count)}`;
    const run = await runWorkflow(definition, {
      stateDir,
      runId: id,
      input: null,
      clock,
      waitMode: 'block',
    });
    expect(run.status).toBe('completed');
    expect(Object.keys(run.steps)).toEqual(['ready']);
    expect(run.steps['ready']?.wait?.checks).toBe(count);
    expect(run.steps['ready']?.attempts).toBe(1);
    sizes.push((await readFile(join(stateDir, id, 'run.json'))).length);
  }
  expect(Math.abs((sizes[1] ?? 0) - (sizes[0] ?? 0))).toBeLessThan(100);
});

it.each(['signal', 'late-signal', 'late-poll'] as const)(
  'resolves %s using recorded source precedence',
  async (mode) => {
    const clock = new Clock();
    const opened = clock.time;
    let ready = false,
      observed = 0;
    const definition = defineWorkflow({
      name: 'precedence',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: async (ctx) => {
        const outcome = await ctx.wait('gate', {
          deadline: opened + 10_000,
          signal: { prompt: 'Override?', schema: z.object({ approved: z.literal(true) }) },
          poll: {
            input: null,
            schema: z.object({ passed: z.boolean() }),
            every: 30_000,
            observe: () => {
              observed++;
              return Promise.resolve(
                ready
                  ? { done: true as const, value: { passed: true } }
                  : { done: false as const, note: { pending: 1 } },
              );
            },
          },
        });
        expectTypeOf(outcome.by).toEqualTypeOf<'signal' | 'poll' | 'deadline'>();
        if (outcome.by === 'signal') expectTypeOf(outcome.value.approved).toEqualTypeOf<true>();
        if (outcome.by === 'poll') expectTypeOf(outcome.value.passed).toEqualTypeOf<boolean>();
        return outcome;
      },
    });
    const options = { stateDir, runId: mode, input: null, clock };
    expect((await runWorkflow(definition, options)).status).toBe('suspended');
    expect(observed).toBe(1);
    const pending = (await listPending({ stateDir }))[0];
    expect(pending).toMatchObject({
      kind: 'wait',
      checks: 1,
      nextCheckAt: opened + 30_000,
      deadline: opened + 10_000,
      note: { pending: 1 },
      delivery: { state: 'none', at: null, by: null },
    });
    if (mode !== 'late-poll') {
      const answer = await writeAnswer({
        ...options,
        stepId: 'gate',
        value: { approved: true },
        by: 'agent:test',
      });
      const envelope = JSON.parse(await readFile(answer.path, 'utf8')) as Record<string, unknown>;
      envelope['at'] = new Date(opened + (mode === 'signal' ? 500 : 10_001)).toISOString();
      await writeFile(answer.path, JSON.stringify(envelope));
    }
    ready = mode !== 'late-signal';
    clock.time = opened + 11_000;
    const run = await runWorkflow(definition, { ...options, resume: true });
    expect(run.output).toMatchObject({
      by: mode === 'signal' ? 'signal' : mode === 'late-poll' ? 'poll' : 'deadline',
    });
    expect(observed).toBe(mode === 'signal' ? 1 : 2);
    expect(run.steps['gate']?.attempts).toBe(1);
    expect(await listPending({ stateDir })).toEqual([]);
  },
);

it('quarantines a signal delivered after the deadline while the clock is still before it', async () => {
  const clock = new Clock();
  const opened = clock.time;
  const definition = defineWorkflow({
    name: 'late-signal-live',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.wait('gate', {
        deadline: opened + 10_000,
        signal: { prompt: 'Approve?', schema: z.object({ approved: z.literal(true) }) },
      }),
  });
  const options = { stateDir, runId: 'late-signal-live', input: null, clock };
  expect((await runWorkflow(definition, options)).status).toBe('suspended');
  const answer = await writeAnswer({
    ...options,
    stepId: 'gate',
    value: { approved: true },
    by: 'agent:test',
  });
  const envelope = JSON.parse(await readFile(answer.path, 'utf8')) as Record<string, unknown>;
  envelope['at'] = new Date(opened + 10_001).toISOString();
  await writeFile(answer.path, JSON.stringify(envelope));
  // The clock is still well before the deadline: a naive check would leave the file in place
  // and `due()` would keep waking the run every tick until the deadline finally passes.
  clock.time = opened + 500;
  const run = await runWorkflow(definition, { ...options, resume: true });
  expect(run.status).toBe('suspended');
  const step = run.steps['gate'];
  expect(step?.status).toBe('waiting');
  expect(step?.question?.rejections).toHaveLength(1);
  expect(step?.question?.rejections[0]?.error).toBe(
    'Answer was delivered after the wait deadline.',
  );
  await expect(readFile(answer.path, 'utf8')).rejects.toThrow();
  const siblings = await readdir(dirname(answer.path));
  expect(siblings.some((name) => name.includes('.rejected.'))).toBe(true);
  // Once the deadline passes, the run resolves by deadline as before.
  clock.time = opened + 11_000;
  const resolved = await runWorkflow(definition, { ...options, resume: true });
  expect(resolved.output).toMatchObject({ by: 'deadline' });
});

it('fails deadline drift on resume and keeps a pinned sleepUntil through interruption', async () => {
  const clock = new Clock();
  const pinned = clock.time + 60_000;
  const definition = defineWorkflow({
    name: 'until',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: (ctx) => ctx.sleepUntil('until', pinned),
  });
  const options = { stateDir, runId: 'until', input: null, clock };
  expect((await runWorkflow(definition, options)).status).toBe('suspended');
  const controller = new AbortController();
  controller.abort(new Error('interrupt'));
  await expect(
    runWorkflow(definition, { ...options, resume: true, signal: controller.signal }),
  ).rejects.toThrow();
  clock.time = pinned + 100;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBeNull();
  expect((await readRun(options)).steps['until']?.wait?.deadline).toBe(pinned);
  let deadline = clock.time + 60_000;
  const drifting = defineWorkflow({
    name: 'drift',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => ctx.wait('bad', { deadline }),
  });
  expect((await runWorkflow(drifting, { ...options, runId: 'drift' })).status).toBe('suspended');
  deadline++;
  await expect(runWorkflow(drifting, { ...options, runId: 'drift', resume: true })).rejects.toThrow(
    'wait changed',
  );
});

it('drains active siblings after body failure even with a blocked wait inside a map', async () => {
  const clock = new Clock();
  let finished = false;
  const definition = defineWorkflow({
    name: 'drain',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: async (ctx) => {
      await Promise.all([
        ctx.map('parked', [0], { concurrency: 1 }, () => ctx.wait('wait', { timeoutMs: 60_000 })),
        ctx.step('failing', {
          input: null,
          schema: z.null(),
          run: async () => {
            await delay(10);
            throw new Error('initiating failure');
          },
        }),
        ctx.step('sibling', {
          input: null,
          schema: z.null(),
          run: async ({ signal }) => {
            await delay(40);
            expect(signal.aborted).toBe(false);
            finished = true;
            return null;
          },
        }),
      ]);
      return null;
    },
  });
  await expect(
    runWorkflow(definition, { stateDir, runId: 'drain', input: null, clock, waitMode: 'block' }),
  ).rejects.toThrow('initiating failure');
  expect(finished).toBe(true);
  expect((await readRun({ stateDir, runId: 'drain' })).steps['sibling']?.status).toBe('completed');
});

it('rejects nested context operations in poll observers before their actions run', async () => {
  let calls = 0;
  const definition = defineWorkflow({
    name: 'nested',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('bad', {
        input: null,
        schema: z.null(),
        every: 30_000,
        timeoutMs: 60_000,
        observe: async () => {
          await ctx.step('nested', {
            input: null,
            schema: z.null(),
            run: () => {
              calls++;
              return null;
            },
          });
          return { done: true, value: null };
        },
      }),
  });
  await expect(runWorkflow(definition, { stateDir, runId: 'nested', input: null })).rejects.toThrow(
    'Nested durable',
  );
  expect(calls).toBe(0);
});

it('rejects ctx.log and ctx.phase called from inside a poll observer', async () => {
  const withLog = defineWorkflow({
    name: 'poll-log',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('bad', {
        input: null,
        schema: z.null(),
        every: 30_000,
        timeoutMs: 60_000,
        observe: () => {
          ctx.log('observed');
          return Promise.resolve({ done: true, value: null });
        },
      }),
  });
  await expect(runWorkflow(withLog, { stateDir, runId: 'poll-log', input: null })).rejects.toThrow(
    'Poll observers cannot call context operations.',
  );

  const withPhase = defineWorkflow({
    name: 'poll-phase',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('bad', {
        input: null,
        schema: z.null(),
        every: 30_000,
        timeoutMs: 60_000,
        observe: () => {
          ctx.phase('observed');
          return Promise.resolve({ done: true, value: null });
        },
      }),
  });
  await expect(
    runWorkflow(withPhase, { stateDir, runId: 'poll-phase', input: null }),
  ).rejects.toThrow('Poll observers cannot call context operations.');
});

it('fails the whole run rather than settle a poll observer context-operation violation', async () => {
  const definition = defineWorkflow({
    name: 'poll-log-settled-map',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, () =>
        ctx.poll('bad', {
          input: null,
          schema: z.null(),
          every: 30_000,
          timeoutMs: 60_000,
          observe: () => {
            ctx.log('observed');
            return Promise.resolve({ done: true, value: null });
          },
        }),
      ),
  });
  await expect(
    runWorkflow(definition, { stateDir, runId: 'poll-log-settled-map', input: null }),
  ).rejects.toThrow('Poll observers cannot call context operations.');
});

it('owns missing poll time bounds even when a JavaScript caller drops the rejected promise', async () => {
  const definition = defineWorkflow({
    name: 'invalid-poll',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: (ctx) => {
      void ctx.poll('invalid', {
        input: null,
        schema: z.null(),
        every: 1,
        observe: () => Promise.resolve({ done: false }),
      } as unknown as PollOptions<null>);
      return Promise.resolve(null);
    },
  });
  await expect(
    runWorkflow(definition, { stateDir, runId: 'invalid', input: null }),
  ).rejects.toThrow(
    'Unawaited workflow operation "invalid" failed: Poll requires timeoutMs or deadline.',
  );
  expect((await readRun({ stateDir, runId: 'invalid' })).steps).toEqual({});
});

it('keeps fractional sleeps compatible and stores each convenience call as one wait', async () => {
  const clock = new Clock(true);
  const definition = defineWorkflow({
    name: 'helpers',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: async (ctx) => {
      await ctx.sleep('fraction', 0.25);
      await ctx.sleepUntil('absolute', 1_800_000_000_100);
      await ctx.poll('poll', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 10,
        observe: () => Promise.resolve({ done: true, value: null }),
      });
      return null;
    },
  });
  const run = await runWorkflow(definition, { stateDir, runId: 'helpers', input: null, clock });
  expect(run.status).toBe('completed');
  expect(Object.keys(run.steps)).toEqual(['fraction', 'absolute', 'poll']);
  expect(
    Object.values(run.steps).every((step) => step.kind === 'wait' && step.attempts === 1),
  ).toBe(true);
  expect(run.steps['fraction']?.wait?.request.timeoutMs).toBe(0.25);
  expect(run.steps['fraction']?.wait?.deadline).toBe(1_800_000_000_001);
});

it('lets a rehearsal stub replace a poll observer with a schema-checked terminal value', async () => {
  let observed = 0;
  const stubbed: string[] = [];
  const schemas: string[] = [];
  const definition = defineWorkflow({
    name: 'stubbed-poll',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: async (ctx) => ({
      stubbed: await ctx.poll('ready', {
        input: null,
        schema: z.object({ answer: z.number() }),
        every: 1,
        timeoutMs: 1_000_000,
        observe: () => {
          observed++;
          return Promise.resolve({ done: false as const });
        },
      }),
      live: await ctx.poll('live', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1_000_000,
        observe: () => {
          observed++;
          return Promise.resolve({ done: true as const, value: null });
        },
      }),
    }),
  });
  const run = await runWorkflow(definition, {
    stateDir,
    runId: 'stubbed-poll',
    input: null,
    clock: new Clock(),
    harness: { kind: 'dry-run', invoke: () => Promise.reject(new Error('no agents')) },
    rehearsal: {
      localStep: (id) => {
        if (id !== 'ready') return undefined;
        stubbed.push(id);
        return { output: { answer: 7 } };
      },
      onSchema: (id) => {
        schemas.push(id);
      },
    },
  });
  expect(run.status).toBe('completed');
  expect(run.output).toMatchObject({ stubbed: { by: 'poll', value: { answer: 7 } } });
  expect(stubbed).toEqual(['ready']);
  expect(schemas).toEqual(['ready', 'live']);
  expect(observed).toBe(1);
});

/** Collect unhandled rejections for the duration of `action`, after one more macrotask. */
async function unhandledDuring(action: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await action();
    await delay(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}

/** An observer outcome that only settles, by rejecting, when its signal aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<{ done: true; value: null }> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

it('aborts a pending observation at the wait deadline and keeps the last note', async () => {
  let checks = 0;
  let captured: AbortSignal | undefined;
  const definition = defineWorkflow({
    name: 'deadline-abort',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('ready', {
        input: null,
        schema: z.null(),
        every: 50,
        timeoutMs: 300,
        observeTimeoutMs: 10_000,
        observe: ({ signal }) => {
          if (++checks === 1) return Promise.resolve({ done: false as const, note: { n: 1 } });
          captured = signal;
          return rejectOnAbort(signal);
        },
      }),
  });
  let elapsed = 0;
  let run: Awaited<ReturnType<typeof runWorkflow>> | undefined;
  const unhandled = await unhandledDuring(async () => {
    const started = Date.now();
    run = await runWorkflow(definition, { stateDir, runId: 'deadline-abort', input: null });
    elapsed = Date.now() - started;
  });
  const deadline = run?.steps['ready']?.wait?.deadline ?? Number.POSITIVE_INFINITY;
  expect(run?.output).toMatchObject({ by: 'deadline', note: { n: 1 } });
  expect((run?.output as { at: number }).at).toBeGreaterThanOrEqual(deadline);
  expect(checks).toBe(2);
  expect(captured?.aborted).toBe(true);
  expect(elapsed).toBeLessThan(2000);
  expect(run?.warnings).toBeUndefined();
  expect(unhandled).toEqual([]);
});

it(
  'abandons an observer that ignores its aborted signal after a bounded grace with a run warning',
  // measured: 2.3 s alone, 2.4 s in the full coverage run (300 ms deadline + fixed 2 s grace)
  { timeout: 10_000 },
  async () => {
    let checks = 0;
    const definition = defineWorkflow({
      name: 'abandon',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ready', {
          input: null,
          schema: z.null(),
          every: 50,
          timeoutMs: 300,
          observe: () =>
            ++checks === 1
              ? Promise.resolve({ done: false as const, note: { n: 1 } })
              : new Promise<never>(() => undefined),
        }),
    });
    const options = { stateDir, runId: 'abandon', input: null };
    let elapsed = 0;
    let run: Awaited<ReturnType<typeof runWorkflow>> | undefined;
    const unhandled = await unhandledDuring(async () => {
      const started = Date.now();
      run = await runWorkflow(definition, options);
      elapsed = Date.now() - started;
    });
    const warning =
      'Poll observer for wait ready did not settle within 2000ms after its signal was aborted (deadline); abandoned.';
    expect(run?.output).toMatchObject({ by: 'deadline', note: { n: 1 } });
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(4000);
    expect(run?.warnings).toEqual([warning]);
    expect((await readRun(options)).waitWarnings).toEqual([warning]);
    expect(unhandled).toEqual([]);
  },
);

it.each([
  ['a plain abort', new Error('stop'), 'cancelled'],
  ['a RunInterruptedError', new RunInterruptedError('Worker shutting down.'), 'suspended'],
] as const)(
  'interrupting a run with a signal-ignoring observer returns within the grace (%s)',
  // measured: 2.1 s alone, 2.1 s in the full coverage run (the fixed 2 s observer grace)
  { timeout: 10_000 },
  async (_name, reason, status) => {
    let checks = 0;
    let entered!: () => void;
    const hung = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let captured: AbortSignal | undefined;
    const definition = defineWorkflow({
      name: 'interrupt-hung',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ready', {
          input: null,
          schema: z.null(),
          every: 50,
          timeoutMs: 60_000,
          observe: ({ signal }) => {
            if (++checks === 1) return Promise.resolve({ done: false as const });
            captured = signal;
            entered();
            return new Promise<never>(() => undefined);
          },
        }),
    });
    const controller = new AbortController();
    const options = { stateDir, runId: `interrupt-${status}`, input: null };
    const running = runWorkflow(definition, { ...options, signal: controller.signal });
    await hung;
    const started = Date.now();
    controller.abort(reason);
    await expect(running).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000);
    expect(captured?.aborted).toBe(true);
    const saved = await readRun(options);
    expect(saved.status).toBe(status);
    if (status === 'suspended') expect(saved.interruptedBy?.reason).toBe('Worker shutting down.');
    expect(saved.waitWarnings).toEqual([
      'Poll observer for wait ready did not settle within 2000ms after its signal was aborted (run cancelled); abandoned.',
    ]);
    expect(saved.steps['ready']?.wait?.checks).toBe(2);
  },
);

it('fails a wait whose observation exceeds observeTimeoutMs before the deadline', async () => {
  let captured: AbortSignal | undefined;
  const definition = defineWorkflow({
    name: 'observe-timeout',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('ready', {
        input: null,
        schema: z.null(),
        every: 50,
        timeoutMs: 10_000,
        observeTimeoutMs: 200,
        observe: ({ signal }) => {
          captured = signal;
          return rejectOnAbort(signal);
        },
      }),
  });
  const options = { stateDir, runId: 'observe-timeout', input: null };
  const started = Date.now();
  await expect(runWorkflow(definition, options)).rejects.toThrow(
    'Wait ready: poll observation did not settle within observeTimeoutMs (200ms).',
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(captured?.aborted).toBe(true);
  const saved = await readRun(options);
  expect(saved.status).toBe('failed');
  expect(saved.steps['ready']?.error).toContain('observeTimeoutMs');
  expect(saved.waitWarnings).toBeUndefined();
});

it('bounds the final check after a missed deadline and then resolves by deadline', async () => {
  let captured: AbortSignal | undefined;
  const definition = defineWorkflow({
    name: 'final-check',
    version: '1',
    input: z.number(),
    output: z.unknown(),
    run: (ctx, deadline) =>
      ctx.poll('ready', {
        input: null,
        schema: z.null(),
        every: 50,
        deadline,
        observeTimeoutMs: 100,
        observe: ({ signal }) => {
          captured = signal;
          return rejectOnAbort(signal);
        },
      }),
  });
  const started = Date.now();
  const run = await runWorkflow(definition, {
    stateDir,
    runId: 'final-check',
    input: started - 1000,
  });
  expect(run.output).toMatchObject({ by: 'deadline', note: null });
  expect(run.steps['ready']?.wait?.checks).toBe(1);
  expect(captured?.aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
});

it('keeps observeTimeoutMs out of wait identity and validates it', async () => {
  const clock = new Clock();
  let ready = false;
  const definition = (observeTimeoutMs: number) =>
    defineWorkflow({
      name: 'observe-policy',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ready', {
          input: null,
          schema: z.null(),
          every: 30_000,
          timeoutMs: 600_000,
          observeTimeoutMs,
          observe: () =>
            Promise.resolve(
              ready ? { done: true as const, value: null } : { done: false as const },
            ),
        }),
    });
  const options = { stateDir, runId: 'observe-policy', input: null, clock };
  const first = await runWorkflow(definition(1_000), options);
  expect(first.status).toBe('suspended');
  const request = first.steps['ready']?.wait?.request.poll;
  expect(Object.keys(request ?? {}).sort()).toEqual(['every', 'input', 'observe', 'schema']);
  expect(await readFile(join(stateDir, 'observe-policy', 'run.json'), 'utf8')).not.toContain(
    'observeTimeoutMs',
  );
  const fingerprint = first.steps['ready']?.fingerprint;
  clock.time += 31_000;
  ready = true;
  const resumed = await runWorkflow(definition(5_000), { ...options, resume: true });
  expect(resumed.output).toMatchObject({ by: 'poll', value: null, checks: 2 });
  expect(resumed.steps['ready']?.fingerprint).toBe(fingerprint);
  for (const [index, invalid] of [0, 1.5].entries())
    await expect(
      runWorkflow(definition(invalid), { ...options, runId: `invalid-${String(index)}` }),
    ).rejects.toThrow('Poll observeTimeoutMs must be a positive integer.');
});

it('keeps the persisted request and identity of an existing observer-form poll', () => {
  // new Function keeps the observer's source text out of the test transform, so the golden values
  // below (computed before poll policy options existed) stay stable across esbuild/vitest bumps.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fixed source, see above
  const build = new Function('return async () => ({ done: false })') as () => NonNullable<
    WaitSources['poll']
  >['observe'];
  const observe = build();
  const poll = {
    input: { pr: 128 },
    schema: z.object({ passed: z.boolean() }),
    every: { initialMs: 1_000, maxMs: 60_000 },
    observe,
  };
  const golden = (sources: WaitSources): { request: string; fingerprint: string } => {
    const { request } = waitRequest(sources);
    return {
      request: JSON.stringify(request),
      fingerprint: digest(
        stepIdentity({ kind: 'wait', request: jsonValue(request), signal: null }),
      ),
    };
  };
  const expected = {
    request: JSON.stringify({
      timeoutMs: 600_000,
      deadline: null,
      poll: {
        input: { pr: 128 },
        schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          additionalProperties: false,
          properties: { passed: { type: 'boolean' } },
          required: ['passed'],
          type: 'object',
        },
        every: { initialMs: 1000, maxMs: 60000, factor: 2 },
        observe: 'cf2042aca0faefb5aa4e7b3034331123b7e7b4c1f3ac54c212d19d18505a2c97',
      },
    }),
    fingerprint: '419abf41102926b453176c97c1735c5f39a27c6744388d74f9caee5da4dcc0fc',
  };
  expect(golden({ timeoutMs: 600_000, poll })).toEqual(expected);
  // Policy options never enter identity.
  expect(
    golden({
      timeoutMs: 600_000,
      poll: {
        ...poll,
        observeTimeoutMs: 5_000,
        onError: { tolerate: 3, classify: () => 'transient', retryAfterMs: () => null },
      },
    }),
  ).toEqual(expected);
});

/** A bare RunQuestions over an in-memory record, for close() paths the runner rarely reaches. */
function bareQuestions(save: () => Promise<void>): {
  questions: RunQuestions;
  warnings: string[];
  record: RunRecord;
} {
  const warnings: string[] = [];
  const record = { id: 'bare', cwd: stateDir, steps: {} } as unknown as RunRecord;
  const questions = new RunQuestions({
    record,
    stateDir,
    activity: new RunActivity(),
    save,
    beforeLive: () => Promise.resolve(),
    nextSeq: () => 0,
    warn: (message) => {
      warnings.push(message);
    },
    emit: () => undefined,
    fail: () => undefined,
  });
  return { questions, warnings, record };
}

it(
  'close() aborts an in-flight observation and abandons it after the grace',
  // measured: 2.0 s alone, 2.0 s in the full coverage run (the fixed 2 s observer grace)
  { timeout: 10_000 },
  async () => {
    const { questions, warnings, record } = bareQuestions(() => Promise.resolve());
    let entered!: () => void;
    const hung = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let captured: AbortSignal | undefined;
    void questions.wait(
      'w',
      {
        timeoutMs: 60_000,
        poll: {
          input: null,
          schema: z.null(),
          every: 50,
          observe: ({ signal }) => {
            captured = signal;
            entered();
            return new Promise<never>(() => undefined);
          },
        },
      },
      null,
      new AbortController().signal,
    );
    await hung;
    const started = Date.now();
    await questions.close();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(captured?.aborted).toBe(true);
    expect(warnings).toEqual([
      'Poll observer for wait w did not settle within 2000ms after its signal was aborted (run closing); abandoned.',
    ]);
    expect(record.steps['w']?.status).toBe('waiting');
    // A second close is the same settled promise and records nothing new.
    await questions.close();
    expect(warnings).toHaveLength(1);
  },
);

it(
  'close() abandons a scan stalled outside the observer after a backstop',
  // measured: 2.3 s alone, 2.3 s in the full coverage run (2 s grace + 250 ms close margin)
  { timeout: 10_000 },
  async () => {
    let saves = 0;
    let stalled!: () => void;
    const stall = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    const { questions, warnings } = bareQuestions(() => {
      // The first save opens the wait; the second, recording progress, never settles.
      if (++saves === 1) return Promise.resolve();
      stalled();
      return new Promise<never>(() => undefined);
    });
    void questions.wait(
      'w',
      {
        timeoutMs: 60_000,
        poll: {
          input: null,
          schema: z.null(),
          every: 50,
          observe: () => Promise.resolve({ done: false as const }),
        },
      },
      null,
      new AbortController().signal,
    );
    await stall;
    const started = Date.now();
    await questions.close();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(4000);
    expect(warnings).toEqual([
      'Wait scan did not settle within 2250ms of the run closing; abandoned.',
    ]);
  },
);

/** A poll workflow whose observer is `observe`; onError and timing vary per test. */
function policyPoll(
  name: string,
  observe: (
    context: PollContext,
  ) => Promise<{ done: true; value: string } | { done: false; note?: JsonValue }>,
  options: { onError?: PollErrorPolicy; every?: number; timeoutMs?: number } = {},
) {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('ready', {
        input: null,
        schema: z.literal('ok'),
        every: options.every ?? 30_000,
        timeoutMs: options.timeoutMs ?? 600_000,
        ...('onError' in options ? { onError: options.onError } : {}),
        observe: (context) => observe(context) as Promise<{ done: true; value: 'ok' }>,
      }),
  });
}

it('tolerates a single observation error, shows it in pending and clears it on success', async () => {
  const clock = new Clock();
  const opened = clock.time;
  let calls = 0;
  const definition = policyPoll(
    'tolerate-once',
    () => {
      calls++;
      if (calls === 1) return Promise.resolve({ done: false, note: { n: 1 } });
      if (calls === 2) return Promise.reject(new Error('HTTP 502: Bad Gateway'));
      return Promise.resolve({ done: true, value: 'ok' });
    },
    { onError: { tolerate: 3 } },
  );
  const options = { stateDir, runId: 'tolerate-once', input: null, clock };
  expect((await runWorkflow(definition, options)).status).toBe('suspended');
  clock.time += 31_000;
  const second = await runWorkflow(definition, { ...options, resume: true });
  expect(second.status).toBe('suspended');
  const failedAt = clock.time;
  // The pending projection is what `workflow pending --json` prints.
  expect(await listPending({ stateDir })).toEqual([
    expect.objectContaining({
      stepId: 'ready',
      checks: 2,
      note: { n: 1 },
      lastError: { message: 'HTTP 502: Bad Gateway', consecutive: 1, at: failedAt },
      nextCheckAt: failedAt + 30_000,
      deadline: opened + 600_000,
      // A poll-only wait accepts no answer, so it has no delivery state.
      runStatus: 'suspended',
      delivery: null,
    }),
  ]);
  // The additive field survives the suspension's write and re-read.
  expect((await readRun(options)).steps['ready']?.wait?.lastError).toEqual({
    message: 'HTTP 502: Bad Gateway',
    consecutive: 1,
    at: failedAt,
  });
  clock.time += 31_000;
  const done = await runWorkflow(definition, { ...options, resume: true });
  expect(done.output).toMatchObject({ by: 'poll', value: 'ok', checks: 3 });
  expect(done.steps['ready']?.wait).not.toHaveProperty('lastError');
  expect(done.steps['ready']?.error).toBeNull();
  expect(calls).toBe(3);
});

it('fails with the error after the tolerated count, even across a suspension', async () => {
  // In one blocked run.
  let calls = 0;
  const failing = policyPoll(
    'tolerate-exceeded',
    () => Promise.reject(new Error(`HTTP 502 #${String(++calls)}`)),
    { onError: { tolerate: 3 }, every: 1, timeoutMs: 1_000_000 },
  );
  const blocked = { stateDir, runId: 'tolerate-exceeded', input: null, clock: new Clock(true) };
  await expect(runWorkflow(failing, { ...blocked, waitMode: 'block' })).rejects.toThrow(
    'HTTP 502 #4',
  );
  expect(calls).toBe(4);
  const saved = await readRun(blocked);
  expect(saved.status).toBe('failed');
  expect(saved.steps['ready']?.error).toBe('HTTP 502 #4');
  expect(saved.steps['ready']?.wait?.checks).toBe(4);

  // The count persists across suspensions: each resume below runs one failing check.
  const clock = new Clock();
  let count = 0;
  const definition = policyPoll(
    'tolerate-resumed',
    () => Promise.reject(new Error(`HTTP 503 #${String(++count)}`)),
    { onError: { tolerate: 3 } },
  );
  const options = { stateDir, runId: 'tolerate-resumed', input: null, clock };
  expect((await runWorkflow(definition, options)).status).toBe('suspended');
  for (const consecutive of [2, 3]) {
    clock.time += 31_000;
    expect((await runWorkflow(definition, { ...options, resume: true })).status).toBe('suspended');
    expect((await readRun(options)).steps['ready']?.wait?.lastError).toMatchObject({
      message: `HTTP 503 #${String(consecutive)}`,
      consecutive,
    });
  }
  clock.time += 31_000;
  await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
    'HTTP 503 #4',
  );
  expect(count).toBe(4);
});

it('fails at once when classify says fatal, throws, or returns something else', async () => {
  const cases = [
    ['fatal', () => 'fatal' as const, 'HTTP 404'],
    [
      'throws',
      () => {
        throw new Error('classify broke');
      },
      'classify broke',
    ],
    [
      'invalid',
      () => 'maybe' as 'fatal',
      "Wait ready: onError.classify must return 'transient' or 'fatal'.",
    ],
  ] as const;
  for (const [name, classify, message] of cases) {
    let calls = 0;
    const definition = policyPoll(
      `classify-${name}`,
      () => {
        calls++;
        return Promise.reject(new Error('HTTP 404'));
      },
      { onError: { tolerate: 3, classify }, every: 1 },
    );
    const options = { stateDir, runId: `classify-${name}`, input: null, clock: new Clock(true) };
    await expect(runWorkflow(definition, { ...options, waitMode: 'block' })).rejects.toThrow(
      message,
    );
    expect(calls).toBe(1);
    expect((await readRun(options)).steps['ready']?.wait).not.toHaveProperty('lastError');
  }
});

it.each([
  ['a plain abort', new Error('stop'), 'cancelled'],
  ['a RunInterruptedError', new RunInterruptedError('Worker shutting down.'), 'suspended'],
] as const)('never tolerates a run-signal abort (%s)', async (_name, reason, status) => {
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let classified = 0;
  const definition = policyPoll(
    'abort-not-tolerated',
    ({ signal }) => {
      entered();
      return rejectOnAbort(signal) as Promise<never>;
    },
    {
      onError: {
        tolerate: 3,
        classify: () => {
          classified++;
          return 'transient';
        },
      },
    },
  );
  const controller = new AbortController();
  const options = { stateDir, runId: `abort-${status}`, input: null, clock: new Clock() };
  const running = runWorkflow(definition, { ...options, signal: controller.signal });
  await inFlight;
  controller.abort(reason);
  await expect(running).rejects.toThrow();
  const saved = await readRun(options);
  expect(saved.status).toBe(status);
  expect(classified).toBe(0);
  expect(saved.steps['ready']?.wait).not.toHaveProperty('lastError');
  expect(saved.steps['ready']?.wait?.checks).toBe(1);
});

it('schedules the next check from retryAfterMs, falls back to spacing on null, and validates it', async () => {
  const opened = new Clock().time;
  const pendingAfter = async (runId: string, retryAfterMs: () => number | null) => {
    const definition = policyPoll(runId, () => Promise.reject(new Error('rate limited')), {
      onError: { tolerate: 3, retryAfterMs },
    });
    return runWorkflow(definition, { stateDir, runId, input: null, clock: new Clock() });
  };
  const delayed = await pendingAfter('retry-delayed', () => 12_345);
  expect(delayed.status).toBe('suspended');
  expect(delayed.steps['ready']?.wait?.nextCheckAt).toBe(opened + 12_345);
  const spaced = await pendingAfter('retry-null', () => null);
  expect(spaced.steps['ready']?.wait?.nextCheckAt).toBe(opened + 30_000);
  for (const [index, invalid] of [-1, Number.NaN, Number.POSITIVE_INFINITY].entries())
    await expect(pendingAfter(`retry-invalid-${String(index)}`, () => invalid)).rejects.toThrow(
      'Wait ready: onError.retryAfterMs must return null or a finite number of at least 0.',
    );
});

it('tolerates an observeTimeoutMs expiry, which classify sees by its code', async () => {
  let calls = 0;
  const codes: unknown[] = [];
  const definition = defineWorkflow({
    name: 'observe-timeout-tolerated',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      ctx.poll('ready', {
        input: null,
        schema: z.null(),
        every: 50,
        timeoutMs: 10_000,
        observeTimeoutMs: 200,
        onError: {
          tolerate: 1,
          classify: (error) => {
            codes.push((error as { code?: unknown }).code);
            return 'transient';
          },
        },
        observe: ({ signal }) =>
          ++calls === 1 ? rejectOnAbort(signal) : Promise.resolve({ done: true, value: null }),
      }),
  });
  const options = { stateDir, runId: 'observe-timeout-tolerated', input: null };
  const run = await runWorkflow(definition, options);
  expect(run.output).toMatchObject({ by: 'poll', value: null, checks: 2 });
  expect(codes).toEqual(['QUIET_CHOIR_POLL_OBSERVE_TIMEOUT']);
  expect(run.warnings).toBeUndefined();
});

it('keeps the deadline and identity through tolerated errors and a changed onError', async () => {
  const clock = new Clock();
  let calls = 0;
  const definition = (onError: PollErrorPolicy) =>
    policyPoll(
      'policy-identity',
      () =>
        ++calls === 1
          ? Promise.resolve({ done: false, note: { n: 1 } })
          : Promise.reject(new Error('flaky')),
      { onError },
    );
  const options = { stateDir, runId: 'policy-identity', input: null, clock };
  const first = await runWorkflow(definition({ tolerate: 3 }), options);
  const { deadline } = first.steps['ready']?.wait ?? {};
  const fingerprint = first.steps['ready']?.fingerprint;
  clock.time += 31_000;
  const tolerated = await runWorkflow(definition({ tolerate: 3 }), { ...options, resume: true });
  expect(tolerated.status).toBe('suspended');
  expect(tolerated.steps['ready']?.wait?.deadline).toBe(deadline);
  expect(tolerated.steps['ready']?.fingerprint).toBe(fingerprint);
  clock.time += 31_000;
  const changed = await runWorkflow(
    definition({ tolerate: 5, classify: () => 'transient', retryAfterMs: () => null }),
    { ...options, resume: true },
  );
  expect(changed.status).toBe('suspended');
  expect(changed.steps['ready']?.fingerprint).toBe(fingerprint);
  expect(changed.steps['ready']?.wait?.deadline).toBe(deadline);
  expect(changed.steps['ready']?.wait?.lastError?.consecutive).toBe(2);
  const bytes = await readFile(join(stateDir, 'policy-identity', 'run.json'), 'utf8');
  expect(bytes).not.toContain('onError');
  expect(bytes).not.toContain('tolerate');
  // A tolerated error on the final check after a missed deadline still resolves by deadline.
  clock.time += 600_000;
  const late = await runWorkflow(definition({ tolerate: 5 }), { ...options, resume: true });
  expect(late.output).toEqual({ by: 'deadline', at: clock.time, note: { n: 1 } });
  expect(late.steps['ready']?.wait?.checks).toBe(4);
});

it('lets the deadline win over an observer that always fails', async () => {
  let calls = 0;
  const definition = policyPoll(
    'deadline-wins',
    () => {
      calls++;
      return Promise.reject(new Error('down'));
    },
    { onError: { tolerate: 100 }, every: 100, timeoutMs: 1_000 },
  );
  const run = await runWorkflow(definition, {
    stateDir,
    runId: 'deadline-wins',
    input: null,
    clock: new Clock(true),
    waitMode: 'block',
  });
  expect(run.output).toMatchObject({ by: 'deadline', note: null });
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThan(100);
  expect(run.steps['ready']?.wait?.lastError?.consecutive).toBe(calls);
});

it('passes the persisted previous note and check count to each observation', async () => {
  const clock = new Clock();
  const seen: PollContext['previous'][] = [];
  const mutations: boolean[] = [];
  const definition = policyPoll(
    'previous',
    ({ previous }) => {
      seen.push(previous);
      const note = previous.note as { nested: { k: number } } | null;
      if (note)
        try {
          note.nested.k = 99;
          mutations.push(true);
        } catch {
          mutations.push(false);
        }
      return Promise.resolve(
        previous.checks === 0
          ? { done: false, note: { n: 1, nested: { k: 1 } } }
          : { done: true, value: 'ok' },
      );
    },
    { onError: { tolerate: 1 } },
  );
  const options = { stateDir, runId: 'previous', input: null, clock };
  const first = await runWorkflow(definition, options);
  const openedAt = first.steps['ready']?.wait?.openedAt;
  expect(seen).toEqual([{ note: null, checks: 0, openedAt }]);
  clock.time += 31_000;
  const done = await runWorkflow(definition, { ...options, resume: true });
  expect(done.output).toMatchObject({ by: 'poll', checks: 2 });
  expect(seen[1]).toEqual({ note: { n: 1, nested: { k: 1 } }, checks: 1, openedAt });
  expect(Object.isFrozen(seen[1])).toBe(true);
  expect(mutations).toEqual([false]);
  expect((await readRun(options)).steps['ready']?.wait?.note).toEqual({ n: 1, nested: { k: 1 } });

  const oversized = policyPoll(
    'oversized',
    () => Promise.resolve({ done: false, note: 'x'.repeat(20_000) }),
    { onError: { tolerate: 3 } },
  );
  await expect(
    runWorkflow(oversized, { stateDir, runId: 'oversized', input: null, clock }),
  ).rejects.toThrow('Poll note exceeds 16 KiB');
});

/** An observation that always fails, typed to fit any poll. */
const rejectFlaky = (): Promise<never> => Promise.reject(new Error('flaky'));

it('never tolerates authoring errors, and guards classify and retryAfterMs like observers', async () => {
  const onError = { tolerate: 3 };
  interface Options {
    stateDir: string;
    runId: string;
    input: null;
    clock: Clock;
  }
  const cases: [string, (options: Options) => Promise<unknown>, string][] = [
    [
      'log',
      (options) =>
        runWorkflow(
          defineWorkflow({
            name: 'log',
            version: '1',
            input: z.null(),
            output: z.unknown(),
            run: (ctx) =>
              ctx.poll('ready', {
                input: null,
                schema: z.null(),
                every: 30_000,
                timeoutMs: 60_000,
                onError,
                observe: () => {
                  ctx.log('observed');
                  return Promise.resolve({ done: true, value: null });
                },
              }),
          }),
          options,
        ),
      'Poll observers cannot call context operations.',
    ],
    [
      'nested',
      (options) =>
        runWorkflow(
          defineWorkflow({
            name: 'nested',
            version: '1',
            input: z.null(),
            output: z.unknown(),
            run: (ctx) =>
              ctx.poll('ready', {
                input: null,
                schema: z.null(),
                every: 30_000,
                timeoutMs: 60_000,
                onError,
                observe: async () => {
                  await ctx.step('inner', { input: null, schema: z.null(), run: () => null });
                  return { done: true, value: null };
                },
              }),
          }),
          options,
        ),
      'Nested durable',
    ],
    [
      'shape',
      (options) =>
        runWorkflow(
          policyPoll('shape', () => Promise.resolve(42 as never), { onError }),
          options,
        ),
      'Wait ready: observe must return {done:true,value} or {done:false,note?}.',
    ],
    [
      'schema',
      (options) =>
        runWorkflow(
          policyPoll('schema', () => Promise.resolve({ done: true, value: 'nope' }), { onError }),
          options,
        ),
      'Invalid input',
    ],
    ...(['classify', 'retryAfterMs'] as const).map(
      (hook): [string, (options: Options) => Promise<unknown>, string] => [
        hook,
        (options) =>
          runWorkflow(
            defineWorkflow({
              name: hook,
              version: '1',
              input: z.null(),
              output: z.unknown(),
              run: (ctx) =>
                ctx.poll('ready', {
                  input: null,
                  schema: z.null(),
                  every: 30_000,
                  timeoutMs: 60_000,
                  onError: {
                    tolerate: 3,
                    [hook]: () => {
                      ctx.log('from policy');
                      return null;
                    },
                  },
                  observe: rejectFlaky,
                }),
            }),
            options,
          ),
        'Poll observers cannot call context operations.',
      ],
    ),
  ];
  for (const [name, run, message] of cases) {
    const options = { stateDir, runId: `authoring-${name}`, input: null, clock: new Clock() };
    await expect(run(options), name).rejects.toThrow(message);
    const saved = await readRun(options);
    expect(saved.status, name).toBe('failed');
    expect(saved.steps['ready']?.wait, name).not.toHaveProperty('lastError');
  }
});

it('validates onError', async () => {
  const invalid: [unknown, string][] = [
    [null, 'Poll onError must be an object.'],
    [3, 'Poll onError must be an object.'],
    [[], 'Poll onError must be an object.'],
    [{}, 'Poll onError.tolerate must be a positive integer.'],
    [{ tolerate: 0 }, 'Poll onError.tolerate must be a positive integer.'],
    [{ tolerate: 1.5 }, 'Poll onError.tolerate must be a positive integer.'],
    [{ tolerate: 1, classify: 'transient' }, 'Poll onError.classify must be a function.'],
    [{ tolerate: 1, retryAfterMs: 5 }, 'Poll onError.retryAfterMs must be a function.'],
  ];
  for (const [index, [onError, message]] of invalid.entries()) {
    const definition = policyPoll(
      'invalid-on-error',
      () => Promise.resolve({ done: true, value: 'ok' }),
      {
        onError: onError as PollErrorPolicy,
      },
    );
    await expect(
      runWorkflow(definition, {
        stateDir,
        runId: `invalid-on-error-${String(index)}`,
        input: null,
      }),
    ).rejects.toThrow(message);
  }
});

it('types the poll context and the onError policy', () => {
  type Previous = PollContext<{ seenComplete: boolean }>['previous'];
  expectTypeOf<Previous['note']>().toEqualTypeOf<{ seenComplete: boolean } | null>();
  expectTypeOf<Previous['checks']>().toEqualTypeOf<number>();
  expectTypeOf<Previous['openedAt']>().toEqualTypeOf<number>();
  expectTypeOf<PollContext<{ seenComplete: boolean }>>().toExtend<Omit<PollContext, 'previous'>>();
  expectTypeOf<ReturnType<NonNullable<PollErrorPolicy['classify']>>>().toEqualTypeOf<
    'transient' | 'fatal'
  >();
  expectTypeOf<{ tolerate: 3 }>().toExtend<PollErrorPolicy>();
  expectTypeOf({
    tolerate: 3,
    classify: () => 'transient' as const,
    retryAfterMs: () => 1_000,
  }).toExtend<PollErrorPolicy>();
  defineWorkflow({
    name: 'types',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: async (ctx) => {
      await ctx.poll('default', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        onError: { tolerate: 3 },
        observe: (context) => {
          expectTypeOf(context).toEqualTypeOf<PollContext>();
          return Promise.resolve({ done: true, value: null });
        },
      });
      await ctx.poll<null, { seenComplete: boolean }>('typed', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        onError: { tolerate: 3, classify: () => 'fatal', retryAfterMs: () => null },
        observe: ({ previous }) => {
          expectTypeOf(previous.note).toEqualTypeOf<{ seenComplete: boolean } | null>();
          return Promise.resolve({ done: false, note: { seenComplete: true } });
        },
      });
      await ctx.poll('missing-tolerate', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        // @ts-expect-error tolerate is required
        onError: { classify: () => 'fatal' },
        observe: () => Promise.resolve({ done: true, value: null }),
      });
      await ctx.poll('string-classify', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        // @ts-expect-error classify returns 'transient' or 'fatal' only
        onError: { tolerate: 3, classify: (): string => 'retry' },
        observe: () => Promise.resolve({ done: true, value: null }),
      });
      return null;
    },
  });
});

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  writeAnswer,
  listPending,
  RunInterruptedError,
  WorkflowRunError,
  z,
  type WorkflowClock,
  type PollOptions,
  type PollContext,
  type PollErrorPolicy,
  type PollSource,
  type JsonValue,
  type Command,
  type CommandPollSource,
  type RunEvent,
  type WorkflowEvent,
} from '../src/index.js';
import { RunActivity } from '../src/workflow/runtime/activity.js';
import { answerCandidates } from '../src/workflow/runtime/inbox.js';
import { RunQuestions } from '../src/workflow/runtime/questions.js';
import { stepIdentity } from '../src/workflow/runtime/identity.js';
import { digest, jsonValue } from '../src/workflow/runtime/json.js';
import { waitRequest } from '../src/workflow/runtime/wait-schema.js';
import { commandPollIdentity } from '../src/workflow/runtime/poll-command.js';
import { recordEventLines } from '../src/workflow/loader/event-follow.js';
import { pollIdentityKey } from '../src/workflow/runtime/poll-identity.js';
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

describe('internal helper poll identity', () => {
  const observeA: PollSource<number>['observe'] = () => Promise.resolve({ done: false });
  const observeB: PollSource<number>['observe'] = () =>
    Promise.resolve({ done: false, note: 'different source' });
  const source = (observe: PollSource<number>['observe'], helper?: unknown): WaitSources => ({
    timeoutMs: 60_000,
    poll: {
      input: { pr: 7 },
      schema: z.number(),
      every: 1_000,
      observe,
      ...(helper === undefined ? {} : { [pollIdentityKey]: helper }),
    },
  });

  it('digests the helper value in place of the observer source, and only when present', () => {
    const helper = { helper: 'github.waitChecks', version: 1 };
    const a = waitRequest(source(observeA, helper)).request;
    const b = waitRequest(source(observeB, helper)).request;
    expect(a).toEqual(b);
    expect(a.poll?.observe).toBe(digest({ helper }));
    expect(waitRequest(source(observeA, { ...helper, version: 2 })).request).not.toEqual(a);
    // Without the key nothing changes: the observer's source text is the digest.
    const plain = waitRequest(source(observeA)).request;
    expect(plain.poll?.observe).toBe(digest(Function.prototype.toString.call(observeA)));
    expect(waitRequest(source(observeB)).request.poll?.observe).not.toBe(plain.poll?.observe);
    expect(() => waitRequest(source(observeA, { bad: () => 1 }))).toThrow(
      'Poll helper identity is not JSON',
    );
  });

  it('keeps a waiting helper poll resumable after its observer source changes', async () => {
    const clock = new Clock();
    const helper = { helper: 'test.helper', version: 1 };
    const definition = (observe: PollSource<number>['observe'], version = 1) =>
      defineWorkflow({
        name: 'helper-identity',
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: (ctx) =>
          ctx.poll('helper', {
            ...(source(observe, { ...helper, version }).poll as PollSource<number>),
            // Not due within the in-process window, so the run suspends after the first check.
            every: 30_000,
            timeoutMs: 600_000,
          }),
      });
    const options = { stateDir, runId: 'helper-identity', input: null, clock };
    expect((await runWorkflow(definition(observeA), options)).status).toBe('suspended');
    expect((await runWorkflow(definition(observeB), { ...options, resume: true })).status).toBe(
      'suspended',
    );
    await expect(
      runWorkflow(definition(observeA, 2), { ...options, resume: true }),
    ).rejects.toThrow('wait changed');
  });
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
      ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () =>
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
    const replayed = await runWorkflow(definition, { ...options, resume: true });
    expect(replayed.warnings).toEqual([warning]);
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

/** A latch the test awaits until an observer or step reaches a chosen point. */
function latch(): { reached: Promise<void>; reach: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { reached, reach };
}

it(
  'a body failure aborts an in-flight first poll observation instead of waiting for observeTimeoutMs',
  { timeout: 10_000 },
  async () => {
    let failing = true;
    let siblingAborted: boolean | undefined;
    let captured: AbortSignal | undefined;
    const entered = latch();
    const definition = defineWorkflow({
      name: 'drain-first-observation',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: async (ctx) => {
        const [outcome] = await Promise.all([
          ctx.poll('ready', {
            input: null,
            schema: z.null(),
            every: 50,
            timeoutMs: 600_000,
            observeTimeoutMs: 30_000,
            observe: ({ signal }) => {
              if (!failing) return Promise.resolve({ done: true as const, value: null });
              captured = signal;
              entered.reach();
              return rejectOnAbort(signal);
            },
          }),
          ctx.step('failing', {
            input: null,
            schema: z.null(),
            run: async () => {
              if (!failing) return null;
              await entered.reached;
              await delay(10);
              throw new Error('initiating failure');
            },
          }),
          ctx.step('sibling', {
            input: null,
            schema: z.null(),
            run: async ({ signal }) => {
              await entered.reached;
              await delay(40);
              siblingAborted = signal.aborted;
              return null;
            },
          }),
        ]);
        return outcome;
      },
    });
    const options = { stateDir, runId: 'drain-first-observation', input: null };
    const started = Date.now();
    await expect(runWorkflow(definition, options)).rejects.toThrow('initiating failure');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(captured?.aborted).toBe(true);
    expect(siblingAborted).toBe(false);
    const saved = await readRun(options);
    expect(saved.status).toBe('failed');
    expect(saved.steps['sibling']?.status).toBe('completed');
    const wait = saved.steps['ready'];
    expect(wait?.status).toBe('waiting');
    expect(wait?.error).toBeNull();
    expect(wait?.output).toBeNull();
    expect(wait?.wait?.lastError).toBeUndefined();
    expect(wait?.wait?.note).toBeNull();
    expect(wait?.wait?.checks).toBe(1);
    expect(wait?.wait?.nextCheckAt).toBeLessThanOrEqual(Date.now());
    expect(saved.waitWarnings).toBeUndefined();
    failing = false;
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toMatchObject({ by: 'poll', value: null, checks: 2 });
  },
);

it(
  'a body failure aborts a later poll observation inside a map item',
  { timeout: 10_000 },
  async () => {
    let checks = 0;
    let captured: AbortSignal | undefined;
    const entered = latch();
    const definition = defineWorkflow({
      name: 'drain-map-observation',
      version: '1',
      input: z.null(),
      output: z.null(),
      run: async (ctx) => {
        await Promise.all([
          ctx.map('m', [0], { concurrency: 1 }, () =>
            ctx.poll('ready', {
              input: null,
              schema: z.null(),
              every: 50,
              timeoutMs: 600_000,
              observeTimeoutMs: 30_000,
              observe: ({ signal }) => {
                if (++checks === 1) return Promise.resolve({ done: false as const, note: 1 });
                captured = signal;
                entered.reach();
                return rejectOnAbort(signal);
              },
            }),
          ),
          ctx.step('failing', {
            input: null,
            schema: z.null(),
            run: async () => {
              await entered.reached;
              throw new Error('initiating failure');
            },
          }),
        ]);
        return null;
      },
    });
    const options = { stateDir, runId: 'drain-map-observation', input: null };
    const running = runWorkflow(definition, options);
    await entered.reached;
    const started = Date.now();
    await expect(running).rejects.toThrow('initiating failure');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(captured?.aborted).toBe(true);
    const saved = await readRun(options);
    const waits = Object.values(saved.steps).filter((step) => step.kind === 'wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]?.status).toBe('waiting');
    expect(waits[0]?.error).toBeNull();
    expect(waits[0]?.wait?.lastError).toBeUndefined();
    expect(waits[0]?.wait?.note).toBe(1);
    expect(waits[0]?.wait?.checks).toBe(2);
    expect(saved.waitWarnings).toBeUndefined();
  },
);

it(
  'a body failure abandons a signal-ignoring poll observer after the grace',
  // measured: 2.0 s alone (the fixed 2 s observer grace)
  { timeout: 10_000 },
  async () => {
    const entered = latch();
    const definition = defineWorkflow({
      name: 'drain-hung-observer',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        Promise.all([
          ctx.poll('ready', {
            input: null,
            schema: z.null(),
            every: 50,
            timeoutMs: 600_000,
            observeTimeoutMs: 30_000,
            observe: () => {
              entered.reach();
              return new Promise<never>(() => undefined);
            },
          }),
          ctx.step('failing', {
            input: null,
            schema: z.null(),
            run: async () => {
              await entered.reached;
              throw new Error('initiating failure');
            },
          }),
        ]),
    });
    const options = { stateDir, runId: 'drain-hung-observer', input: null };
    const running = runWorkflow(definition, options);
    await entered.reached;
    const started = Date.now();
    await expect(running).rejects.toThrow('initiating failure');
    expect(Date.now() - started).toBeLessThan(4000);
    const saved = await readRun(options);
    expect(saved.waitWarnings).toEqual([
      'Poll observer for wait ready did not settle within 2000ms after its signal was aborted (run failing); abandoned.',
    ]);
    expect(saved.steps['ready']?.status).toBe('waiting');
    expect(saved.steps['ready']?.error).toBeNull();
    expect(saved.steps['ready']?.wait?.lastError).toBeUndefined();
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
  const build = new Function(
    'return async () => ({ done: false })',
  ) as () => PollSource<unknown>['observe'];
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
        noteSchema: z.object({ seen: z.boolean() }),
      },
    }),
  ).toEqual(expected);
});

describe('noteSchema', () => {
  const seenSchema = z.object({ seen: z.number() });
  type Check = { done: true; value: 'ok' } | { done: false; note?: JsonValue };
  /** An observer poll named `name`, with the given policy options; every check is due after 31 s. */
  const notePoll = (
    name: string,
    observe: (context: PollContext) => Promise<Check>,
    policy: { noteSchema?: z.ZodType<JsonValue>; onError?: PollErrorPolicy } = {},
  ) =>
    defineWorkflow({
      name,
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ready', {
          input: null,
          schema: z.literal('ok'),
          every: 30_000,
          timeoutMs: 600_000,
          ...policy,
          observe: (context) => observe(context) as Promise<{ done: true; value: 'ok' }>,
        }),
    });
  /** The rejection of a failed run, with the engine's own error (its cause) unwrapped. */
  const failure = async (promise: Promise<unknown>): Promise<Error & { code?: string }> => {
    const error = await promise.then(
      () => {
        throw new Error('expected the run to fail');
      },
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(WorkflowRunError);
    return (error as WorkflowRunError).cause as Error;
  };

  it('shows the next check the parsed note and persists it without unknown keys', async () => {
    const clock = new Clock();
    const seen: unknown[] = [];
    const definition = notePoll(
      'note-parsed',
      ({ previous }) => {
        seen.push(previous.note);
        return Promise.resolve(
          previous.checks === 0
            ? { done: false, note: { seen: 1, extra: 'dropped' } }
            : { done: true, value: 'ok' },
        );
      },
      { noteSchema: seenSchema },
    );
    const options = { stateDir, runId: 'note-parsed', input: null, clock };
    expect((await runWorkflow(definition, options)).status).toBe('suspended');
    expect((await readRun(options)).steps['ready']?.wait?.note).toEqual({ seen: 1 });
    clock.time += 31_000;
    const done = await runWorkflow(definition, { ...options, resume: true });
    expect(done.output).toMatchObject({ by: 'poll', checks: 2 });
    expect(seen).toEqual([null, { seen: 1 }]);
  });

  it('fails a returned note that does not match with a coded error, and never tolerates it', async () => {
    const definition = notePoll(
      'note-returned',
      () => Promise.resolve({ done: false, note: { seen: 'yes' } }),
      { noteSchema: seenSchema, onError: { tolerate: 3 } },
    );
    const options = { stateDir, runId: 'note-returned', input: null };
    const error = await failure(runWorkflow(definition, options));
    expect(error.message).toContain(
      'Wait ready: the note returned by observe does not match noteSchema:',
    );
    expect(error.code).toBe('QUIET_CHOIR_POLL_NOTE_INVALID');
    expect(error.cause).toBeInstanceOf(z.ZodError);
    const saved = await readRun(options);
    expect(saved.status).toBe('failed');
    expect(saved.rootCause).toMatchObject({ stepId: 'ready', errorKind: 'schema' });
    expect(saved.steps['ready']?.wait).toMatchObject({ checks: 1, note: null });
    expect(saved.steps['ready']?.wait?.lastError).toBeUndefined();
  });

  it('fails a saved note that a changed schema rejects, before the observer runs', async () => {
    const clock = new Clock();
    const options = { stateDir, runId: 'note-saved', input: null, clock };
    const first = notePoll('note-saved', () => Promise.resolve({ done: false, note: { n: 1 } }));
    expect((await runWorkflow(first, options)).status).toBe('suspended');
    clock.time += 31_000;
    let calls = 0;
    const second = notePoll(
      'note-saved',
      () => {
        calls++;
        return Promise.resolve({ done: true, value: 'ok' });
      },
      { noteSchema: seenSchema, onError: { tolerate: 3 } },
    );
    const error = await failure(runWorkflow(second, { ...options, resume: true }));
    expect(error.message).toContain(
      'Wait ready: the saved note from an earlier check does not match noteSchema:',
    );
    expect(error.code).toBe('QUIET_CHOIR_POLL_NOTE_INVALID');
    expect(calls).toBe(0);
    const saved = await readRun(options);
    expect(saved.rootCause).toMatchObject({ stepId: 'ready', errorKind: 'schema' });
    expect(saved.steps['ready']?.wait).toMatchObject({ checks: 1, note: { n: 1 } });
  });

  describe('nested context operations in noteSchema', () => {
    /** A poll whose noteSchema transform calls ctx.step; `ran` counts the step actions that ran. */
    const nestingPoll = (name: string, nest: boolean, ran: { count: number }) =>
      defineWorkflow({
        name,
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: (ctx) =>
          ctx.poll('ready', {
            input: null,
            schema: z.literal('ok'),
            every: 30_000,
            timeoutMs: 600_000,
            ...(nest
              ? {
                  noteSchema: z.object({ n: z.number() }).transform((note) => {
                    void ctx.step('inner', {
                      input: null,
                      schema: z.null(),
                      run: () => {
                        ran.count++;
                        return null;
                      },
                    });
                    return note;
                  }),
                }
              : {}),
            observe: (() =>
              Promise.resolve({ done: false, note: { n: 1 } })) as unknown as () => Promise<{
              done: true;
              value: 'ok';
            }>,
          }),
      });

    it('fails the wait when parsing a returned note calls ctx.step', async () => {
      const ran = { count: 0 };
      const options = { stateDir, runId: 'note-nest-returned', input: null };
      await expect(
        runWorkflow(nestingPoll('note-nest-returned', true, ran), options),
      ).rejects.toThrow('Nested durable');
      expect(ran.count).toBe(0);
      expect((await readRun(options)).steps['inner']).toBeUndefined();
    });

    it('fails the wait when parsing a saved note calls ctx.step', async () => {
      const clock = new Clock();
      const ran = { count: 0 };
      const options = { stateDir, runId: 'note-nest-saved', input: null, clock };
      const first = nestingPoll('note-nest-saved', false, ran);
      expect((await runWorkflow(first, options)).status).toBe('suspended');
      clock.time += 31_000;
      await expect(
        runWorkflow(nestingPoll('note-nest-saved', true, ran), { ...options, resume: true }),
      ).rejects.toThrow('Nested durable');
      expect(ran.count).toBe(0);
      expect((await readRun(options)).steps['inner']).toBeUndefined();
    });
  });

  it('lets a catch(null) schema reset an incompatible saved note', async () => {
    const clock = new Clock();
    const options = { stateDir, runId: 'note-reset', input: null, clock };
    const first = notePoll('note-reset', () => Promise.resolve({ done: false, note: { n: 1 } }));
    expect((await runWorkflow(first, options)).status).toBe('suspended');
    clock.time += 31_000;
    const seen: unknown[] = [];
    const second = notePoll(
      'note-reset',
      ({ previous }) => {
        seen.push(previous.note);
        return Promise.resolve({ done: true, value: 'ok' });
      },
      { noteSchema: seenSchema.nullable().catch(null) },
    );
    const done = await runWorkflow(second, { ...options, resume: true });
    expect(done.output).toMatchObject({ by: 'poll', checks: 2 });
    expect(seen).toEqual([null]);
  });

  it('never passes a null or absent note to the schema', async () => {
    const clock = new Clock();
    const parsed: unknown[] = [];
    const recording = seenSchema.nullable().transform((note) => {
      parsed.push(note);
      return note;
    });
    const definition = notePoll(
      'note-null',
      ({ previous }) =>
        Promise.resolve(
          previous.checks === 0
            ? { done: false, note: null }
            : previous.checks === 1
              ? { done: false }
              : { done: true, value: 'ok' },
        ),
      { noteSchema: recording },
    );
    const options = { stateDir, runId: 'note-null', input: null, clock };
    for (const resume of [false, true, true]) {
      await runWorkflow(definition, { ...options, resume });
      clock.time += 31_000;
    }
    expect(parsed).toEqual([]);
  });

  it('rejects a noteSchema that is not a Zod schema when the wait opens', async () => {
    const definition = notePoll('note-invalid', () => Promise.resolve({ done: false }), {
      noteSchema: { parse: () => null } as unknown as z.ZodType<JsonValue>,
    });
    await expect(
      runWorkflow(definition, { stateDir, runId: 'note-invalid', input: null }),
    ).rejects.toThrow('Poll noteSchema must be a Zod schema.');
  });

  it('keeps noteSchema out of the persisted request and wait identity', async () => {
    const clock = new Clock();
    const options = { stateDir, runId: 'note-identity', input: null, clock };
    const observe = (): Promise<Check> => Promise.resolve({ done: false, note: { seen: 1 } });
    const first = await runWorkflow(notePoll('note-identity', observe), options);
    const request = first.steps['ready']?.wait?.request.poll;
    expect(Object.keys(request ?? {}).sort()).toEqual(['every', 'input', 'observe', 'schema']);
    const fingerprint = first.steps['ready']?.fingerprint;
    clock.time += 31_000;
    const resumed = await runWorkflow(
      notePoll('note-identity', observe, { noteSchema: seenSchema }),
      { ...options, resume: true },
    );
    expect(resumed.status).toBe('suspended');
    expect(resumed.steps['ready']?.fingerprint).toBe(fingerprint);
    expect(resumed.steps['ready']?.wait?.request.poll).toEqual(request);
    expect(await readFile(join(stateDir, 'note-identity', 'run.json'), 'utf8')).not.toContain(
      'noteSchema',
    );
  });
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
    launchStamp: () => 0,
    warn: (message) => {
      warnings.push(message);
    },
    tolerated: () => () => undefined,
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

it('drain() aborts an in-flight observation and records nothing for it', async () => {
  const { questions, warnings, record } = bareQuestions(() => Promise.resolve());
  const entered = latch();
  let captured: AbortSignal | undefined;
  const registered = questions.wait(
    'w',
    {
      timeoutMs: 60_000,
      poll: {
        input: null,
        schema: z.null(),
        every: 50,
        observe: ({ signal }) => {
          captured = signal;
          entered.reach();
          return rejectOnAbort(signal);
        },
      },
    },
    null,
    new AbortController().signal,
  );
  await entered.reached;
  questions.drain();
  // Registration ends once the aborted observation's scan unwinds; the wait stays parked.
  await registered;
  expect(captured?.aborted).toBe(true);
  expect(questions.waiting('w')).toBe(true);
  const started = Date.now();
  await questions.close();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(warnings).toEqual([]);
  const step = record.steps['w'];
  expect(step?.status).toBe('waiting');
  expect(step?.error).toBeNull();
  expect(step?.wait?.lastError).toBeUndefined();
  expect(step?.wait?.checks).toBe(1);
});

it('starts no observation and counts no check once the drain begins mid-scan', async () => {
  let saves = 0;
  let observed = 0;
  // The second save records the rejected answer below, while the scan is inside its signal read.
  const { questions, record } = bareQuestions(() => {
    if (++saves === 2) questions.drain();
    return Promise.resolve();
  });
  const path = answerCandidates(stateDir, 'bare', 'w')[0] ?? '';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'not json');
  await questions.wait(
    'w',
    {
      timeoutMs: 60_000,
      signal: { prompt: 'Ready?', schema: z.null() },
      poll: {
        input: null,
        schema: z.null(),
        every: 50,
        observe: () => {
          observed++;
          return Promise.resolve({ done: false as const });
        },
      },
    },
    null,
    new AbortController().signal,
  );
  expect(saves).toBe(2);
  expect(observed).toBe(0);
  expect(questions.waiting('w')).toBe(true);
  const step = record.steps['w'];
  expect(step?.status).toBe('waiting');
  expect(step?.question?.rejections).toHaveLength(1);
  expect(step?.wait?.checks).toBe(0);
  await questions.close();
});

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

/** The record's wait.tolerated run events. */
function tolerated(record: RunRecord): RunEvent[] {
  return (record.events ?? []).filter((event) => event.type === 'wait.tolerated');
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
  const live: WorkflowEvent[] = [];
  await expect(
    runWorkflow(failing, {
      ...blocked,
      waitMode: 'block',
      onEvent: (event) => {
        live.push(event);
      },
    }),
  ).rejects.toThrow('HTTP 502 #4');
  expect(calls).toBe(4);
  const saved = await readRun(blocked);
  expect(saved.status).toBe('failed');
  expect(saved.steps['ready']?.error).toBe('HTTP 502 #4');
  expect(saved.steps['ready']?.wait?.checks).toBe(4);
  // One wait.tolerated per tolerated error, none for the error past the tolerance, which still
  // surfaces only as the failed wait and the run.failed naming it.
  const expected = [1, 2, 3].map((consecutive): unknown =>
    expect.objectContaining({
      type: 'wait.tolerated',
      stepId: 'ready',
      message: `HTTP 502 #${String(consecutive)}`,
      data: { consecutive, tolerate: 3 },
    }),
  );
  expect(saved.events?.filter((event) => event.type === 'wait.tolerated')).toEqual(expected);
  expect(live.filter((event) => event.type === 'wait.tolerated')).toEqual(expected);
  expect(
    live
      .filter((event) => event.type === 'wait.tolerated' || event.type === 'run.failed')
      .map((event) => event.type),
  ).toEqual(['wait.tolerated', 'wait.tolerated', 'wait.tolerated', 'run.failed']);
  expect(live.find((event) => event.type === 'run.failed')).toMatchObject({
    stepId: 'ready',
    message: expect.stringContaining('HTTP 502 #4') as unknown,
  });
  // A follower reads the same three events, then the run.failed that names the wait.
  expect(
    recordEventLines(saved, null, 'all')
      .lines.map((line) => JSON.parse(line) as { ev: string; msg?: string })
      .filter(({ ev }) => ev !== 'run.started'),
  ).toEqual([
    expect.objectContaining({ ev: 'wait.tolerated', msg: 'tolerated 1/3: HTTP 502 #1' }),
    expect.objectContaining({ ev: 'wait.tolerated', msg: 'tolerated 2/3: HTTP 502 #2' }),
    expect.objectContaining({ ev: 'wait.tolerated', msg: 'tolerated 3/3: HTTP 502 #3' }),
    expect.objectContaining({ ev: 'run.failed', step: 'ready', msg: 'HTTP 502 #4' }),
  ]);

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
    const saved = await readRun(options);
    expect(saved.steps['ready']?.wait).not.toHaveProperty('lastError');
    expect(tolerated(saved)).toEqual([]);
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
  expect(tolerated(saved)).toEqual([]);
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
  for (const [index, invalid] of [-1, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
    const runId = `retry-invalid-${String(index)}`;
    await expect(pendingAfter(runId, () => invalid)).rejects.toThrow(
      'Wait ready: onError.retryAfterMs must return null or a finite number of at least 0.',
    );
    // The validation runs before the error is recorded, so a failing wait carries no event.
    expect(tolerated(await readRun({ stateDir, runId }))).toEqual([]);
  }
  expect(tolerated(delayed)).toHaveLength(1);
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
  // Only the observational wait.tolerated events name the limit; the wait record never does.
  const steps = JSON.stringify((JSON.parse(bytes) as { steps: unknown }).steps);
  expect(steps).not.toContain('tolerate');
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
    expect(tolerated(saved), name).toEqual([]);
  }
});

describe('wait.tolerated run events', () => {
  /** Collect live events; `types` keeps their order. */
  function collector(): { live: WorkflowEvent[]; onEvent: (event: WorkflowEvent) => void } {
    const live: WorkflowEvent[] = [];
    return {
      live,
      onEvent: (event) => {
        live.push(event);
      },
    };
  }

  it('records one event per tolerated error, live and persisted, restarting the count after a success', async () => {
    const outcomes = ['fail', 'fail', 'note', 'fail', 'done'] as const;
    let calls = 0;
    const definition = policyPoll(
      'tolerated-events',
      () => {
        const outcome = outcomes[calls++];
        if (outcome === 'fail') return Promise.reject(new Error(`HTTP 502 #${String(calls)}`));
        if (outcome === 'note') return Promise.resolve({ done: false, note: { n: calls } });
        return Promise.resolve({ done: true, value: 'ok' });
      },
      { onError: { tolerate: 3 }, every: 1, timeoutMs: 1_000_000 },
    );
    const { live, onEvent } = collector();
    const options = { stateDir, runId: 'tolerated-events', input: null, clock: new Clock(true) };
    const run = await runWorkflow(definition, { ...options, waitMode: 'block', onEvent });
    expect(run.output).toMatchObject({ by: 'poll', value: 'ok', checks: 5 });
    const expected = [
      [1, 'HTTP 502 #1'],
      [2, 'HTTP 502 #2'],
      [1, 'HTTP 502 #4'],
    ].map(([consecutive, message]): unknown =>
      expect.objectContaining({
        type: 'wait.tolerated',
        stepId: 'ready',
        message,
        data: { consecutive, tolerate: 3 },
        phase: null,
        total: null,
        execution: 1,
      }),
    );
    expect(tolerated(run)).toEqual(expected);
    expect(tolerated(await readRun(options))).toEqual(expected);
    const liveTolerated = live.filter((event) => event.type === 'wait.tolerated');
    expect(liveTolerated).toEqual(expected);
    expect(liveTolerated.every((event) => event.replayed === false)).toBe(true);
    // Each live event is the persisted entry plus the notification fields.
    expect(liveTolerated[0]).toMatchObject({ ...tolerated(run)[0], runId: 'tolerated-events' });
    // A tolerated error is not a body call: it never enters the replay ledger.
    expect(Object.keys(run.eventCounts ?? {})).toEqual([]);
    const order = live.map((event) => event.type);
    expect(order.lastIndexOf('wait.tolerated')).toBeLessThan(order.indexOf('step.completed'));
  });

  it('stamps the event with the time lastError records, not a fresh clock read', async () => {
    // Every read advances the clock, so a second read for the event would differ from lastError.at.
    class TickingClock extends Clock {
      public override now(): number {
        return this.time++;
      }
    }
    let calls = 0;
    const definition = policyPoll(
      'tolerated-at',
      () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('HTTP 502'));
        return Promise.resolve({ done: true, value: 'ok' });
      },
      { onError: { tolerate: 3 } },
    );
    const { live, onEvent } = collector();
    const options = { stateDir, runId: 'tolerated-at', input: null, clock: new TickingClock() };
    expect((await runWorkflow(definition, { ...options, onEvent })).status).toBe('suspended');
    const saved = await readRun(options);
    const lastError = saved.steps['ready']?.wait?.lastError;
    expect(lastError?.message).toBe('HTTP 502');
    const [persisted] = tolerated(saved);
    expect(persisted?.at).toBe(new Date(lastError?.at ?? Number.NaN).toISOString());
    const liveTolerated = live.filter((event) => event.type === 'wait.tolerated');
    expect(liveTolerated).toHaveLength(1);
    expect(liveTolerated[0]?.at).toBe(persisted?.at);
  });

  it('records nothing for a poll without onError', async () => {
    const definition = policyPoll('untolerated', () => Promise.reject(new Error('HTTP 502')));
    const { live, onEvent } = collector();
    const options = { stateDir, runId: 'untolerated', input: null, clock: new Clock() };
    await expect(runWorkflow(definition, { ...options, onEvent })).rejects.toThrow('HTTP 502');
    expect(tolerated(await readRun(options))).toEqual([]);
    expect(live.some((event) => event.type === 'wait.tolerated')).toBe(false);
  });

  it('records nothing for an observation aborted by the failure drain', async () => {
    const entered = latch();
    const definition = defineWorkflow({
      name: 'drain-tolerated',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: async (ctx) => {
        const [outcome] = await Promise.all([
          ctx.poll('ready', {
            input: null,
            schema: z.null(),
            every: 50,
            timeoutMs: 600_000,
            onError: { tolerate: 3 },
            observe: ({ signal }) => {
              entered.reach();
              return rejectOnAbort(signal);
            },
          }),
          ctx.step('failing', {
            input: null,
            schema: z.null(),
            run: async () => {
              await entered.reached;
              throw new Error('initiating failure');
            },
          }),
        ]);
        return outcome;
      },
    });
    const { live, onEvent } = collector();
    const options = { stateDir, runId: 'drain-tolerated', input: null };
    await expect(runWorkflow(definition, { ...options, onEvent })).rejects.toThrow(
      'initiating failure',
    );
    const saved = await readRun(options);
    expect(saved.steps['ready']?.wait?.lastError).toBeUndefined();
    expect(tolerated(saved)).toEqual([]);
    expect(live.some((event) => event.type === 'wait.tolerated')).toBe(false);
  });

  it('commits and notifies the event before step.completed when a signal wins the same check', async () => {
    const clock = new Clock();
    const options = { stateDir, runId: 'tolerated-signal', input: null, clock };
    const definition = defineWorkflow({
      name: 'tolerated-signal',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.wait('gate', {
          signal: { prompt: 'Ready?', schema: z.literal('go') },
          poll: {
            input: null,
            schema: z.literal('ok'),
            every: 30_000,
            onError: { tolerate: 3 },
            // The answer arrives while this check is in flight, and the check then fails.
            observe: async () => {
              await writeAnswer({ ...options, stepId: 'gate', value: 'go', by: 'agent:test' });
              throw new Error('HTTP 502');
            },
          },
        }),
    });
    const { live, onEvent } = collector();
    const run = await runWorkflow(definition, { ...options, onEvent });
    expect(run.output).toMatchObject({ by: 'signal', value: 'go' });
    expect(run.steps['gate']?.wait?.lastError).toMatchObject({ consecutive: 1 });
    expect(tolerated(run)).toEqual([
      expect.objectContaining({ stepId: 'gate', data: { consecutive: 1, tolerate: 3 } }),
    ]);
    expect(
      live
        .filter((event) => event.type === 'wait.tolerated' || event.type === 'step.completed')
        .map((event) => event.type),
    ).toEqual(['wait.tolerated', 'step.completed']);
    const lines = recordEventLines(await readRun(options), null, 'all').lines.map(
      (line) => (JSON.parse(line) as { ev: string }).ev,
    );
    expect(lines.indexOf('wait.tolerated')).toBeLessThan(lines.indexOf('step.completed'));
  });

  it('commits and notifies the event before step.completed when the deadline wins the same check', async () => {
    const clock = new Clock();
    const opened = clock.time;
    const definition = policyPoll(
      'tolerated-deadline',
      () => {
        // The error is observed at the deadline.
        clock.time = opened + 600_000;
        return Promise.reject(new Error('down'));
      },
      { onError: { tolerate: 3 } },
    );
    const { live, onEvent } = collector();
    const options = { stateDir, runId: 'tolerated-deadline', input: null, clock };
    const run = await runWorkflow(definition, { ...options, onEvent });
    expect(run.output).toMatchObject({ by: 'deadline' });
    expect(tolerated(run)).toEqual([
      expect.objectContaining({
        stepId: 'ready',
        message: 'down',
        data: { consecutive: 1, tolerate: 3 },
        at: new Date(opened + 600_000).toISOString(),
      }),
    ]);
    expect(
      live
        .filter((event) => event.type === 'wait.tolerated' || event.type === 'step.completed')
        .map((event) => event.type),
    ).toEqual(['wait.tolerated', 'step.completed']);
    const lines = recordEventLines(await readRun(options), null, 'all').lines.map(
      (line) => (JSON.parse(line) as { ev: string }).ev,
    );
    expect(lines.indexOf('wait.tolerated')).toBeLessThan(lines.indexOf('step.completed'));
  });

  it('carries an error code such as the observeTimeoutMs expiry, and cuts a long message', async () => {
    let calls = 0;
    const long = 'x'.repeat(5_000);
    const definition = defineWorkflow({
      name: 'tolerated-code',
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
          onError: { tolerate: 3, retryAfterMs: () => 0 },
          observe: ({ signal }) => {
            calls++;
            if (calls === 1) return rejectOnAbort(signal);
            if (calls === 2) return Promise.reject(new Error(long));
            return Promise.resolve({ done: true, value: null });
          },
        }),
    });
    const { live, onEvent } = collector();
    const run = await runWorkflow(definition, {
      stateDir,
      runId: 'tolerated-code',
      input: null,
      onEvent,
    });
    expect(run.output).toMatchObject({ by: 'poll', checks: 3 });
    const [timeout, cut] = tolerated(run);
    expect(timeout?.data).toEqual({
      consecutive: 1,
      tolerate: 3,
      code: 'QUIET_CHOIR_POLL_OBSERVE_TIMEOUT',
    });
    expect(timeout?.message).toContain('observeTimeoutMs');
    expect(cut?.data).toEqual({ consecutive: 2, tolerate: 3 });
    expect(cut?.message).toBe('x'.repeat(1024));
    expect(live.filter((event) => event.type === 'wait.tolerated')).toHaveLength(2);
  });

  it('keeps the message at 4096 in lastError while the event cuts it to 1024', async () => {
    const definition = policyPoll(
      'tolerated-long',
      () => Promise.reject(new Error('y'.repeat(5_000))),
      { onError: { tolerate: 3 } },
    );
    const run = await runWorkflow(definition, {
      stateDir,
      runId: 'tolerated-long',
      input: null,
      clock: new Clock(),
    });
    expect(run.status).toBe('suspended');
    expect(run.steps['ready']?.wait?.lastError?.message).toHaveLength(4096);
    expect(tolerated(run)[0]?.message).toHaveLength(1024);
  });

  it('neither duplicates nor reorders the event across suspend, resume and a completed re-run', async () => {
    const clock = new Clock();
    let calls = 0;
    const definition = policyPoll(
      'tolerated-resume',
      () =>
        ++calls === 1
          ? Promise.reject(new Error('HTTP 502'))
          : Promise.resolve({ done: true, value: 'ok' }),
      { onError: { tolerate: 3 } },
    );
    const options = { stateDir, runId: 'tolerated-resume', input: null, clock };
    const first = collector();
    expect((await runWorkflow(definition, { ...options, onEvent: first.onEvent })).status).toBe(
      'suspended',
    );
    expect(first.live.filter((event) => event.type === 'wait.tolerated')).toHaveLength(1);
    const suspended = tolerated(await readRun(options));
    expect(suspended).toHaveLength(1);
    clock.time += 31_000;
    const second = collector();
    const done = await runWorkflow(definition, {
      ...options,
      resume: true,
      onEvent: second.onEvent,
    });
    expect(done.status).toBe('completed');
    expect(second.live.some((event) => event.type === 'wait.tolerated')).toBe(false);
    expect(tolerated(done)).toEqual(suspended);
    const finishedAt = done.steps['ready']?.finishedAt ?? '';
    expect(Date.parse(suspended[0]?.at ?? '')).toBeLessThan(Date.parse(finishedAt));
    // Re-reading the completed run leaves the record's events unchanged.
    const snapshot = await readFile(join(stateDir, 'tolerated-resume', 'run.json'), 'utf8');
    const third = collector();
    const again = await runWorkflow(definition, {
      ...options,
      resume: true,
      onEvent: third.onEvent,
    });
    expect(again.status).toBe('completed');
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(done.events));
    expect(await readFile(join(stateDir, 'tolerated-resume', 'run.json'), 'utf8')).toBe(snapshot);
    expect(third.live.some((event) => event.type === 'wait.tolerated')).toBe(false);
    expect(calls).toBe(2);
    // A follower prints the event once, before step.completed and the terminal run line.
    const record = await readRun(options);
    const read = recordEventLines(record, null, 'all');
    const types = read.lines.map((line) => (JSON.parse(line) as { ev: string }).ev);
    expect(types.filter((type) => type === 'wait.tolerated')).toHaveLength(1);
    expect(types.indexOf('wait.tolerated')).toBeLessThan(types.indexOf('step.completed'));
    expect(types.indexOf('wait.tolerated')).toBeLessThan(types.lastIndexOf('run.completed'));
    expect(recordEventLines(record, read.cursor, 'all').lines).toEqual([]);
  });
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
  const noteSchema = z.object({ seen: z.boolean() });
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
      await ctx.poll('schema-typed', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        noteSchema,
        observe: ({ previous }) => {
          expectTypeOf(previous.note).toEqualTypeOf<z.infer<typeof noteSchema> | null>();
          expectTypeOf(previous.note).toEqualTypeOf<{ seen: boolean } | null>();
          return Promise.resolve({ done: false, note: { seen: previous.note?.seen ?? false } });
        },
      });
      await ctx.poll('schema-optional', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        noteSchema: z.object({ label: z.string().optional() }),
        observe: ({ previous }) => {
          expectTypeOf(previous.note).toEqualTypeOf<{ label?: string | undefined } | null>();
          return Promise.resolve({ done: false, note: {} });
        },
      });
      await ctx.poll('schema-wrong-note', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        noteSchema,
        // @ts-expect-error the returned note must match noteSchema
        observe: () => Promise.resolve({ done: false, note: { seen: 'yes' } }),
      });
      // Null, or the previous note forwarded as is, is allowed whatever the schema.
      await ctx.poll('schema-null-note', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        noteSchema,
        observe: ({ previous }) =>
          Promise.resolve(
            previous.checks === 0
              ? { done: false, note: null }
              : { done: false, note: previous.note },
          ),
      });
      await ctx.poll('command-null-note', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        command: ['true'],
        output: z.unknown(),
        noteSchema,
        done: (_output, previous) =>
          previous.checks === 0
            ? { done: false, note: null }
            : { done: false, note: previous.note },
      });
      await ctx.poll('command-async-null-note', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 1,
        command: ['true'],
        output: z.unknown(),
        noteSchema,
        done: (_output, previous) => Promise.resolve({ done: false, note: previous.note }),
      });
      // ctx.wait poll sources infer the note type from noteSchema too, optional fields included.
      const waited = await ctx.wait('wait-schema-typed', {
        timeoutMs: 1,
        poll: {
          input: null,
          schema: z.literal('ok'),
          every: 1,
          noteSchema: z.object({ label: z.string().optional() }),
          observe: ({ previous }) => {
            expectTypeOf(previous.note).toEqualTypeOf<{ label?: string | undefined } | null>();
            return Promise.resolve({ done: false, note: { label: previous.note?.label ?? 'x' } });
          },
        },
      });
      expectTypeOf(waited.by).toEqualTypeOf<'poll' | 'deadline'>();
      if (waited.by === 'poll') expectTypeOf(waited.value).toEqualTypeOf<'ok'>();
      await ctx.wait('wait-command-schema-typed', {
        timeoutMs: 1,
        poll: {
          input: null,
          schema: z.null(),
          every: 1,
          command: ['true'],
          output: z.unknown(),
          noteSchema: z.object({ label: z.string().optional() }),
          done: (_output, previous) => {
            expectTypeOf(previous.note).toEqualTypeOf<{ label?: string | undefined } | null>();
            return { done: false, note: {} };
          },
        },
      });
      await ctx.wait('wait-default-note', {
        timeoutMs: 1,
        poll: {
          input: null,
          schema: z.null(),
          every: 1,
          observe: ({ previous }) => {
            expectTypeOf(previous.note).toEqualTypeOf<JsonValue | null>();
            return Promise.resolve({ done: false, note: null });
          },
        },
      });
      await ctx.wait('wait-wrong-note', {
        timeoutMs: 1,
        poll: {
          input: null,
          schema: z.null(),
          every: 1,
          noteSchema,
          // @ts-expect-error the returned note must match noteSchema
          observe: () => Promise.resolve({ done: false, note: { seen: 'yes' } }),
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

describe('command polls', () => {
  const node = (code: string): Command => [process.execPath, '-e', code];
  /** A command that counts its runs in `file` and prints `{ n, ready }`, ready from run `readyAt`. */
  const counter = (file: string, readyAt: number, failOn: number | null = null): Command =>
    node(
      `const fs = require('node:fs'); const f = ${JSON.stringify(file)};` +
        `const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;` +
        `fs.writeFileSync(f, String(n));` +
        `if (n === ${String(failOn)}) { process.stderr.write('flaky'); process.exit(7); }` +
        `process.stdout.write(JSON.stringify({ n, ready: n >= ${String(readyAt)} }));`,
    );
  const counted = z.object({ n: z.number(), ready: z.boolean() });
  type Settings = Omit<CommandPollSource<number, z.infer<typeof counted>>, 'input' | 'schema'> & {
    readonly timeoutMs: number;
  };
  const commandPoll = (name: string, settings: Settings) =>
    defineWorkflow({
      name,
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.poll('ci', { input: null, schema: z.number(), ...settings }),
    });
  const run = (runId: string, extra: Record<string, unknown> = {}) => ({
    stateDir,
    cwd: stateDir,
    runId,
    input: null,
    processRunner: new NodeProcessRunner(),
    ...extra,
  });

  it('completes by poll once done says so and counts every observation', async () => {
    const file = join(stateDir, 'count');
    const previous: number[] = [];
    const definition = commandPoll('command-poll', {
      every: 1,
      timeoutMs: 60_000,
      command: counter(file, 3),
      output: counted,
      done: (output, before) => {
        previous.push(before.checks);
        return output.ready
          ? { done: true, value: output.n }
          : { done: false, note: { seen: output.n } };
      },
    });
    const result = await runWorkflow(definition, run('command-poll', { waitMode: 'block' }));
    expect(result.output).toMatchObject({ by: 'poll', value: 3, checks: 3 });
    expect(await readFile(file, 'utf8')).toBe('3');
    expect(previous).toEqual([0, 1, 2]);
    const wait = (await readRun({ stateDir, runId: 'command-poll' })).steps['ci']?.wait;
    expect(wait).toMatchObject({ checks: 3, note: { seen: 2 } });
  });

  it('fails with a bounded ExecError for a failing exit, truncated output or a schema mismatch', async () => {
    const cases: [string, Command, Record<string, unknown>, string][] = [
      [
        'exit',
        node(
          "process.stdout.write('o'.repeat(3000)); process.stderr.write('e'.repeat(3000)); process.exit(3)",
        ),
        {},
        'process',
      ],
      [
        'truncated',
        node(`process.stdout.write(JSON.stringify({ n: 1, ready: true, pad: 'x'.repeat(64) }))`),
        { maxOutputBytes: 16 },
        'output-limit',
      ],
      ['schema', node(`process.stdout.write(JSON.stringify({ n: 'one' }))`), {}, 'schema'],
    ];
    for (const [runId, command, commandOptions, kind] of cases) {
      const definition = commandPoll(runId, {
        every: 1,
        timeoutMs: 60_000,
        command,
        output: counted,
        commandOptions,
        done: (output) => ({ done: true, value: output.n }),
      });
      const error = await runWorkflow(definition, run(runId)).catch((caught: unknown) => caught);
      // The run error wraps the wait's failure, which is the command's own ExecError.
      expect(error, runId).toBeInstanceOf(WorkflowRunError);
      const failure = (error as WorkflowRunError).cause as ExecError;
      expect(failure, runId).toBeInstanceOf(ExecError);
      expect(failure.kind, runId).toBe(kind);
      expect(failure.diagnostics.stdoutTail.length).toBeLessThanOrEqual(1024);
      expect(failure.diagnostics.stderrTail.length).toBeLessThanOrEqual(1024);
      if (runId === 'exit') {
        expect(failure.diagnostics).toMatchObject({ code: 3, stdoutTail: 'o'.repeat(1024) });
        expect(failure.diagnostics.stderrTail).toBe('e'.repeat(1024));
      }
      const step = (await readRun({ stateDir, runId })).steps['ci'];
      expect(step?.error, runId).toBe(failure.message);
    }
  });

  it('tolerates a failing check under onError, classified by its exit code', async () => {
    const clock = new Clock();
    const file = join(stateDir, 'count');
    const classified: unknown[] = [];
    const definition = commandPoll('command-tolerate', {
      every: 30_000,
      timeoutMs: 600_000,
      command: counter(file, 2, 1),
      output: counted,
      onError: {
        tolerate: 2,
        classify: (error) => {
          classified.push(error instanceof ExecError ? error.diagnostics.code : error);
          return error instanceof ExecError && error.diagnostics.code === 7 ? 'transient' : 'fatal';
        },
      },
      done: (output) => (output.ready ? { done: true, value: output.n } : { done: false }),
    });
    const options = run('command-tolerate', { clock });
    expect((await runWorkflow(definition, options)).status).toBe('suspended');
    expect(classified).toEqual([7]);
    const failed = (await readRun(options)).steps['ci']?.wait;
    expect(failed).toMatchObject({ checks: 1, lastError: { consecutive: 1 } });
    expect(failed?.lastError?.message).toContain('Command exited with 7.');
    clock.time += 31_000;
    const done = await runWorkflow(definition, { ...options, resume: true });
    expect(done.output).toMatchObject({ by: 'poll', value: 2, checks: 2 });
    expect(done.steps['ci']?.wait).not.toHaveProperty('lastError');
  });

  it('records the command, its output schema and the done digest in the wait request', async () => {
    // A wait source's done takes unknown output; ctx.poll infers it from output instead.
    const done = (output: unknown) =>
      (output as { state: string }).state === 'green'
        ? { done: true as const, value: 'green' }
        : { done: false as const };
    const poll = {
      input: { pr: 151 },
      schema: z.string(),
      every: 1_000,
      command: ['gh', 'pr', 'checks', '151'] as Command,
      output: z.object({ state: z.string() }),
      done,
    };
    const request = async (changes: Record<string, unknown> = {}) => {
      const changed = { ...poll, ...changes };
      return waitRequest(
        { timeoutMs: 600_000, poll: changed },
        await commandPollIdentity(changed, stateDir),
      ).request;
    };
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const original = await request();
    expect(JSON.parse(JSON.stringify(original))).toEqual({
      timeoutMs: 600_000,
      deadline: null,
      poll: {
        input: { pr: 151 },
        schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' },
        every: { initialMs: 1000, maxMs: 1000, factor: 1 },
        observe: digest(Function.prototype.toString.call(done)),
        command: {
          exec: {
            command: ['gh', 'pr', 'checks', '151'],
            cwd: await realpath(stateDir),
            envSha256: digest({}),
            inheritEnv: true,
            inputSha256: sha256(''),
            okExitCodes: [0],
            structured: true,
          },
          output: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            additionalProperties: false,
            properties: { state: { type: 'string' } },
            required: ['state'],
            type: 'object',
          },
        },
      },
    });
    // Policy stays out of identity.
    expect(
      await request({
        live: true,
        observeTimeoutMs: 5_000,
        onError: { tolerate: 2 },
        commandOptions: { maxOutputBytes: 64 },
      }),
    ).toEqual(original);
    // Semantic command inputs enter it.
    for (const changes of [
      { commandOptions: { env: { GH_REPO: 'plx/quiet-choir' } } },
      { commandOptions: { input: '{}' } },
      { commandOptions: { okExitCodes: [0, 8] } },
      { commandOptions: { inheritEnv: false } },
    ])
      expect(await request(changes)).not.toEqual(original);
    expect(() => waitRequest({ timeoutMs: 600_000, poll })).toThrow(
      'Command poll identity must be prepared before its wait request.',
    );
  });

  it('refuses a changed command, output or done under the same ID, but not changed policy', async () => {
    const clock = new Clock();
    const file = join(stateDir, 'count');
    const base = {
      every: 30_000,
      timeoutMs: 600_000,
      command: counter(file, 99),
      output: counted,
      done: (output: z.infer<typeof counted>) =>
        output.ready ? { done: true as const, value: output.n } : { done: false as const },
    };
    const options = run('command-identity', { clock });
    expect((await runWorkflow(commandPoll('identity', base), options)).status).toBe('suspended');
    const resume = (changes: Record<string, unknown>) =>
      runWorkflow(commandPoll('identity', { ...base, ...changes }), { ...options, resume: true });
    for (const policy of [
      { live: true },
      { observeTimeoutMs: 5_000 },
      { onError: { tolerate: 3 } },
      { commandOptions: { maxOutputBytes: 4096 } },
    ])
      expect((await resume(policy)).status).toBe('suspended');
    for (const changed of [
      { command: counter(file, 98) },
      { output: counted.extend({ extra: z.string().optional() }) },
      { done: () => ({ done: false as const, note: 'changed' }) },
    ])
      await expect(resume(changed)).rejects.toThrow(
        'Step ci: wait changed; use a new ID for a different decision, dependency, or deadline.',
      );
    expect(await readFile(file, 'utf8')).toBe('1');
  });

  it('rejects a malformed command poll when the wait opens', async () => {
    const valid = {
      every: 1,
      timeoutMs: 60_000,
      command: node('process.stdout.write("{}")'),
      output: counted,
      done: () => ({ done: false as const }),
    };
    const cases: [Record<string, unknown>, string][] = [
      [
        { observe: () => Promise.resolve({ done: false }) },
        'Poll source takes an observe callback or a command, not both.',
      ],
      [{ output: { parse: () => null } }, 'Poll command output must be a Zod schema.'],
      [{ done: 'yes' }, 'Poll command requires a done callback.'],
      [{ command: [] }, 'Poll command is invalid'],
      [{ commandOptions: { timeout: 5 } }, 'Poll commandOptions are invalid'],
      [{ commandOptions: { timeoutMs: 5 } }, 'Poll commandOptions are invalid'],
      [{ commandOptions: { onError: 'return' } }, 'Poll commandOptions are invalid'],
      [{ live: 'yes' }, 'Poll live must be a boolean.'],
      [
        { command: undefined, done: undefined },
        'Poll source requires an observe callback or a command.',
      ],
    ];
    for (const [index, [changes, message]] of cases.entries()) {
      const runId = `invalid-${String(index)}`;
      await expect(
        runWorkflow(commandPoll(runId, { ...valid, ...changes }), run(runId)),
        message,
      ).rejects.toThrow(message);
    }
  });

  it('applies noteSchema to the notes done returns', async () => {
    const definition = commandPoll('command-note', {
      every: 1,
      timeoutMs: 60_000,
      command: counter(join(stateDir, 'count'), 99),
      output: counted,
      noteSchema: z.object({ green: z.boolean() }),
      done: (output) => ({ done: false, note: { green: output.n } as unknown as JsonValue }),
    });
    const error = await runWorkflow(definition, run('command-note')).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(WorkflowRunError);
    const cause = (error as WorkflowRunError).cause as Error & { code?: string };
    expect(cause.message).toContain(
      'Wait ci: the note returned by done does not match noteSchema:',
    );
    expect(cause.code).toBe('QUIET_CHOIR_POLL_NOTE_INVALID');
  });

  it('runs done under the observer guard, so it cannot call context operations', async () => {
    const definition = defineWorkflow({
      name: 'done-guard',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        ctx.poll('ci', {
          input: null,
          schema: z.null(),
          every: 1,
          timeoutMs: 60_000,
          command: node('process.stdout.write("{}")'),
          output: z.object({}),
          done: () => {
            ctx.log('inside done');
            return { done: true, value: null };
          },
        }),
    });
    await expect(runWorkflow(definition, run('done-guard'))).rejects.toThrow(
      'Poll observers cannot call context operations.',
    );
  });

  it('kills the running command when the run signal aborts, like ctx.exec', async () => {
    const pidFile = join(stateDir, 'pid');
    const controller = new AbortController();
    const definition = commandPoll('command-abort', {
      every: 1,
      timeoutMs: 600_000,
      command: node(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ),
      output: counted,
      done: (output) => ({ done: true, value: output.n }),
    });
    const running = runWorkflow(
      definition,
      run('command-abort', { signal: controller.signal }),
    ).catch((error: unknown) => error);
    await vi.waitFor(
      () => {
        if (!existsSync(pidFile)) throw new Error('command not started');
      },
      { timeout: 10_000, interval: 20 },
    );
    const pid = Number(await readFile(pidFile, 'utf8'));
    controller.abort(new Error('stop'));
    await running;
    expect((await readRun({ stateDir, runId: 'command-abort' })).status).toBe('cancelled');
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }) as Error);
  });
});

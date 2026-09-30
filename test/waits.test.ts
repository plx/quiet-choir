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
  z,
  type WorkflowClock,
  type PollOptions,
} from '../src/index.js';

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

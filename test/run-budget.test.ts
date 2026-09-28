import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  summarizeUsage,
  RunBudgetExceededError,
  z,
  type Harness,
} from '../src/index.js';
import { parseRunBudget } from '../src/cli/run-budget.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'choir-budget-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const base = { name: 'budget', version: '1', input: z.null(), output: z.null() };

it.each(['cost', 'attempts'] as const)(
  'refuses queued %s calls without a record, drains abort-mode maps, and resumes with a higher cap',
  async (metric) => {
    const stateDir = await directory();
    const started = deferred();
    const firstDone = deferred();
    const secondDone = deferred();
    let calls = 0;
    const signals: AbortSignal[] = [];
    const harness: Harness = {
      async invoke(_request, context) {
        const n = ++calls;
        signals.push(context.signal);
        if (calls === 2) started.resolve();
        if (n === 1) await firstDone.promise;
        if (n === 2) await secondDone.promise;
        expect(context.signal.aborted).toBe(false);
        return {
          text: 'done',
          sessionId: null,
          usage: { costUsd: metric === 'cost' ? 0.1 : null },
        };
      },
    };
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.map('agents', [0, 1, 2, 3], { concurrency: 4, onError: 'abort' }, async () => {
          await ctx.claude.text('call', { prompt: 'x', onError: 'return' });
        });
        return null;
      },
    });
    const caps = metric === 'cost' ? { maxRunCostUsd: 0.1 } : { maxRunAgentAttempts: 2 };
    let settled = false;
    const running = runWorkflow(definition, {
      runId: 'cap',
      stateDir,
      input: null,
      agentLimit: 2,
      harness,
      ...caps,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await started.promise;
    firstDone.resolve();
    // Wait for the first durable completion, leaving another paid call active.
    for (let i = 0; i < 200; i++) {
      const saved = await readRun({ stateDir, runId: 'cap' });
      if (Object.values(saved.steps).some((step) => step.status === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(settled).toBe(false);
    expect(calls).toBe(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    secondDone.resolve();
    const failure = await running;
    expect(failure).toBeInstanceOf(Error);
    const saved = await readRun({ stateDir, runId: 'cap' });
    expect(saved.status).toBe('failed');
    expect(Object.keys(saved.steps)).toHaveLength(2);
    expect(Object.values(saved.steps).every((step) => step.status === 'completed')).toBe(true);
    expect(saved.budgetStop?.metric).toBe(
      metric === 'cost' ? 'maxRunCostUsd' : 'maxRunAgentAttempts',
    );
    const resumed = await runWorkflow(definition, {
      runId: 'cap',
      stateDir,
      resume: true,
      harness,
      agentLimit: 2,
      ...(metric === 'cost' ? { maxRunCostUsd: 1 } : { maxRunAgentAttempts: 4 }),
    });
    expect(resumed.status).toBe('completed');
    expect(calls).toBe(4);
    expect(summarizeUsage(resumed).attempts).toBe(4);
  },
);

it('latches even when caught, refuses later attempts and persists caps across resume', async () => {
  const stateDir = await directory();
  let calls = 0;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.text('one', { prompt: 'one' });
      for (const id of ['two', 'three']) {
        try {
          await ctx.codex.text(id, { prompt: id, onError: 'return' });
        } catch (error) {
          expect(error).toBeInstanceOf(RunBudgetExceededError);
        }
      }
      return null;
    },
  });
  const harness: Harness = {
    invoke: () => {
      calls++;
      return Promise.resolve({ text: 'ok', sessionId: null });
    },
  };
  const options = { stateDir, runId: 'latch', harness };
  await expect(
    runWorkflow(definition, { ...options, input: null, maxRunAgentAttempts: 1 }),
  ).rejects.toThrow('maxRunAgentAttempts');
  await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
    'maxRunAgentAttempts',
  );
  expect(calls).toBe(1);
  const record = await readRun(options);
  expect(Object.keys(record.steps)).toEqual(['one']);
  expect(record.status).toBe('failed');
  const done = await runWorkflow(definition, {
    ...options,
    resume: true,
    maxRunAgentAttempts: null,
  });
  expect(done.status).toBe('completed');
  expect(calls).toBe(3);
});

it('counts retries and refuses the next retry without altering failed-attempt evidence', async () => {
  const stateDir = await directory();
  let calls = 0;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('retry', {
        prompt: 'x',
        retry: { maxAttempts: 5, delayMs: 0 },
        onError: 'return',
      });
      return null;
    },
  });
  await expect(
    runWorkflow(definition, {
      stateDir,
      runId: 'retry',
      input: null,
      maxRunAgentAttempts: 2,
      harness: {
        invoke() {
          calls++;
          throw new Error('native failed');
        },
      },
    }),
  ).rejects.toThrow('maxRunAgentAttempts');
  const saved = await readRun({ stateDir, runId: 'retry' });
  expect(calls).toBe(2);
  expect(saved.status).toBe('failed');
  expect(saved.budgetStop).toMatchObject({
    stepId: 'retry',
    metric: 'maxRunAgentAttempts',
    limit: 2,
    observed: 2,
  });
  expect(saved.steps['retry']).toMatchObject({ attempts: 2, status: 'failed' });
  expect(saved.steps['retry']?.attemptHistory?.map((attempt) => attempt.status)).toEqual([
    'failed',
    'failed',
  ]);
});

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

it('cancels a budgeted first attempt queued for admission without creating its record', async () => {
  const stateDir = await directory();
  const controller = new AbortController();
  const queued = deferred();
  const invoked = deferred();
  const prompts: string[] = [];
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await Promise.all(['first', 'second'].map((id) => ctx.claude.text(id, { prompt: id })));
      return null;
    },
  });
  const running = runWorkflow(definition, {
    stateDir,
    runId: 'queued',
    input: null,
    agentLimit: 1,
    maxRunAgentAttempts: 10,
    signal: controller.signal,
    harness: {
      invoke(request, context) {
        prompts.push(request.options.prompt);
        invoked.resolve();
        return untilAborted(context.signal);
      },
    },
    onEvent(event) {
      if (event.type === 'agent.queued' && event.stepId === 'second') queued.resolve();
    },
  });
  const rejected = expect(running).rejects.toThrow('operator stop');
  await Promise.all([queued.promise, invoked.promise]);
  controller.abort(new Error('operator stop'));
  await rejected;
  const saved = await readRun({ stateDir, runId: 'queued' });
  expect(prompts).toEqual(['first']);
  expect(saved.status).toBe('cancelled');
  expect(saved.steps['first']).toMatchObject({ status: 'cancelled', attempts: 1 });
  expect(saved.steps['second']).toBeUndefined();
  expect(saved.budgetStop).toBeUndefined();
});

it('cancels a budgeted retry queued for admission instead of leaving the step failed', async () => {
  const stateDir = await directory();
  const controller = new AbortController();
  const flakyInvoked = deferred();
  const blockerQueued = deferred();
  const retryQueued = deferred();
  const blockerInvoked = deferred();
  let flakyQueues = 0;
  const prompts: string[] = [];
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const flaky = ctx.claude.text('flaky', {
        prompt: 'flaky',
        retry: { maxAttempts: 3, delayMs: 0 },
      });
      // Queue the blocker behind flaky's first attempt so its retry must wait for the slot.
      await flakyInvoked.promise;
      await Promise.all([flaky, ctx.claude.text('blocker', { prompt: 'blocker' })]);
      return null;
    },
  });
  const running = runWorkflow(definition, {
    stateDir,
    runId: 'queued-retry',
    input: null,
    agentLimit: 1,
    maxRunAgentAttempts: 10,
    signal: controller.signal,
    harness: {
      async invoke(request, context) {
        prompts.push(request.options.prompt);
        if (request.options.prompt === 'blocker') {
          blockerInvoked.resolve();
          return untilAborted(context.signal);
        }
        flakyInvoked.resolve();
        await blockerQueued.promise;
        throw new Error('flaky failed');
      },
    },
    onEvent(event) {
      if (event.type !== 'agent.queued') return;
      if (event.stepId === 'blocker') blockerQueued.resolve();
      if (event.stepId === 'flaky' && ++flakyQueues === 2) retryQueued.resolve();
    },
  });
  const rejected = expect(running).rejects.toThrow();
  await Promise.all([retryQueued.promise, blockerInvoked.promise]);
  controller.abort(new Error('operator stop'));
  await rejected;
  const saved = await readRun({ stateDir, runId: 'queued-retry' });
  expect(prompts).toEqual(['flaky', 'blocker']);
  expect(saved.status).toBe('cancelled');
  expect(saved.steps['flaky']).toMatchObject({
    status: 'cancelled',
    attempts: 1,
    error: 'Workflow cancelled.',
  });
  expect(saved.steps['flaky']?.attemptHistory?.map((attempt) => attempt.status)).toEqual([
    'failed',
  ]);
  expect(saved.steps['blocker']).toMatchObject({ status: 'cancelled', attempts: 1 });
});

it('allows local work and replays with a zero cap and validates policy before creating a run', async () => {
  const stateDir = await directory();
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.step('local', { input: null, schema: z.null(), run: () => null });
      return null;
    },
  });
  expect(
    (
      await runWorkflow(definition, {
        stateDir,
        runId: 'local',
        input: null,
        maxRunAgentAttempts: 0,
        maxRunCostUsd: 0,
      })
    ).status,
  ).toBe('completed');
  await expect(
    runWorkflow(definition, { stateDir, runId: 'invalid', input: null, maxRunCostUsd: NaN }),
  ).rejects.toThrow();
  await expect(readRun({ stateDir, runId: 'invalid' })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(parseRunBudget('0.25', '2')).toEqual({ maxRunCostUsd: 0.25, maxRunAgentAttempts: 2 });
  expect(parseRunBudget('off', 'off')).toEqual({ maxRunCostUsd: null, maxRunAgentAttempts: null });
  expect(parseRunBudget()).toEqual({});
  for (const value of ['-1', 'NaN', '1.5'])
    expect(() => parseRunBudget(undefined, value)).toThrow();
});

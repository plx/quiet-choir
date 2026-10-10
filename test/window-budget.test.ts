// The sticky --max-window-utilization gate (#168, ADR 0053): agent admission reads the admitting
// harness's latest recorded rate-limit report (#156). A refusal with a known reset suspends the run
// until that reset, which tick resumes; an unknown reset fails it like the other run caps. Every
// test injects its clock: the captured fixture's resets fall in October 2026.
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CancelledError,
  CliHarness,
  defineWorkflow,
  FanOutError,
  readRun,
  RunBudgetExceededError,
  runWorkflow,
  WorkflowRunError,
  z,
  type Harness,
  type WorkflowClock,
  type WorkflowContext,
  type WorkflowEvent,
} from '../src/index.js';
import { AttemptTranscript } from '../src/workflow/runtime/agent-transcript.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { MAX_EPOCH_MS } from '../src/workflow/runtime/clock.js';
import { FailureOrigins } from '../src/workflow/runtime/fan-out.js';
import {
  latestRateLimits,
  windowStop,
  windowSuspensionMessage,
  type RateLimitDiagnostics,
} from '../src/workflow/runtime/rate-limit.js';
import type { RunRecord, StepRecord } from '../src/workflow/runtime/record.js';
import { RunBudget, type RunBudgetPolicy } from '../src/workflow/runtime/run-budget.js';
import { summarizeUsage } from '../src/workflow/runtime/usage-summary.js';
import { recordEventLines } from '../src/workflow/loader/event-follow.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'choir-window-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// 2026-10-07T08:00:00Z, the seven_day reset of the captured claude-rate-limit-success fixture.
const T = 1_791_360_000;
const wake = T * 1000;
const hour = 3_600_000;

/** A clock that reads `at` and sleeps in real time; tests move `at` between executions. */
function clockAt(at: number): WorkflowClock & { at: number } {
  const clock = {
    at,
    now: () => clock.at,
    sleep: (milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, Math.min(milliseconds, 50));
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      }),
  };
  return clock;
}

const reportAt = (
  utilization: number,
  resetsAt: number | null = T,
  type: string | null = 'five_hour',
): RateLimitDiagnostics => ({
  status: 'allowed',
  type,
  resetsAt: null,
  windows: { five_hour: { utilization, ...(resetsAt === null ? {} : { resetsAt }) } },
});

/** Answers every call; Claude calls carry `report` as their rate-limit diagnostics. */
function harness(report: () => RateLimitDiagnostics | undefined): Harness & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    invoke(request) {
      calls.push(request.harness);
      const rateLimit = request.harness === 'claude' ? report() : undefined;
      return Promise.resolve({
        text: 'ok',
        sessionId: null,
        ...(rateLimit === undefined ? {} : { diagnostics: { rateLimit } }),
      });
    },
  };
}

const base = { name: 'window', version: '1', input: z.null(), output: z.null() } as const;
const twoClaude = defineWorkflow({
  ...base,
  async run(ctx) {
    await ctx.claude.text('one', { prompt: 'one' });
    await ctx.claude.text('two', { prompt: 'two' });
    return null;
  },
});

describe('windowStop', () => {
  const now = wake - hour;
  const limit = 0.5;
  it.each<[string, Parameters<typeof windowStop>[0], number, ReturnType<typeof windowStop>]>([
    ['admits without a report', undefined, limit, undefined],
    ['admits below the limit', reportAt(0.49), limit, undefined],
    [
      'refuses at the limit with a known reset',
      reportAt(0.5),
      limit,
      { window: 'five_hour', observed: 0.5, resetsAt: T, wakeAt: wake },
    ],
    [
      'keeps a utilization above 1',
      reportAt(1.25),
      1,
      { window: 'five_hour', observed: 1.25, resetsAt: T, wakeAt: wake },
    ],
    ['ignores an expired window', reportAt(0.9, now / 1000), limit, undefined],
    ['ignores a window that resets exactly now', reportAt(0.9, now / 1000), 0, undefined],
    [
      "takes the event's reset when its type names the window",
      { type: 'five_hour', resetsAt: T, windows: { five_hour: { utilization: 0.6 } } },
      limit,
      { window: 'five_hour', observed: 0.6, resetsAt: T, wakeAt: wake },
    ],
    [
      'never expires a window whose reset is unknown',
      { type: 'seven_day', resetsAt: 1, windows: { five_hour: { utilization: 0.6 } } },
      limit,
      { window: 'five_hour', observed: 0.6, resetsAt: null, wakeAt: null },
    ],
    [
      'wakes at the latest reset of several exceeded windows',
      {
        type: null,
        resetsAt: null,
        windows: {
          five_hour: { utilization: 0.7, resetsAt: T - 100 },
          seven_day: { utilization: 0.6, resetsAt: T },
          other: { utilization: 0.1, resetsAt: T + 100 },
        },
      },
      limit,
      { window: 'seven_day', observed: 0.6, resetsAt: T, wakeAt: wake },
    ],
    [
      'fails when one exceeded window has no known reset',
      {
        type: null,
        resetsAt: null,
        windows: {
          five_hour: { utilization: 0.7, resetsAt: T },
          seven_day: { utilization: 0.6 },
        },
      },
      limit,
      { window: 'seven_day', observed: 0.6, resetsAt: null, wakeAt: null },
    ],
    [
      'refuses any live observation at cap 0',
      reportAt(0),
      0,
      { window: 'five_hour', observed: 0, resetsAt: T, wakeAt: wake },
    ],
    ['admits below 100% at cap 1', reportAt(0.99), 1, undefined],
    [
      'rounds a fractional reset up to the next millisecond',
      reportAt(0.6, T + 0.0005),
      limit,
      { window: 'five_hour', observed: 0.6, resetsAt: T + 0.0005, wakeAt: wake + 1 },
    ],
    [
      'treats a reset beyond the last persisted millisecond as unknown',
      reportAt(0.6, MAX_EPOCH_MS),
      limit,
      { window: 'five_hour', observed: 0.6, resetsAt: MAX_EPOCH_MS, wakeAt: null },
    ],
  ])('%s', (_name, report, cap, expected) => {
    expect(windowStop(report, cap, now, MAX_EPOCH_MS)).toEqual(expected);
  });
});

describe('FailureOrigins.onlyFrom', () => {
  const stop = new Error('stop');
  const other = new Error('other');
  const cancelled = new CancelledError(null, stop, 'map');
  const fanOut = (...errors: unknown[]) =>
    new FanOutError(
      'drain',
      errors.map((error, index) => ({ index, stepId: null, error })),
      [],
    );
  it.each<[string, unknown, boolean]>([
    ['the stop itself', stop, true],
    ['an unrelated error', other, false],
    ['a wrapper whose cause is the stop', new Error('wrapped', { cause: stop }), true],
    ['a fan-out of the stop alone', fanOut(stop), true],
    ['a fan-out where siblings share the stop', fanOut(stop, stop), true],
    ['a fan-out of the stop and cancelled siblings', fanOut(stop, cancelled), true],
    ['a fan-out of the stop and an unrelated failure', fanOut(stop, other), false],
    ['a fan-out whose first failure is unrelated', fanOut(other, stop), false],
    ['a fan-out of cancellations only', fanOut(cancelled), false],
    ['an empty fan-out', fanOut(), false],
    ['nested fan-outs of the stop', fanOut(fanOut(stop), new Error('w', { cause: stop })), true],
    ['a nested fan-out with an unrelated failure', fanOut(stop, fanOut(stop, other)), false],
    [
      'a wrapper around a mixed fan-out',
      new Error('wrapped', { cause: fanOut(stop, other) }),
      false,
    ],
  ])('%s', (_name, error, expected) => {
    expect(new FailureOrigins().onlyFrom(error, stop)).toBe(expected);
  });

  it('answers false for a cause cycle that never reaches the stop', () => {
    const cycle = new Error('cycle');
    cycle.cause = new Error('back', { cause: cycle });
    expect(new FailureOrigins().onlyFrom(cycle, stop)).toBe(false);
  });
});

describe('the gate in a run', () => {
  it('refuses the next admission without a record and suspends until the reset', async () => {
    const stateDir = await directory();
    const clock = clockAt(wake - hour);
    const agent = harness(() => reportAt(0.6));
    const events: WorkflowEvent[] = [];
    const options = { stateDir, runId: 'gate', harness: agent, clock };
    const result = await runWorkflow(twoClaude, {
      ...options,
      input: null,
      maxWindowUtilization: 0.5,
      onEvent: (event) => {
        events.push(event);
      },
    });
    // Returned rather than thrown: a suspension is not a failure.
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: wake, error: null });
    expect(agent.calls).toEqual(['claude']);
    const record = await readRun(options);
    expect(Object.keys(record.steps)).toEqual(['one']);
    expect(record).toMatchObject({ status: 'suspended', nextWakeAt: wake, rootCause: null });
    expect(record.runBudget).toEqual({
      maxRunCostUsd: null,
      maxRunAgentAttempts: null,
      maxWindowUtilization: 0.5,
    });
    const stop = {
      stepId: 'two',
      metric: 'maxWindowUtilization',
      limit: 0.5,
      observed: 0.6,
      harness: 'claude',
      window: 'five_hour',
      resetsAt: T,
    } as const;
    expect(record.budgetStop).toEqual({ ...stop, at: expect.any(String) as unknown });
    expect(record.executions?.at(-1)).toMatchObject({ outcome: 'suspended', error: null });
    const message = windowSuspensionMessage({ ...stop, at: '' }, wake);
    expect(message).toBe(
      'Run suspended until 2026-10-07T08:00:00.000Z: claude five_hour window at 60% reached --max-window-utilization 0.5.',
    );
    expect(events.filter((event) => event.type === 'run.suspended')).toEqual([
      expect.objectContaining({ message }),
    ]);
    // --events derives the same message from the record.
    expect(recordEventLines(record, null, 'all').lines.some((line) => line.includes(message))).toBe(
      true,
    );

    // Resuming before the reset neither spends nor fails: it suspends again at the same time.
    clock.at = wake - 1;
    const again = await runWorkflow(twoClaude, { ...options, resume: true });
    expect(again).toMatchObject({ status: 'suspended', nextWakeAt: wake });
    expect(agent.calls).toEqual(['claude']);
    const resumed = await readRun(options);
    expect(Object.keys(resumed.steps)).toEqual(['one']);
    expect(resumed.budgetStop).toMatchObject(stop);
    expect(resumed.executions?.map((entry) => entry.outcome)).toEqual(['suspended', 'suspended']);

    // At the reset the observation has expired, so the refused step runs and the run completes.
    clock.at = wake;
    const done = await runWorkflow(twoClaude, { ...options, resume: true });
    expect(done.status).toBe('completed');
    expect(agent.calls).toEqual(['claude', 'claude']);
    const completed = await readRun(options);
    expect(completed.steps['two']?.attempts).toBe(1);
    expect(completed.budgetStop).toBeUndefined();
    expect(completed.nextWakeAt ?? null).toBeNull();
  });

  /** One admitted call records a 60% report; then a draining map runs `mapper` on two items. */
  const gatedMap = (mapper: (ctx: WorkflowContext, item: number) => Promise<void>) =>
    defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.claude.text('seed', { prompt: 'seed' });
        await ctx.map('items', [0, 1], { concurrency: 2 }, async (item) => {
          await mapper(ctx, item);
        });
        return null;
      },
    });

  it.each([
    ['after the refusal', 20, 0],
    ['before the refusal', 0, 20],
  ])('fails, not suspends, when a sibling mapper fails %s', async (_name, failAfter, askAfter) => {
    const stateDir = await directory();
    const agent = harness(() => reportAt(0.6));
    const options = { stateDir, runId: 'mixed-map', harness: agent, clock: clockAt(wake - hour) };
    const definition = gatedMap(async (ctx, item) => {
      if (item === 0) {
        await delay(askAfter);
        await ctx.claude.text('ask', { prompt: 'ask' });
      } else {
        await delay(failAfter);
        throw new Error('unrelated mapper failure');
      }
    });
    const error: unknown = await runWorkflow(definition, {
      ...options,
      input: null,
      maxWindowUtilization: 0.5,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowRunError);
    // Both members are present: the gate refused one, and the other failed on its own.
    const cause = (error as WorkflowRunError).cause;
    expect(cause).toBeInstanceOf(FanOutError);
    const members = (cause as FanOutError).failures.map((failure) => failure.error);
    expect(members).toHaveLength(2);
    expect(members.some((member) => member instanceof RunBudgetExceededError)).toBe(true);
    expect(members).toContainEqual(new Error('unrelated mapper failure'));
    const record = await readRun(options);
    expect(record.status).toBe('failed');
    expect(record.nextWakeAt ?? null).toBeNull();
    expect(record.error).toEqual(expect.any(String));
    expect(record.rootCause).not.toBeNull();
    expect(record.executions?.at(-1)).toMatchObject({ outcome: 'failed' });
    // The window stop is still the saved reason the refused call did not run.
    expect(record.budgetStop).toMatchObject({ metric: 'maxWindowUtilization', resetsAt: T });
    if (failAfter === 0) {
      expect(record.error).toBe('unrelated mapper failure');
      expect(record.rootCause).toMatchObject({ error: 'unrelated mapper failure' });
    }
    expect(agent.calls).toEqual(['claude']);
  });

  it('suspends when every mapper of a draining map is refused by the gate', async () => {
    const stateDir = await directory();
    const agent = harness(() => reportAt(0.6));
    const options = { stateDir, runId: 'refused-map', harness: agent, clock: clockAt(wake - hour) };
    const definition = gatedMap(async (ctx, item) => {
      await ctx.claude.text(`ask-${String(item)}`, { prompt: 'ask' });
    });
    const result = await runWorkflow(definition, {
      ...options,
      input: null,
      maxWindowUtilization: 0.5,
    });
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: wake, error: null });
    const record = await readRun(options);
    expect(record).toMatchObject({ status: 'suspended', nextWakeAt: wake, rootCause: null });
    expect(record.recoveryHint).toBeUndefined();
    expect(record.recoveryCause).toBeUndefined();
    expect(agent.calls).toEqual(['claude']);
  });

  it('fails like the other caps when the reset is unknown, and a higher cap continues', async () => {
    const stateDir = await directory();
    const clock = clockAt(wake - hour);
    // Claude 2.1.285: windows without resetsAt, and an event type naming another window.
    const agent = harness(() => reportAt(0.6, null, 'seven_day'));
    const options = { stateDir, runId: 'unknown', harness: agent, clock };
    const error: unknown = await runWorkflow(twoClaude, {
      ...options,
      input: null,
      maxWindowUtilization: 0.5,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowRunError);
    const cause = (error as WorkflowRunError).cause;
    expect(cause).toBeInstanceOf(RunBudgetExceededError);
    expect(cause).toMatchObject({ code: 'QUIET_CHOIR_RUN_BUDGET' });
    expect((cause as Error).message).toBe(
      'Run unknown: claude five_hour window at 60% reached --max-window-utilization 0.5; the window reported no usable reset time, so the run cannot wait for it; refused agent step two. Active attempts were allowed to finish. Resume with a higher --max-window-utilization value or --max-window-utilization off; completed calls replay without new spend.',
    );
    const record = await readRun(options);
    expect(record.status).toBe('failed');
    expect(record.budgetStop).toMatchObject({ metric: 'maxWindowUtilization', resetsAt: null });
    expect(record.nextWakeAt ?? null).toBeNull();
    expect(Object.keys(record.steps)).toEqual(['one']);
    expect(record.recoveryHint).toContain('--max-window-utilization');
    expect(record.recoveryHint).toContain('--resume');
    expect(record.recoveryHint).not.toContain('re-finalize');
    expect(record.recoveryCause).toEqual({ kind: 'budget', flag: '--max-window-utilization' });

    const done = await runWorkflow(twoClaude, {
      ...options,
      resume: true,
      maxWindowUtilization: 0.9,
    });
    expect(done.status).toBe('completed');
    // The completed call replays; only the refused one runs.
    expect(agent.calls).toEqual(['claude', 'claude']);
    expect((await readRun(options)).runBudget?.maxWindowUtilization).toBe(0.9);
  });

  it('never refuses a run without a rate-limit observation, even at cap 0', async () => {
    const stateDir = await directory();
    const agent = harness(() => undefined);
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        for (const id of ['a', 'b', 'c']) await ctx.claude.text(id, { prompt: id });
        return null;
      },
    });
    const result = await runWorkflow(definition, {
      stateDir,
      runId: 'none',
      input: null,
      harness: agent,
      clock: clockAt(wake - hour),
      maxWindowUtilization: 0,
    });
    expect(result.status).toBe('completed');
    expect(agent.calls).toEqual(['claude', 'claude', 'claude']);
  });

  it("admits Codex while Claude's windows refuse, and reads ctx.agent('claude') by harness", async () => {
    const stateDir = await directory();
    const agent = harness(() => reportAt(0.6));
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.claude.text('claude', { prompt: 'x' });
        await ctx.codex.text('codex', { prompt: 'x' });
        await ctx.agent('claude').text('named', { prompt: 'x' });
        return null;
      },
    });
    const result = await runWorkflow(definition, {
      stateDir,
      runId: 'mixed',
      input: null,
      harness: agent,
      clock: clockAt(wake - hour),
      maxWindowUtilization: 0.5,
    });
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: wake });
    expect(agent.calls).toEqual(['claude', 'codex']);
    const record = await readRun({ stateDir, runId: 'mixed' });
    expect(record.steps['codex']?.status).toBe('completed');
    expect(record.steps['named']).toBeUndefined();
    expect(record.budgetStop).toMatchObject({ stepId: 'named', harness: 'claude' });
  });

  it.each([
    ['suspends on the new harness window', 0.1, 0.9, 'suspended'],
    ['admits when only the prior harness window is exceeded', 0.9, 0.1, 'completed'],
  ] as const)(
    'redefining a step across harnesses %s',
    async (_name, claudeUtilization, codexUtilization, status) => {
      const stateDir = await directory();
      const utilization = { claude: claudeUtilization, codex: codexUtilization };
      const calls: string[] = [];
      const agent: Harness = {
        invoke(request) {
          calls.push(`${request.harness}:${request.stepId}`);
          if (request.stepId === 'tuned' && request.harness === 'claude')
            return Promise.reject(new Error('tuned failed'));
          const report = reportAt(utilization[request.harness as 'claude' | 'codex']);
          return Promise.resolve({
            text: 'ok',
            sessionId: null,
            diagnostics: { rateLimit: report },
          });
        },
      };
      const workflowWith = (tuned: 'claude' | 'codex') =>
        defineWorkflow({
          ...base,
          async run(ctx) {
            await ctx.claude.text('seed-claude', { prompt: 'x' });
            await ctx.codex.text('seed-codex', { prompt: 'x' });
            await ctx[tuned].text('tuned', { prompt: 'x' });
            return null;
          },
        });
      const options = { stateDir, runId: 'redefine', harness: agent, clock: clockAt(wake - hour) };
      await expect(
        runWorkflow(workflowWith('claude'), { ...options, input: null, fingerprint: 'code-1' }),
      ).rejects.toThrow();
      expect((await readRun(options)).steps['tuned']?.status).toBe('failed');
      calls.length = 0;

      const result = await runWorkflow(workflowWith('codex'), {
        ...options,
        resume: true,
        fingerprint: 'code-2',
        acceptCodeChange: true,
        maxWindowUtilization: 0.5,
      });
      expect(result.status).toBe(status);
      const record = await readRun(options);
      if (status === 'suspended') {
        // The refusal names the window of the harness the step now runs on, never the prior one;
        // the step stays unredefined because it was never admitted.
        expect(calls).toEqual([]);
        expect(record.steps['tuned']?.redefinitions).toBeUndefined();
        expect(record.budgetStop).toMatchObject({
          stepId: 'tuned',
          harness: 'codex',
          observed: 0.9,
        });
        expect(result).toMatchObject({ nextWakeAt: wake });
      } else {
        expect(calls).toEqual(['codex:tuned']);
        expect(record.steps['tuned']?.redefinitions).toHaveLength(1);
        expect(record.budgetStop).toBeUndefined();
      }
    },
  );

  it('counts a committed report while its on-failure transcript discard is still pending', async () => {
    const stateDir = await directory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let discarding!: () => void;
    const discardStarted = new Promise<void>((resolve) => {
      discarding = resolve;
    });
    vi.spyOn(AttemptTranscript.prototype, 'discard').mockImplementation(async () => {
      discarding();
      await gate;
    });
    const agent = harness(() => reportAt(0.9));
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.map('items', [0, 1], { concurrency: 2 }, async (item) => {
          if (item === 0) {
            await ctx.claude.text('first', { prompt: 'first' });
            return;
          }
          // The first attempt has committed and is discarding its transcript, still admitted.
          await discardStarted;
          // Settles the discard only after the sibling's admission check has run.
          setTimeout(release, 50);
          await ctx.claude.text('sibling', { prompt: 'sibling' });
        });
        return null;
      },
    });
    const options = { stateDir, runId: 'discard', harness: agent, clock: clockAt(wake - hour) };
    const result = await runWorkflow(definition, {
      ...options,
      input: null,
      maxWindowUtilization: 0.5,
      policy: [{ transcripts: 'on-failure' }],
    });
    release();
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: wake });
    expect(agent.calls).toEqual(['claude']);
    const record = await readRun(options);
    expect(record.steps['items/0/first']?.status).toBe('completed');
    expect(record.steps['items/1/sibling']).toBeUndefined();
    expect(record.budgetStop).toMatchObject({
      stepId: 'items/1/sibling',
      observed: 0.9,
      resetsAt: T,
    });
  });

  it('wakes at an earlier wait deadline, so the gate does not delay a timeout', async () => {
    const stateDir = await directory();
    const clock = clockAt(wake - hour);
    const agent = harness(() => reportAt(0.6));
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await Promise.all([
          ctx.wait('timer', { timeoutMs: 600_000 }),
          (async () => {
            await ctx.claude.text('one', { prompt: 'one' });
            await ctx.claude.text('two', { prompt: 'two' });
          })(),
        ]);
        return null;
      },
    });
    const result = await runWorkflow(definition, {
      stateDir,
      runId: 'wait',
      input: null,
      harness: agent,
      clock,
      maxWindowUtilization: 0.5,
    });
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: wake - hour + 600_000 });
    expect((await readRun({ stateDir, runId: 'wait' })).steps['timer']?.status).toBe('waiting');
  });

  it('keeps the cap on resume, clears it with null or policyReset, and leaves identity alone', async () => {
    const stateDir = await directory();
    const agent = harness(() => undefined);
    const clock = clockAt(wake - hour);
    const run = (runId: string, extra: Record<string, unknown>) =>
      runWorkflow(twoClaude, { stateDir, runId, harness: agent, clock, ...extra });
    const cap = async (runId: string) =>
      (await readRun({ stateDir, runId })).runBudget?.maxWindowUtilization;
    await run('capped', { input: null, maxWindowUtilization: 0.5 });
    await run('plain', { input: null });
    expect(await cap('capped')).toBe(0.5);
    expect(await cap('plain')).toBeNull();
    await run('capped', { resume: true });
    expect(await cap('capped')).toBe(0.5);
    await run('capped', { resume: true, maxWindowUtilization: null });
    expect(await cap('capped')).toBeNull();
    await run('capped', { resume: true, maxWindowUtilization: 1 });
    expect(await cap('capped')).toBe(1);
    await run('capped', { resume: true, policyReset: true });
    expect(await cap('capped')).toBeNull();
    const identities = async (runId: string) =>
      Object.fromEntries(
        Object.entries((await readRun({ stateDir, runId })).steps).map(([id, step]) => [
          id,
          { fingerprint: step.fingerprint, identity: step.identity },
        ]),
      );
    expect(await identities('capped')).toEqual(await identities('plain'));
    await expect(run('invalid', { input: null, maxWindowUtilization: 1.5 })).rejects.toThrow();
  });

  it('suspends a run of the built-in Claude adapter on the captured seven_day window', async () => {
    const stateDir = await directory();
    vi.stubEnv('QUIET_CHOIR_FAKE_SCENARIO', 'claude-rate-limit-success');
    const result = await runWorkflow(twoClaude, {
      stateDir,
      runId: 'fixture',
      cwd: stateDir,
      input: null,
      // Before both captured resets: the five_hour window (1%) stays below the cap.
      clock: clockAt(1_791_014_400_000 - hour),
      maxWindowUtilization: 0.5,
      harness: new CliHarness({
        claudeBinary: fileURLToPath(new URL('./bin/fake-claude.mjs', import.meta.url)),
        killGraceMs: 20,
      }),
    });
    expect(result).toMatchObject({ status: 'suspended', nextWakeAt: 1_791_360_000_000 });
    const record = await readRun({ stateDir, runId: 'fixture' });
    expect(Object.keys(record.steps)).toEqual(['one']);
    expect(record.budgetStop).toMatchObject({
      stepId: 'two',
      metric: 'maxWindowUtilization',
      limit: 0.5,
      observed: 0.84,
      harness: 'claude',
      window: 'seven_day',
      resetsAt: 1_791_360_000,
    });
  });
});

describe('tick', () => {
  const logger = new ThresholdLogger('silent', () => undefined);

  // measured: 0.9 s alone, 2.5 s in a full local coverage run, 5.0 s on the Node 22.13 CI leg and
  // 4.5 s on Node 26 (typecheck analysis and tsImport compiles of the workflow).
  it('leaves a gated run until its reset, then resumes and completes it', async () => {
    const root = await directory();
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'window', version: '1', input: z.null(), output: z.null(),
  run: async (ctx) => {
    await ctx.claude.text('one', { prompt: 'one' });
    await ctx.claude.text('two', { prompt: 'two' });
    return null;
  },
});
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, root);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const stateDir = join(root, 'state');
    const agent = harness(() => reportAt(0.6));
    const first = await new WorkflowExecutor({
      logger,
      harness: agent,
      clock: clockAt(wake - hour),
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'run',
      stateDir,
      cwd: root,
      resume: false,
      input: null,
      maxWindowUtilization: 0.5,
    });
    expect(first).toMatchObject({
      ok: true,
      run: { status: 'suspended', nextWakeAt: wake },
    });
    const tick = (at: number) =>
      new TickWorkflowExecutor({ logger, harness: agent, clock: clockAt(at) }).execute({
        kind: 'workflow.tick',
        runId: 'run',
        stateDir,
      });
    expect(await tick(wake - 1)).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'run', reason: 'not due', nextWakeAt: wake }],
    });
    expect(agent.calls).toEqual(['claude']);
    expect(await tick(wake)).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      exitCode: 0,
    });
    expect(agent.calls).toEqual(['claude', 'claude']);
    const done = await readRun({ stateDir, runId: 'run' });
    expect(done.status).toBe('completed');
    expect(done.steps['two']?.attempts).toBe(1);
  }, 15_000);
});

// The gate keeps the latest report per harness as attempts settle instead of rescanning the step
// map on every admission (#378). Synthetic records, as in test/rate-limit.test.ts; a Proxy around
// `record.steps` counts how often admission enumerates it.
describe('RunBudget rate-limit cache', () => {
  const minute = 60_000;
  const base = wake - 10 * hour;
  const live = wake - hour;
  const gate: RunBudgetPolicy = {
    maxRunCostUsd: null,
    maxRunAgentAttempts: null,
    maxWindowUtilization: 0.5,
  };
  const attemptAt = (
    attempt: number,
    at: number,
    report: RateLimitDiagnostics | undefined,
    harness = 'claude',
  ) => ({
    attempt,
    startedAt: new Date(at - minute).toISOString(),
    finishedAt: new Date(at).toISOString(),
    status: 'completed',
    request: { harness },
    usage: null,
    ...(report === undefined ? {} : { diagnostics: { rateLimit: report } }),
  });
  const agentStep = (
    seq: number,
    at: number,
    report: RateLimitDiagnostics | undefined,
    harness = 'claude',
  ) =>
    ({
      kind: harness,
      seq,
      status: 'completed',
      attempts: 1,
      attemptHistory: [attemptAt(1, at, report, harness)],
    }) as unknown as StepRecord;
  function counted(steps: Record<string, StepRecord>): {
    record: RunRecord;
    steps: Record<string, StepRecord>;
    target: Record<string, StepRecord>;
    enumerations: () => number;
  } {
    let enumerations = 0;
    const proxy = new Proxy(steps, {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    });
    return {
      record: { id: 'cache', steps: proxy } as unknown as RunRecord,
      steps: proxy,
      target: steps,
      enumerations: () => {
        const value = enumerations;
        enumerations = 0;
        return value;
      },
    };
  }
  /** What the gate decided before #378: a full scan of the steps (uncounted) on this admission. */
  const scanned = (steps: Record<string, StepRecord>, harness: string, now: number) =>
    windowStop(latestRateLimits(Object.entries(steps))[harness], 0.5, now, MAX_EPOCH_MS);
  const refusal = (error: RunBudgetExceededError | undefined) =>
    error && {
      window: error.stop.window,
      observed: error.stop.observed,
      resetsAt: error.stop.resetsAt,
    };

  it.each([
    ['the latest report is live', T, T - 2 * 3600, live, 0.9],
    ['the latest report expired, though an earlier one is live', T - 2 * 3600, T, live, undefined],
    ['every report expired', T, T, wake, undefined],
  ] as const)(
    'seeds from a saved record when %s, as a full scan decides',
    (_name, latestReset, earlierReset, now, observed) => {
      const { record, target } = counted({
        earlier: agentStep(1, base, reportAt(0.9, earlierReset)),
        latest: agentStep(2, base + minute, reportAt(0.9, latestReset)),
      });
      const expected = scanned(target, 'claude', now);
      expect(expected?.observed).toBe(observed);
      const budget = new RunBudget(record, gate, clockAt(now));
      expect(budget.check('codex-next', 'codex')).toBeUndefined();
      const error = budget.check('next', 'claude');
      expect(refusal(error)).toEqual(
        expected && {
          window: expected.window,
          observed: expected.observed,
          resetsAt: expected.resetsAt,
        },
      );
      expect(budget.wakeAt).toBe(expected?.wakeAt ?? null);
    },
  );

  it('folds a report in when its admitted attempt releases', () => {
    const { record, steps, target, enumerations } = counted({
      one: agentStep(1, base, reportAt(0.1)),
    });
    const budget = new RunBudget(record, gate, clockAt(live));
    expect(budget.check('two', 'claude')).toBeUndefined();
    enumerations();
    const release = budget.enter('two');
    steps['two'] = agentStep(2, base + minute, reportAt(0.9));
    // A report counts once its attempt has settled and released, as a resumed run would see it.
    expect(budget.check('three', 'claude')).toBeUndefined();
    release();
    release();
    expect(budget.check('three', 'claude')?.stop).toMatchObject({ stepId: 'three', observed: 0.9 });
    expect(scanned(target, 'claude', live)?.observed).toBe(0.9);
    expect(enumerations()).toBe(0);
  });

  it('counts a failed attempt before its retry backoff through observe', () => {
    const { record, steps } = counted({});
    const budget = new RunBudget(record, gate, clockAt(live));
    expect(budget.check('retried', 'claude')).toBeUndefined();
    budget.enter('retried');
    steps['retried'] = agentStep(1, base, reportAt(0.9));
    budget.observe('retried');
    expect(budget.check('other', 'claude')?.stop.observed).toBe(0.9);
  });

  it.each([
    ['the later-finishing attempt releases first', ['late', 'early'], 0.9, 0.1],
    ['the earlier-finishing attempt releases first', ['early', 'late'], 0.9, 0.1],
    ['the later-finishing low report releases first', ['late', 'early'], 0.1, 0.9],
    ['the later-finishing low report releases last', ['early', 'late'], 0.1, 0.9],
  ] as const)(
    'keeps the later-finishing report of two concurrent attempts when %s',
    (_name, order, lateUtilization, earlyUtilization) => {
      const { record, steps, target, enumerations } = counted({
        seed: agentStep(1, base, reportAt(0.1)),
      });
      const budget = new RunBudget(record, gate, clockAt(live));
      expect(budget.check('late', 'claude')).toBeUndefined();
      expect(budget.check('early', 'claude')).toBeUndefined();
      enumerations();
      const releases = { late: budget.enter('late'), early: budget.enter('early') };
      // The later-started attempt finishes first in time but may release in either order.
      steps['late'] = agentStep(2, base + 3 * minute, reportAt(lateUtilization));
      steps['early'] = agentStep(3, base + 2 * minute, reportAt(earlyUtilization));
      for (const id of order) releases[id]();
      const expected = scanned(target, 'claude', live);
      expect(budget.check('next', 'claude')?.stop.observed).toBe(expected?.observed);
      expect(expected?.observed).toBe(lateUtilization >= 0.5 ? lateUtilization : undefined);
      expect(enumerations()).toBe(0);
    },
  );

  it('rescans once when a redefinition rewrites the step that holds the latest report', () => {
    const holder = agentStep(2, base + minute, reportAt(0.1));
    const { record, target, enumerations } = counted({
      other: agentStep(1, base, reportAt(0.9)),
      holder,
    });
    const budget = new RunBudget(record, gate, clockAt(live));
    expect(budget.check('next', 'claude')).toBeUndefined();
    enumerations();
    // Redefined as a local step: its attempts leave the projection.
    holder.kind = 'step';
    budget.observe('holder');
    expect(enumerations()).toBe(0);
    expect(scanned(target, 'claude', live)?.observed).toBe(0.9);
    expect(budget.check('next', 'claude')?.stop).toMatchObject({ observed: 0.9 });
    expect(enumerations()).toBe(1);
  });

  it('folds a redefined step that holds no latest report in place, without a rescan', () => {
    const moved = agentStep(1, base, reportAt(0.9));
    const { record, target, enumerations } = counted({
      moved,
      holder: agentStep(2, base + minute, reportAt(0.1)),
    });
    const budget = new RunBudget(record, gate, clockAt(live));
    expect(budget.check('next', 'codex')).toBeUndefined();
    enumerations();
    // Redefined across harnesses: its report now belongs to Codex.
    moved.kind = 'codex';
    moved.attemptHistory = (moved.attemptHistory ?? []).map((attempt) => ({
      ...attempt,
      request: { harness: 'codex' } as never,
    }));
    budget.observe('moved');
    expect(budget.check('next', 'claude')).toBeUndefined();
    expect(budget.check('next', 'codex')?.stop).toMatchObject({ harness: 'codex', observed: 0.9 });
    expect(scanned(target, 'codex', live)?.observed).toBe(0.9);
    expect(enumerations()).toBe(0);
  });

  it.each([100, 10_000])(
    'admits without enumerating %i steps after the first window check',
    (count) => {
      const { record, steps, enumerations } = counted(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `s${String(index)}`,
            agentStep(index + 1, base + index, reportAt(0.1)),
          ]),
        ),
      );
      const budget = new RunBudget(record, gate, clockAt(live));
      // The constructor's attempt count, once per execution.
      enumerations();
      expect(budget.check('first', 'claude')).toBeUndefined();
      expect(enumerations()).toBe(1);
      for (let index = 0; index < 1_000; index++) {
        const id = `n${String(index)}`;
        expect(budget.check(id, index % 2 ? 'codex' : 'claude')).toBeUndefined();
        const release = budget.enter(id);
        steps[id] = agentStep(count + index + 1, base + count + index, reportAt(0.2));
        release();
      }
      expect(enumerations()).toBe(0);
    },
  );

  it('still sums recorded usage for the cost cap, integration usage included', () => {
    const paid = (seq: number, costUsd: number) =>
      ({
        ...agentStep(seq, base + seq, reportAt(0.1)),
        attemptHistory: [{ ...attemptAt(1, base + seq, reportAt(0.1)), usage: { costUsd } }],
      }) as unknown as StepRecord;
    const local = {
      kind: 'step',
      seq: 3,
      status: 'completed',
      attempts: 1,
      attemptHistory: [
        {
          ...attemptAt(1, base, undefined),
          request: undefined,
          integration: 'github',
          usage: { costUsd: 0.125 },
        },
      ],
    } as unknown as StepRecord;
    const { record } = counted({ one: paid(1, 0.25), two: paid(2, 0.25), local });
    const usage = summarizeUsage(record);
    const total = (usage.costUsd ?? 0) + (usage.integrationUsage.costUsd ?? 0);
    expect(total).toBe(0.625);
    const budget = new RunBudget(record, { ...gate, maxRunCostUsd: 0.6 }, clockAt(live));
    expect(budget.check('next', 'claude')?.stop).toMatchObject({
      metric: 'maxRunCostUsd',
      limit: 0.6,
      observed: total,
    });
  });
});

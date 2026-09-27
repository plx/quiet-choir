import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';

import {
  defineWorkflow,
  CheckpointError,
  CliHarness,
  HarnessError,
  readRun,
  runWorkflow,
  z,
  type AgentResult,
  type ErrorKind,
  type Harness,
  type HarnessRequest,
  type Settled,
  type WorkflowContext,
  type WorkflowEvent,
} from '../src/index.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';

let stateDir: string;
const options = () => ({ stateDir, runId: 'outcomes', input: null });
const workflow = (run: (ctx: WorkflowContext) => Promise<string>) =>
  defineWorkflow({ name: 'outcomes', version: '1', input: z.null(), output: z.string(), run });
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
const failure = (kind: ErrorKind) =>
  new HarnessError({
    provider: 'claude',
    kind,
    exit: { code: 1, signal: null },
    failure: null,
    reason: kind,
    stderr: '',
    stdout: '',
    usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 },
  });
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-settled-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('replays a handled primary failure and its original fallback after the primary heals', async () => {
  let broken = true;
  const calls: string[] = [];
  const events: WorkflowEvent[] = [];
  const harness: Harness = {
    invoke(request) {
      calls.push(request.options.prompt);
      expect(request.options).not.toHaveProperty('onError');
      expect(request.options).not.toHaveProperty('retry');
      if (broken && ['primary', 'final'].includes(request.options.prompt))
        return Promise.reject(failure('timeout'));
      return Promise.resolve({ ...reply, text: request.options.prompt });
    },
  };
  const definition = workflow(async (ctx) => {
    const first = await ctx.claude.text('draft', { prompt: 'primary', onError: 'return' });
    expectTypeOf(first).toEqualTypeOf<Settled<AgentResult<string>>>();
    const draft = first.ok
      ? first.value.output
      : (await ctx.codex.text('fallback', { prompt: 'fallback' })).output;
    return draft + (await ctx.claude.text('final', { prompt: 'final' })).output;
  });
  await expect(
    runWorkflow(definition, {
      ...options(),
      harness,
      onEvent: (e) => {
        events.push(e);
      },
    }),
  ).rejects.toThrow('timeout');
  const before = (await readRun(options())).steps['draft'];
  expect(before).toMatchObject({
    status: 'settled-failed',
    settledError: { kind: 'timeout', attempts: 1 },
    failedAttempts: [{ usage: { costUsd: 0.01 } }],
    attemptHistory: [{ errorKind: 'timeout', status: 'failed' }],
  });
  expect(events.some((event) => event.type === 'step.settled' && event.stepId === 'draft')).toBe(
    true,
  );
  broken = false;
  const result = await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(result.output).toBe('fallbackfinal');
  expect(calls).toEqual(['primary', 'fallback', 'final', 'final']);
  expect(result.steps['draft']).toEqual(before);
});

it('journals local and structured failures and successes with inferred result types', async () => {
  let tail = true;
  const local = vi.fn(() => {
    throw new Error('local unavailable');
  });
  const harness = { invoke: vi.fn(() => Promise.resolve({ ...reply, text: '{"answer":7}' })) };
  const definition = workflow(async (ctx) => {
    const failed = await ctx.step('local', {
      input: null,
      schema: z.string(),
      onError: 'return',
      run: local,
    });
    expectTypeOf(failed).toEqualTypeOf<Settled<string>>();
    expect(failed).toEqual({
      ok: false,
      error: { message: 'local unavailable', kind: 'unknown', attempts: 1 },
    });
    const invalid = await ctx.codex.object('invalid', {
      prompt: 'p',
      onError: 'return',
      schema: z.object({ answer: z.string() }),
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.kind).toBe('schema');
    const valid = await ctx.claude.object<{ answer: number }>('valid', {
      prompt: 'p',
      onError: 'return',
      schema: z.object({ answer: z.number() }),
    });
    expectTypeOf(valid).toEqualTypeOf<Settled<AgentResult<{ answer: number }>>>();
    expect(valid).toMatchObject({ ok: true, value: { output: { answer: 7 } } });
    const success = await ctx.step<number>('success', {
      input: null,
      schema: z.number(),
      onError: 'return',
      run: () => 5,
    });
    expect(success).toEqual({ ok: true, value: 5 });
    if (tail) throw new Error('tail');
    return 'done';
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('tail');
  tail = false;
  await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(local).toHaveBeenCalledTimes(1);
  expect(harness.invoke).toHaveBeenCalledTimes(2);
});

it('uses one ID for selective agent retries and preserves every attempt error', async () => {
  let tail = true;
  const harness = {
    invoke: vi.fn(() => {
      if (harness.invoke.mock.calls.length < 3) return Promise.reject(failure('rate-limit'));
      return Promise.resolve(reply);
    }),
  };
  const definition = workflow(async (ctx) => {
    const result = await ctx.claude.text('ask', {
      prompt: 'p',
      retry: { maxAttempts: 3, delayMs: 0, on: ['rate-limit'] },
      onError: 'return',
    });
    if (tail) throw new Error('tail');
    return result.ok ? result.value.output : result.error.message;
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('tail');
  tail = false;
  const result = await runWorkflow(definition, {
    ...options(),
    harness,
    resume: true,
    policy: [{ retry: { maxAttempts: 10, on: ['timeout'] } }],
  });
  expect(result.output).toBe('ok');
  expect(Object.keys(result.steps)).toEqual(['ask']);
  expect(harness.invoke).toHaveBeenCalledTimes(3);
  expect(
    result.steps['ask']?.attemptHistory?.map((attempt) => [
      attempt.status,
      attempt.errorKind,
      attempt.error,
    ]),
  ).toEqual([
    ['failed', 'rate-limit', expect.stringContaining('rate-limit')],
    ['failed', 'rate-limit', expect.stringContaining('rate-limit')],
    ['completed', undefined, null],
  ]);
});

it.each([undefined, [] as ErrorKind[], ['timeout'] as ErrorKind[]])(
  'settles only after applicable retries with filter %j',
  async (on) => {
    const harness = { invoke: vi.fn(() => Promise.reject(failure('rate-limit'))) };
    const definition = workflow(async (ctx) => {
      const result = await ctx.codex.text('ask', {
        prompt: 'p',
        onError: 'return',
        retry: { maxAttempts: 3, delayMs: 0, ...(on === undefined ? {} : { on }) },
      });
      return result.ok ? result.value.output : String(result.error.attempts);
    });
    const result = await runWorkflow(definition, { ...options(), harness });
    expect(result.output).toBe(on === undefined ? '3' : '1');
    expect(harness.invoke).toHaveBeenCalledTimes(on === undefined ? 3 : 1);
    expect(result.steps['ask']?.status).toBe('settled-failed');
  },
);

it('preserves best-effort map outcomes when a failed item heals on resume', async () => {
  let broken = true;
  const harness = {
    invoke: vi.fn((request: HarnessRequest) => {
      if (broken && request.options.prompt === 'b') return Promise.reject(failure('timeout'));
      return Promise.resolve(reply);
    }),
  } satisfies Harness;
  const summary = vi.fn(() => 'summary');
  const definition = workflow(async (ctx) => {
    const results = await ctx.map(['a', 'b'], 2, async (id) => {
      const result = await ctx.claude.text(id, { prompt: id, onError: 'return' });
      return result.ok ? result.value.output : null;
    });
    const result = await ctx.step('summary', { input: results, schema: z.string(), run: summary });
    if (broken) throw new Error('tail');
    return result;
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('tail');
  broken = false;
  expect((await runWorkflow(definition, { ...options(), harness, resume: true })).output).toBe(
    'summary',
  );
  expect(harness.invoke).toHaveBeenCalledTimes(2);
  expect(summary).toHaveBeenCalledTimes(1);
});

it.each(['external', 'sibling'] as const)('never settles %s cancellation', async (origin) => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const definition = workflow(async (ctx) => {
    const waiting = () =>
      ctx.step('waiting', {
        input: null,
        schema: z.string(),
        onError: 'return',
        retry: { maxAttempts: 3, delayMs: 0 },
        run: async ({ signal }) => {
          started();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error(String(signal.reason)));
              },
              { once: true },
            );
          });
          return 'never';
        },
      });
    if (origin === 'sibling')
      await ctx.map([0, 1], 2, async (index) => {
        if (index === 0) return waiting();
        await ready;
        throw new Error('sibling failed');
      });
    else await waiting();
    return 'never';
  });
  const pending = runWorkflow(definition, { ...options(), signal: controller.signal });
  const failed = expect(pending).rejects.toThrow(
    origin === 'external' ? 'cancelled' : 'sibling failed',
  );
  await ready;
  if (origin === 'external') controller.abort(new Error('cancelled'));
  await failed;
  const step = (await readRun(options())).steps['waiting'];
  expect(step).toMatchObject({ status: 'failed', attempts: 1 });
  expect(step?.settledError).toBeUndefined();
});

it('records a signal-driven failure as cancelled even when the effect rejects with a plain error', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const definition = workflow(async (ctx) => {
    await ctx.step('waiting', {
      input: null,
      schema: z.string(),
      onError: 'return',
      run: async ({ signal }) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('stopped')); }, { once: true });
        });
        return 'never';
      },
    });
    return 'never';
  });
  const pending = runWorkflow(definition, { ...options(), signal: controller.signal });
  const failed = expect(pending).rejects.toThrow('stopped');
  await ready;
  controller.abort(new Error('cancelled'));
  await failed;
  const step = (await readRun(options())).steps['waiting'];
  expect(step).toMatchObject({ status: 'failed' });
  expect(step?.settledError).toBeUndefined();
  expect(step?.attemptHistory?.at(-1)).toMatchObject({ errorKind: 'cancelled' });
});

it('does not settle an AbortError even when the run signal was not aborted', async () => {
  const result = runWorkflow(
    workflow(async (ctx) => {
      await ctx.step('cancel', {
        input: null,
        schema: z.null(),
        onError: 'return',
        run: () => {
          throw new DOMException('cancelled', 'AbortError');
        },
      });
      return 'never';
    }),
    options(),
  );
  await expect(result).rejects.toThrow('cancelled');
  expect((await readRun(options())).steps['cancel']?.status).toBe('failed');
});

it('settles a domain error that reuses the CheckpointError class as its own outcome', async () => {
  const local = vi.fn(() => {
    throw new CheckpointError('save', 'domain', null);
  });
  const definition = workflow(async (ctx) => {
    const result = await ctx.step('local', {
      input: null,
      schema: z.string(),
      onError: 'return',
      run: local,
    });
    return result.ok ? 'unexpected' : result.error.kind;
  });
  const result = await runWorkflow(definition, options());
  expect(result.output).toBe('unknown');
  expect(result.steps['local']?.status).toBe('settled-failed');
  await runWorkflow(definition, { ...options(), resume: true });
  expect(local).toHaveBeenCalledTimes(1);
});

it('retries a domain error that reuses the CheckpointError class instead of treating it as fatal', async () => {
  const local = vi.fn(() => {
    throw new CheckpointError('save', 'domain', null);
  });
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.step('local', {
          input: null,
          schema: z.string(),
          retry: { maxAttempts: 2, delayMs: 0 },
          run: local,
        }),
      ),
      options(),
    ),
  ).rejects.toThrow('domain');
  expect(local).toHaveBeenCalledTimes(2);
});

it('keeps error mode in identity and preserves terminal failures during forks', async () => {
  const harness = { invoke: vi.fn(() => Promise.reject(failure('timeout'))) };
  const source = workflow(async (ctx) => {
    await ctx.claude.text('ask', { prompt: 'p', onError: 'return' });
    throw new Error('tail');
  });
  await expect(runWorkflow(source, { ...options(), harness })).rejects.toThrow('tail');
  const before = await readFile(join(stateDir, 'outcomes.json'), 'utf8');
  const target = workflow(async (ctx) => {
    const result = await ctx.claude.text('ask', { prompt: 'p', onError: 'return' });
    return result.ok ? 'unexpected' : result.error.kind;
  });
  const fork = await runWorkflow(target, {
    ...options(),
    runId: 'fork',
    harness,
    forkFrom: { runId: 'outcomes' },
  });
  expect(fork.output).toBe('timeout');
  expect(fork.steps['ask']?.reusedFrom?.runId).toBe('outcomes');
  expect(await readFile(join(stateDir, 'outcomes.json'), 'utf8')).toBe(before);
  expect(harness.invoke).toHaveBeenCalledTimes(1);
  await expect(
    runWorkflow(
      workflow(async (ctx) => (await ctx.claude.text('ask', { prompt: 'p' })).output),
      { ...options(), harness, resume: true },
    ),
  ).rejects.toThrow('onError changed');
  await expect(
    runWorkflow(
      workflow(() => Promise.resolve('skip')),
      { ...options(), resume: true },
    ),
  ).rejects.toThrow('Replay skipped recorded steps (ask)');
});

it.each([false, true])(
  'reports a healed step immediately and retains it in the skipped-path error (strict %j)',
  async (strictReplay) => {
    let broken = true;
    const order: string[] = [];
    const harness: Harness = {
      invoke(request) {
        order.push(request.options.prompt);
        if (broken && request.options.prompt === 'primary')
          return Promise.reject(new Error('primary failed'));
        return Promise.resolve(reply);
      },
    };
    const definition = workflow(async (ctx) => {
      try {
        await ctx.claude.text('primary', { prompt: 'primary' });
      } catch {
        await ctx.codex.text('fallback', { prompt: 'fallback' });
      }
      if (broken) throw new Error('tail');
      await ctx.claude.text('later', { prompt: 'later' });
      return 'done';
    });
    await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('tail');
    broken = false;
    order.length = 0;
    const error: unknown = await runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      strictReplay,
      onEvent: (event) => {
        if (event.healedStepId) {
          expect(event.skippedStepIds).toEqual(['fallback']);
          order.push(`healed:${event.healedStepId}`);
        }
      },
    }).catch((error: unknown) => error);
    expect(String(error)).toContain(strictReplay ? 'Healed step primary' : 'Healed steps: primary');
    expect(order).toEqual(
      strictReplay ? ['primary', 'healed:primary'] : ['primary', 'healed:primary', 'later'],
    );
    expect((await readRun(options())).replayWarnings?.[0]).toContain('fallback');
  },
);

it('classifies structured errors without guessing from message text', () => {
  expect(errorKind(new Error('timeout rate-limit 429'))).toBe('unknown');
  expect(errorKind(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }))).toBe('timeout');
  expect(errorKind(new DOMException('deadline', 'TimeoutError'))).toBe('timeout');
  expect(errorKind(Object.assign(new Error('limit'), { code: 'QUIET_CHOIR_OUTPUT_LIMIT' }))).toBe(
    'output-limit',
  );
  expect(errorKind(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('process');
  expect(errorKind(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe('unknown');
  expect(errorKind(Object.assign(new Error('denied'), { code: 'EACCES', phase: 'spawn' }))).toBe(
    'process',
  );
  expect(errorKind(Object.assign(new Error('abort'), { code: 'ABORT_ERR' }))).toBe('cancelled');
  expect(errorKind('failure')).toBe('unknown');
});

it('classifies and retries any subprocess launch failure as a process failure', async () => {
  const binary = join(stateDir, 'claude');
  await writeFile(binary, `#!${process.execPath}\n`);
  await chmod(binary, 0o600);
  const harness = new CliHarness({ claudeBinary: binary });
  const calls = vi.spyOn(harness, 'invoke');
  const definition = workflow(async (ctx) => {
    const result = await ctx.claude.text('launch', {
      prompt: 'p',
      onError: 'return',
      retry: { maxAttempts: 2, delayMs: 0, on: ['process'] },
    });
    return result.ok
      ? result.value.output
      : `${result.error.kind}/${String(result.error.attempts)}`;
  });
  expect((await runWorkflow(definition, { ...options(), harness })).output).toBe('process/2');
  expect(calls).toHaveBeenCalledTimes(2);
  const attempts = (await readRun(options())).steps['launch']?.attemptHistory ?? [];
  expect(attempts.map((attempt) => attempt.errorKind)).toEqual(['process', 'process']);
});

it('changes retry filters on an unfinished call without changing its identity', async () => {
  let retry = false;
  const harness = {
    invoke: vi.fn(() =>
      harness.invoke.mock.calls.length < 3
        ? Promise.reject(failure('rate-limit'))
        : Promise.resolve(reply),
    ),
  };
  const definition = workflow(
    async (ctx) =>
      (
        await ctx.claude.text('ask', {
          prompt: 'p',
          retry: { maxAttempts: 2, delayMs: 0, on: retry ? ['rate-limit'] : ['timeout'] },
        })
      ).output,
  );
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('rate-limit');
  const fingerprint = (await readRun(options())).steps['ask']?.fingerprint;
  retry = true;
  const result = await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(result.output).toBe('ok');
  expect(result.steps['ask']?.fingerprint).toBe(fingerprint);
  expect(result.steps['ask']?.attemptHistory).toHaveLength(3);
});

it.each([
  [429, null, 'rate-limit'],
  [401, null, 'authentication'],
  [403, null, 'permission'],
  [408, null, 'timeout'],
  [504, null, 'timeout'],
  [null, 'max_turns', 'turn-limit'],
  [null, 'budget_exhausted', 'budget-limit'],
  [400, null, 'unknown'],
] as const)(
  'classifies protocol status %j / reason %j as %s',
  (apiStatus, terminalReason, expected) => {
    const error = new HarnessError({
      provider: 'codex',
      exit: { code: 1, signal: null },
      reason: 'error',
      stderr: '',
      stdout: '',
      failure: {
        reason: 'untrusted message',
        apiStatus,
        terminalReason,
        subtype: null,
        sessionId: null,
        usage: null,
      },
    });
    expect(errorKind(error)).toBe(expected);
  },
);

it('rejects a missing harness instead of settling it as a failed outcome', async () => {
  const settled: unknown[] = [];
  const definition = workflow(async (ctx) => {
    const first = await ctx.claude.text('x', { prompt: 'p', onError: 'return' });
    settled.push(first);
    return first.ok ? first.value.output : 'failed';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('No harness adapter configured');
  expect((await readRun(options())).steps['x']?.status).toBe('failed');
  const harness: Harness = { invoke: () => Promise.resolve(reply) };
  const result = await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(settled.at(-1)).toMatchObject({ ok: true });
  expect(result.output).toBe('ok');
});

it('rejects adapter configuration failures instead of settling or retrying them', async () => {
  const binary = join(stateDir, 'claude');
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'',structured_output:{answer:'fixed'}}));\n`,
  );
  await chmod(binary, 0o700);
  const harness = new CliHarness({ claudeBinary: binary });
  const calls = vi.spyOn(harness, 'invoke');
  let schema: z.ZodType = z.array(z.string());
  const definition = workflow(async (ctx) => {
    const result = await ctx.claude.object('shape', {
      prompt: 'p',
      schema,
      onError: 'return',
      retry: { maxAttempts: 3, delayMs: 0 },
    });
    return result.ok ? JSON.stringify(result.value.output) : 'fallback';
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow(
    'Claude structured output requires an object root',
  );
  expect(calls).toHaveBeenCalledTimes(1);
  const step = (await readRun(options())).steps['shape'];
  expect(step?.status).toBe('failed');
  expect(step?.settledError).toBeUndefined();
  schema = z.object({ answer: z.string() });
  const result = await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(result.output).toBe('{"answer":"fixed"}');
  expect(result.steps['shape']?.status).toBe('completed');
  expect(calls).toHaveBeenCalledTimes(2);
});

it('rejects invalid local modes and retry filters before callbacks run', async () => {
  const action = vi.fn(() => null);
  for (const extra of [{ onError: 'ignore' }, { retry: { maxAttempts: 2, on: ['bogus'] } }]) {
    await expect(
      runWorkflow(
        workflow(async (ctx) => {
          await ctx.step('invalid', {
            input: null,
            schema: z.null(),
            run: action,
            ...extra,
          } as never);
          return 'never';
        }),
        { ...options(), runId: 'invalid' + String('retry' in extra) },
      ),
    ).rejects.toThrow();
  }
  expect(action).not.toHaveBeenCalled();
});

it('replaces a timer race with a durable timeout outcome even when the agent would finish first on resume', async () => {
  const binary = join(stateDir, 'agent');
  await writeFile(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(binary, 0o700);
  const harness = new CliHarness({ claudeBinary: binary, killGraceMs: 10 });
  const calls = vi.spyOn(harness, 'invoke');
  let tail = true;
  const definition = workflow(async (ctx) => {
    const result = await ctx.claude.text('timed', {
      prompt: 'p',
      timeoutMs: 100,
      onError: 'return',
    });
    const chosen = result.ok ? result.value.output : result.error.kind;
    await ctx.step('use', { input: chosen, schema: z.null(), run: () => null });
    if (tail) throw new Error('tail');
    return chosen;
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('tail');
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'agent wins now'}));\n`,
  );
  tail = false;
  expect((await runWorkflow(definition, { ...options(), harness, resume: true })).output).toBe(
    'timeout',
  );
  expect(calls).toHaveBeenCalledTimes(1);
});

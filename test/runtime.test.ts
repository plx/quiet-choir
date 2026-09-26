import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type Harness,
  type WorkflowContext,
} from '../src/index.js';

const directories: string[] = [];
async function setup(): Promise<{ stateDir: string; runId: string; input: object }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-runtime-'));
  directories.push(stateDir);
  return { stateDir, runId: 'test-run', input: {} };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function workflow(run: (ctx: WorkflowContext) => Promise<number>) {
  return defineWorkflow({
    name: 'test',
    version: '1',
    input: z.object({}),
    output: z.number(),
    run,
  });
}

const response = {
  text: '{"answer":42}',
  sessionId: 'session',
  usage: { inputTokens: 2, outputTokens: 3, costUsd: null },
};

describe('durable TypeScript workflows', () => {
  it('infers schema types, validates input before effects, and preserves typed output', async () => {
    const options = await setup();
    const run = vi.fn((_ctx: WorkflowContext, input: { count: number }) =>
      Promise.resolve({ doubled: input.count * 2 }),
    );
    const definition = defineWorkflow({
      name: 'typed',
      version: '1',
      input: z.object({ count: z.number() }),
      output: z.object({ doubled: z.number() }),
      run,
    });
    await expect(runWorkflow(definition, options)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    const result = await runWorkflow(definition, { ...options, input: { count: 5 } });
    expectTypeOf(result.output.doubled).toEqualTypeOf<number>();
    expect(result.output).toEqual({ doubled: 10 });
    defineWorkflow({
      name: 'wrong',
      version: '1',
      input: z.object({}),
      output: z.string(),
      // @ts-expect-error Schema output and workflow return type must agree.
      run: () => Promise.resolve(2),
    });
  });

  it('replays finished effects after a failure and never invokes a completed run again', async () => {
    const options = await setup();
    const first = vi.fn(() => ({ value: 7 }));
    const second = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(2);
    const events: string[] = [];
    const definition = workflow(async (ctx) => {
      const a = await ctx.step('first', {
        input: null,
        schema: z.object({ value: z.number() }),
        run: first,
      });
      // Mutation of a returned value must not mutate its checkpoint.
      const before = a.value;
      a.value = 99;
      const b = await ctx.step('second', { input: before, schema: z.number(), run: second });
      return before + b;
    });
    await expect(runWorkflow(definition, options)).rejects.toThrow('transient');
    expect((await readRun({ stateDir: options.stateDir, runId: options.runId })).status).toBe(
      'failed',
    );
    const result = await runWorkflow(definition, {
      ...options,
      resume: true,
      onEvent: (e) => {
        events.push(e.type);
      },
    });
    expect(result.output).toBe(9);
    expect(result.steps['first']?.output).toEqual({ value: 7 });
    expect(result.steps['second']?.attempts).toBe(2);
    expect(events).toContain('step.replayed');
    await runWorkflow(definition, { ...options, resume: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('uses saved input on resume and detects input, code, version and cwd drift', async () => {
    const options = await setup();
    const definition = defineWorkflow({
      name: 'inputs',
      version: '1',
      input: z.object({ n: z.number() }),
      output: z.number(),
      run: (_ctx, input) => Promise.resolve(input.n),
    });
    await runWorkflow(definition, { ...options, input: { n: 3 }, fingerprint: 'source-1' });
    const resume = {
      stateDir: options.stateDir,
      runId: options.runId,
      resume: true,
      fingerprint: 'source-1',
    };
    expect((await runWorkflow(definition, resume)).output).toBe(3);
    await expect(runWorkflow(definition, { ...resume, input: { n: 4 } })).rejects.toThrow(
      'input changed',
    );
    await expect(runWorkflow(definition, { ...resume, fingerprint: 'source-2' })).rejects.toThrow(
      'changed',
    );
    await expect(runWorkflow({ ...definition, version: '2' }, resume)).rejects.toThrow('changed');
    await expect(runWorkflow(definition, { ...resume, cwd: tmpdir() })).rejects.toThrow('changed');
    await expect(runWorkflow(definition, { ...options, input: { n: 3 } })).rejects.toThrow(
      'already exists',
    );
    await expect(runWorkflow(definition, { ...resume, runId: 'absent' })).rejects.toThrow(
      'does not exist',
    );
  });

  it('validates structured harness output locally and checkpoints provider metadata', async () => {
    const options = await setup();
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(response);
    const harness: Harness = { invoke };
    let answer = 0;
    const definition = workflow(async (ctx) => {
      const result = await ctx.claude.object('ask-claude', {
        prompt: 'answer',
        schema: z.object({ answer: z.number() }),
        model: 'haiku',
        maxTurns: 1,
      });
      expectTypeOf(result.output.answer).toEqualTypeOf<number>();
      answer = result.output.answer;
      const text = await ctx.codex.text('ask-codex', { prompt: 'echo', reasoningEffort: 'low' });
      expectTypeOf(text.output).toEqualTypeOf<string>();
      return answer;
    });
    const result = await runWorkflow(definition, { ...options, harness });
    expect(result.output).toBe(42);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      provider: 'claude',
      outputSchema: { type: 'object' },
    });
    expect(invoke.mock.calls[0]?.[0].options).not.toHaveProperty('schema');
    expect(result.steps['ask-claude']?.output).toMatchObject({
      output: { answer: 42 },
      sessionId: 'session',
    });
    await runWorkflow(definition, { ...options, harness, resume: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects missing harness, malformed JSON and schema-invalid responses without caching success', async () => {
    const options = await setup();
    const definition = workflow(
      async (ctx) =>
        (await ctx.codex.object('ask', { prompt: 'x', schema: z.object({ answer: z.number() }) }))
          .output.answer,
    );
    await expect(runWorkflow(definition, options)).rejects.toThrow('No harness');
    const invoke = vi
      .fn<Harness['invoke']>()
      .mockResolvedValueOnce({ ...response, text: 'not json' })
      .mockResolvedValueOnce({ ...response, text: '{"answer":"bad"}' })
      .mockResolvedValue(response);
    const resume = { ...options, resume: true, harness: { invoke } };
    await expect(runWorkflow(definition, resume)).rejects.toThrow();
    await expect(runWorkflow(definition, resume)).rejects.toThrow();
    expect(
      (await readRun({ stateDir: options.stateDir, runId: options.runId })).steps['ask']?.status,
    ).toBe('failed');
    expect((await runWorkflow(definition, resume)).output).toBe(42);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('detects changed step input/schema/kind, duplicate IDs and skipped recorded work', async () => {
    const options = await setup();
    let input = 1;
    let skip = false;
    const definition = workflow(async (ctx) => {
      if (!skip) await ctx.step('effect', { input, schema: z.number(), run: () => 3 });
      throw new Error('pause');
    });
    await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
    input = 2;
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'changed inputs',
    );
    skip = true;
    await expect(
      runWorkflow({ ...definition, run: () => Promise.resolve(1) }, { ...options, resume: true }),
    ).rejects.toThrow('skipped recorded steps');
    const duplicate = workflow(async (ctx) => {
      await Promise.all(
        [1, 2].map(() => ctx.step('same', { input: null, schema: z.number(), run: () => 1 })),
      );
      return 0;
    });
    await expect(runWorkflow(duplicate, { ...options, runId: 'duplicate' })).rejects.toThrow(
      'Duplicate step',
    );
  });

  it('retries only explicitly opted-in steps with stable idempotency keys', async () => {
    const options = await setup();
    const attempts: number[] = [];
    const keys: string[] = [];
    const result = await runWorkflow(
      workflow(async (ctx) =>
        ctx.step('retry', {
          input: null,
          schema: z.number(),
          retry: { maxAttempts: 3, delayMs: 0 },
          run: ({ attempt, idempotencyKey }) => {
            attempts.push(attempt);
            keys.push(idempotencyKey);
            if (attempt < 3) throw new Error('again');
            return 8;
          },
        }),
      ),
      options,
    );
    expect(result.output).toBe(8);
    expect(attempts).toEqual([1, 2, 3]);
    expect(new Set(keys)).toEqual(new Set(['test-run/retry']));
  });

  it('bounds fan-out, preserves input order and drains siblings before failing', async () => {
    const options = await setup();
    let active = 0;
    let peak = 0;
    let release = (): void => {
      throw new Error('Barrier is not initialized.');
    };
    const twoStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await runWorkflow(
      defineWorkflow({
        name: 'map',
        version: '1',
        input: z.object({}),
        output: z.array(z.number()),
        run: async (ctx) =>
          ctx.map([3, 2, 1], 2, (n, index) =>
            ctx.step(`item/${String(index)}`, {
              input: n,
              schema: z.number(),
              run: async () => {
                active++;
                peak = Math.max(active, peak);
                if (active === 2) release();
                await twoStarted;
                active--;
                return n * 2;
              },
            }),
          ),
      }),
      options,
    );
    expect(result.output).toEqual([6, 4, 2]);
    expect(peak).toBe(2);
    let siblingDone = false;
    const visited: number[] = [];
    const failed = workflow(async (ctx) => {
      await ctx.map([1, 2, 3], 2, async (n) => {
        visited.push(n);
        if (n === 1) throw new Error('item failure');
        await delay(10);
        siblingDone = true;
        return n;
      });
      return 0;
    });
    await expect(runWorkflow(failed, { ...options, runId: 'map-failed' })).rejects.toThrow(
      'item failure',
    );
    expect(siblingDone).toBe(true);
    expect(visited).toEqual([1, 2]);
  });

  it('persists sleep deadlines so cancellation and resume do not restart the wait', async () => {
    const options = await setup();
    const controller = new AbortController();
    const definition = workflow(async (ctx) => {
      await ctx.sleep('wait', 40);
      return 1;
    });
    await expect(
      runWorkflow(definition, {
        ...options,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'step.started') controller.abort(new Error('stop'));
        },
      }),
    ).rejects.toThrow('stop');
    const before = await readRun({ stateDir: options.stateDir, runId: options.runId });
    const wakeAt = before.steps['wait']?.wakeAt;
    await delay(50);
    const after = await runWorkflow(definition, { ...options, resume: true });
    expect(after.steps['wait']?.wakeAt).toBe(wakeAt);
    expect(after.steps['wait']?.attempts).toBe(2);
  });

  it('cancels siblings and retains their completed checkpoints on an outer failure', async () => {
    const options = await setup();
    let settled = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const definition = workflow(async (ctx) => {
      await ctx.step('done', { input: null, schema: z.number(), run: () => 1 });
      void ctx.step('pending', {
        input: null,
        schema: z.number(),
        run: async ({ signal }) => {
          markStarted?.();
          try {
            await delay(1000, undefined, { signal });
          } finally {
            settled = true;
          }
          return 2;
        },
      });
      await started;
      throw new Error('outer failed');
    });
    await expect(runWorkflow(definition, options)).rejects.toThrow('outer failed');
    expect(settled).toBe(true);
    const record = await readRun({ stateDir: options.stateDir, runId: options.runId });
    expect(record.steps['done']?.status).toBe('completed');
    expect(record.steps['pending']?.status).toBe('failed');
    expect(record.status).toBe('failed');
  });

  it('rejects unsupported data, nested steps, invalid policies and final output', async () => {
    const options = await setup();
    await expect(
      runWorkflow(
        workflow(async (ctx) =>
          ctx.step('outer', {
            input: null,
            schema: z.number(),
            run: () => ctx.step('inner', { input: null, schema: z.number(), run: () => 1 }),
          }),
        ),
        options,
      ),
    ).rejects.toThrow('Nested');
    for (const [i, retry] of [{ maxAttempts: 0 }, { maxAttempts: 2, delayMs: -1 }].entries()) {
      await expect(
        runWorkflow(
          workflow(async (ctx) =>
            ctx.step('bad', { input: null, schema: z.number(), retry, run: () => 1 }),
          ),
          { ...options, runId: `policy${String(i)}` },
        ),
      ).rejects.toThrow('Retry policy');
    }
    await expect(
      runWorkflow(
        workflow(async (ctx) => {
          await ctx.sleep('bad', -1);
          return 1;
        }),
        { ...options, runId: 'sleep' },
      ),
    ).rejects.toThrow('Sleep');
    await expect(
      runWorkflow(
        workflow(async (ctx) => {
          await ctx.map([], 0, () => Promise.resolve(1));
          return 1;
        }),
        { ...options, runId: 'map' },
      ),
    ).rejects.toThrow('concurrency');
    await expect(
      runWorkflow(
        workflow(async (ctx) =>
          ctx.step('../bad', { input: null, schema: z.number(), run: () => 1 }),
        ),
        { ...options, runId: 'id' },
      ),
    ).rejects.toThrow('Invalid step ID');
    await expect(
      runWorkflow(
        workflow(() => Promise.resolve(NaN)),
        { ...options, runId: 'nan' },
      ),
    ).rejects.toThrow();
    expect(() => defineWorkflow({ ...workflow(() => Promise.resolve(1)), name: '' })).toThrow(
      'nonempty',
    );
  });

  it('rejects corrupt checkpoints and releases ownership even on early failures', async () => {
    const options = await setup();
    const path = join(options.stateDir, `${options.runId}.json`);
    await writeFile(path, '{}');
    await expect(
      runWorkflow(
        workflow(() => Promise.resolve(1)),
        { ...options, resume: true },
      ),
    ).rejects.toThrow();
    await rm(path);
    expect(
      (
        await runWorkflow(
          workflow(() => Promise.resolve(1)),
          options,
        )
      ).output,
    ).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'completed' });
  });

  it('does not let observers change durable execution and honors an already-aborted signal', async () => {
    const options = await setup();
    const definition = workflow(async (ctx) =>
      ctx.step('one', { input: null, schema: z.number(), run: () => 1 }),
    );
    expect(
      (
        await runWorkflow(definition, {
          ...options,
          onEvent: () => {
            throw new Error('observer');
          },
        })
      ).output,
    ).toBe(1);
    await expect(
      runWorkflow(definition, {
        ...options,
        runId: 'abort',
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
    expect((await readRun({ stateDir: options.stateDir, runId: 'abort' })).status).toBe('failed');
  });
});

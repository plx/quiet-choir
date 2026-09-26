import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, expect, it, vi } from 'vitest';

import {
  claudeOptionsSchema,
  codexOptionsSchema,
  defineWorkflow,
  readRun,
  resolveStateDir,
  runWorkflow,
  z,
  type ClaudeOptions,
  type CodexOptions,
  type Harness,
  type JsonValue,
  type WorkflowContext,
} from '../src/index.js';

const roots: string[] = [];
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-tracking-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const local = { input: null, schema: z.null(), run: () => null };
function workflow(run: (ctx: WorkflowContext) => Promise<string>) {
  return defineWorkflow({
    name: 'tracking',
    version: '1',
    input: z.null(),
    output: z.string(),
    run,
  });
}
function fakeHarness() {
  return {
    invoke: vi.fn<Harness['invoke']>((request) =>
      Promise.resolve({
        text: request.outputSchema === null ? 'ok' : '"ok"',
        sessionId: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      }),
    ),
  };
}

it('ignores rejecting async observers and does not await slow observers', async () => {
  const stateDir = await directory();
  const harness = fakeHarness();
  const release = deferred();
  const rejected: string[] = [];
  try {
    const result = await runWorkflow(
      workflow(async (ctx) => (await ctx.claude.text('ask', { prompt: 'p' })).output),
      {
        stateDir,
        runId: 'observer',
        input: null,
        harness,
        onEvent: async (event) => {
          if (event.type === 'step.completed') {
            rejected.push(event.stepId);
            throw new Error('metrics endpoint down');
          }
          await release.promise;
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(rejected).toEqual(['ask']);
    expect(harness.invoke).toHaveBeenCalledTimes(1);
    expect((await readRun({ stateDir, runId: 'observer' })).status).toBe('completed');
  } finally {
    release.resolve();
  }
});

it('drains immediate continuations to completion while retaining the writer lock', async () => {
  const stateDir = await directory();
  const lock = join(stateDir, 'chain.json.lock');
  const events: string[] = [];
  let chain: Promise<void> | undefined;
  const result = await runWorkflow(
    workflow((ctx) => {
      chain = (async () => {
        await ctx.step('a', local);
        await ctx.step('b', {
          ...local,
          run: async () => {
            await delay(30);
            await access(lock);
            events.push('b-finished');
            return null;
          },
        });
        await ctx.sleep('c', 10);
      })();
      return Promise.resolve('ok');
    }),
    { stateDir, runId: 'chain', input: null },
  );
  events.push('run-returned');
  await chain;
  expect(events).toEqual(['b-finished', 'run-returned']);
  expect(Object.values(result.steps).map((step) => step.status)).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
  await expect(access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  const checkpoint = await readFile(join(stateDir, 'chain.json'), 'utf8');
  await delay(30);
  expect(await readFile(join(stateDir, 'chain.json'), 'utf8')).toBe(checkpoint);
});

it.each([false, true])(
  'fails ignored effects whether settled before the body returns: %s',
  async (early) => {
    const stateDir = await directory();
    const failed = deferred();
    await expect(
      runWorkflow(
        workflow(async (ctx) => {
          void ctx.step('ignored', {
            ...local,
            run: () => {
              throw new Error('boom');
            },
          });
          if (early) await failed.promise;
          return 'ok';
        }),
        {
          stateDir,
          runId: 'ignored',
          input: null,
          onEvent: (event) => {
            if (event.type === 'step.failed') failed.resolve();
          },
        },
      ),
    ).rejects.toThrow(
      'Unawaited workflow operation "ignored" failed: boom; await all workflow operations.',
    );
    expect((await readRun({ stateDir, runId: 'ignored' })).status).toBe('failed');
  },
);

it.each(['claude', 'codex'] as const)(
  'keeps ignored %s harness failures unobserved',
  async (provider) => {
    const stateDir = await directory();
    const harness = fakeHarness();
    harness.invoke.mockRejectedValueOnce(new Error('harness failed'));
    await expect(
      runWorkflow(
        workflow((ctx) => {
          void ctx[provider].text('ignored-agent', { prompt: 'p' });
          return Promise.resolve('ok');
        }),
        { stateDir, runId: provider, input: null, harness },
      ),
    ).rejects.toThrow('Unawaited workflow operation "ignored-agent" failed: harness failed');
    expect((await readRun({ stateDir, runId: provider })).steps['ignored-agent']?.status).toBe(
      'failed',
    );
  },
);

it('permits await/catch, catch(), and Promise.all() to handle effect failures', async () => {
  const stateDir = await directory();
  const failing = {
    ...local,
    run: () => {
      throw new Error('handled');
    },
  };
  const result = await runWorkflow(
    workflow(async (ctx) => {
      try {
        await ctx.step('awaited', failing);
      } catch {
        /* deliberate recovery */
      }
      await ctx.step('catch', failing).catch(() => null);
      await Promise.all([ctx.step('parallel', failing)]).catch(() => []);
      await ctx.claude.text('agent', { prompt: 'p', maxTurns: 0 }).catch(() => null);
      return 'recovered';
    }),
    { stateDir, runId: 'caught', input: null },
  );
  expect(result.output).toBe('recovered');
  expect(Object.keys(result.steps)).toEqual(['awaited', 'catch', 'parallel']);
});

it.each(['sleep', 'agent', 'map'] as const)('tracks ignored %s precheck failures', async (kind) => {
  const stateDir = await directory();
  await expect(
    runWorkflow(
      workflow((ctx) => {
        if (kind === 'sleep') void ctx.sleep('invalid-sleep', -1);
        if (kind === 'agent')
          void ctx.claude.text('invalid-agent', {
            prompt: 'p',
            tools: ['Read', undefined],
          } as unknown as ClaudeOptions);
        if (kind === 'map') void ctx.map([], 0, () => Promise.resolve(null));
        return Promise.resolve('ok');
      }),
      { stateDir, runId: kind, input: null },
    ),
  ).rejects.toThrow(
    `Unawaited workflow operation "${kind === 'map' ? kind : `invalid-${kind}`}" failed:`,
  );
  const record = await readRun({ stateDir, runId: kind });
  expect(record.status).toBe('failed');
  expect(record.steps).toEqual({});
});

it('owns an ignored map until its mapper has launched and completed effects', async () => {
  const stateDir = await directory();
  const result = await runWorkflow(
    workflow((ctx) => {
      void ctx.map([0, 1], 1, async (index) => {
        await delay(10);
        return ctx.step(`mapped-${String(index)}`, local);
      });
      return Promise.resolve('ok');
    }),
    { stateDir, runId: 'map', input: null },
  );
  expect(Object.keys(result.steps)).toEqual(['mapped-0', 'mapped-1']);
  expect(Object.values(result.steps).every((step) => step.status === 'completed')).toBe(true);
});

it.each([
  ['review/src/My Component.tsx', ' ', 13],
  ['@scope', '@', 0],
  ['c++/a~b.ts', '+', 1],
  ['café.md', 'é', 3],
  ['.github/a', '.', 0],
  ['a'.repeat(201), 'a', 200],
] as const)('identifies the first invalid character in %s', async (id, character, index) => {
  const stateDir = await directory();
  const error: unknown = await runWorkflow(
    workflow(async (ctx) => {
      await ctx.step(id, local);
      return 'ok';
    }),
    {
      stateDir,
      runId: 'id',
      input: null,
    },
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(
    `Invalid step ID ${JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id)}`,
  );
  expect(message).toContain('^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$');
  expect(message).toContain(
    `first invalid character ${JSON.stringify(character)} at index ${String(index)}`,
  );
  expect(message.length).toBeLessThan(300);
});

it('omits top-level undefined options without adding custom harness defaults', async () => {
  const stateDir = await directory();
  const harness = fakeHarness();
  await runWorkflow(
    workflow(async (ctx) => {
      await ctx.claude.text('claude', {
        prompt: 'p',
        model: undefined,
        timeoutMs: undefined,
      } as unknown as ClaudeOptions);
      const structured = await ctx.codex.object('codex', {
        prompt: 'p',
        model: undefined,
        schema: z.string(),
      } as unknown as CodexOptions & { schema: z.ZodString });
      expect(structured.output).toBe('ok');
      return 'ok';
    }),
    { stateDir, runId: 'undefined', input: null, harness },
  );
  expect(harness.invoke).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(harness.invoke).mock.calls)
    expect(call[0].options).toEqual({ prompt: 'p' });
  expect(claudeOptionsSchema.parse({ prompt: 'p' })).toEqual({ prompt: 'p' });
  expect(codexOptionsSchema.parse({ prompt: 'p' })).toEqual({ prompt: 'p' });
});

it.each([
  ['agent', 'Step ask:', '$.options.tools[1]'],
  ['dependency', 'Step local:', '$.dependencies.items[0]["a.b"]'],
] as const)('names the step and JSON path for invalid %s data', async (kind, prefix, path) => {
  const stateDir = await directory();
  const run = runWorkflow(
    workflow(async (ctx) => {
      if (kind === 'agent')
        await ctx.claude.text('ask', {
          prompt: 'p',
          tools: ['Read', undefined],
        } as unknown as ClaudeOptions);
      else
        await ctx.step('local', {
          ...local,
          input: { items: [{ 'a.b': undefined }] } as unknown as JsonValue,
        });
      return 'ok';
    }),
    { stateDir, runId: kind, input: null },
  );
  await expect(run).rejects.toThrow(prefix);
  await expect(run).rejects.toThrow(`undefined at ${path}`);
});

it.each([
  ['claude', 'maxTurns', 0],
  ['claude', 'timeoutMs', 0],
  ['claude', 'maxBudgetUsd', 0],
  ['claude', 'tools', 'Read'],
  ['claude', 'model', 42],
  ['codex', 'timeoutMs', 2_147_483_648],
  ['codex', 'sandbox', 'unsafe'],
  ['codex', 'reasoningEffort', 'bad'],
  ['codex', 'skipGitRepoCheck', 1],
] as const)('rejects %s %s=%s before recording an effect', async (provider, key, value) => {
  const stateDir = await directory();
  const harness = fakeHarness();
  const run = runWorkflow(
    workflow(async (ctx) => {
      await ctx[provider].text('ask', { prompt: 'p', [key]: value });
      return 'ok';
    }),
    { stateDir, runId: 'options', input: null, harness },
  );
  await expect(run).rejects.toThrow(`Step ask: Invalid ${provider} options: ${key}:`);
  await expect(run).rejects.toThrow(
    `got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`,
  );
  expect((await readRun({ stateDir, runId: 'options' })).steps).toEqual({});
  expect(harness.invoke).not.toHaveBeenCalled();
});

it('resumes after correcting an invalid option without repeating earlier effects', async () => {
  const stateDir = await directory();
  const earlier = vi.fn(() => null);
  const harness = fakeHarness();
  let maxTurns = 0;
  const definition = workflow(async (ctx) => {
    await ctx.step('earlier', { ...local, run: earlier });
    return (await ctx.claude.text('ask', { prompt: 'p', maxTurns })).output;
  });
  const options = { stateDir, runId: 'repair', input: null, harness };
  await expect(runWorkflow(definition, options)).rejects.toThrow('maxTurns');
  expect(Object.keys((await readRun(options)).steps)).toEqual(['earlier']);
  maxTurns = 3;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe('ok');
  expect(earlier).toHaveBeenCalledTimes(1);
  expect(harness.invoke).toHaveBeenCalledTimes(1);
});

it.each(['runs', undefined])(
  'shares readRun path resolution for cwd and stateDir=%s',
  async (stateDir) => {
    const cwd = await directory();
    const options = {
      cwd,
      ...(stateDir === undefined ? {} : { stateDir }),
      runId: 'path',
      input: null,
    };
    const result = await runWorkflow(
      workflow(() => Promise.resolve('ok')),
      options,
    );
    expect(await readRun(options)).toEqual(result);
    expect(resolveStateDir(options)).toBe(join(cwd, stateDir ?? '.quiet-choir/runs'));
    expect(resolveStateDir()).toBe(join(process.cwd(), '.quiet-choir/runs'));
    await expect(readRun({ ...options, runId: 'missing' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

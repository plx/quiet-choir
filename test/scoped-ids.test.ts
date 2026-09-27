import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  stepId,
  z,
  type Harness,
  type MapStepError,
  type Settled,
  type WorkflowContext,
} from '../src/index.js';
let stateDir: string;
const options = () => ({ stateDir, runId: 'scopes', input: null });
const workflow = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'scopes', version: '1', input: z.null(), output: z.unknown(), run });
const harness: Harness = {
  invoke: (request) =>
    Promise.resolve({
      text:
        request.outputSchema === null
          ? request.options.prompt
          : JSON.stringify({ name: request.options.prompt }),
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    }),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-scopes-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('composes dynamic and lexical prefixes for every effect kind, policy, events and idempotency keys', async () => {
  const events: string[] = [];
  let key = '';
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.scope('round', async () => {
        const panel = ctx.within('panel');
        const inner = panel.within('nested');
        await inner.scope('leaf', async () => {
          await inner.step('local', {
            input: null,
            schema: z.string(),
            run: ({ idempotencyKey }) => {
              key = idempotencyKey;
              return 'saved';
            },
          });
          await inner.claude.text('ct', { prompt: 'claude text' });
          await inner.claude.object('co', {
            prompt: 'claude object',
            schema: z.object({ name: z.string() }),
          });
          await inner.codex.text('xt', { prompt: 'codex text' });
          await inner.codex.object('xo', {
            prompt: 'codex object',
            schema: z.object({ name: z.string() }),
          });
          await inner.sleep('nap', 0);
        });
        return 'done';
      }),
    ),
    {
      ...options(),
      harness,
      policy: [{ match: 'round/panel/nested/leaf/ct', timeoutMs: 123 }],
      onEvent(event) {
        if (event.type === 'step.completed') events.push(event.stepId);
      },
    },
  );
  const ids = ['local', 'ct', 'co', 'xt', 'xo', 'nap'].map((id) => `round/panel/nested/leaf/${id}`);
  expect(Object.keys(result.steps)).toEqual(ids);
  expect(events).toEqual(ids);
  expect(key).toBe('scopes/round/panel/nested/leaf/local');
  expect(result.steps[ids[1] ?? '']?.attemptHistory?.[0]?.policy.timeoutMs).toBe(123);
  expect(result.policyWarnings).toEqual([]);
});

it('retains named-map descendant scopes through a bound context and binds outside calls lexically', async () => {
  const result = await runWorkflow(
    workflow(async (ctx) => {
      const panel = ctx.within('panel');
      await ctx.scope('unrelated', () =>
        panel.step('outside', { input: null, schema: z.null(), run: () => null }),
      );
      return panel.map('people', ['a', 'b'], { concurrency: 2, key: (item) => item }, () =>
        panel.map('votes', [0, 1], { concurrency: 2 }, () =>
          panel.step('verdict', { input: null, schema: z.boolean(), run: () => true }),
        ),
      );
    }),
    options(),
  );
  expect(Object.keys(result.steps).sort()).toEqual([
    'panel/outside',
    'panel/people/a/votes/0/verdict',
    'panel/people/a/votes/1/verdict',
    'panel/people/b/votes/0/verdict',
    'panel/people/b/votes/1/verdict',
  ]);
});

it('keeps explicit leaf IDs and saved values when completion order inverts on replay', async () => {
  const fastSecond = deferred();
  let broken = true;
  const order: string[] = [];
  const called: string[] = [];
  const definition = workflow(async (ctx) => {
    const result = await Promise.all(
      ['slow', 'fast'].map((item) =>
        ctx.scope(item, async () => {
          await ctx.step('first', {
            input: item,
            schema: z.string(),
            run: async () => {
              called.push(`${item}/first`);
              if (item === 'slow') await fastSecond.promise;
              return item;
            },
          });
          order.push(item);
          return ctx.step('second', {
            input: item,
            schema: z.string(),
            run: () => {
              called.push(`${item}/second`);
              if (item === 'fast') fastSecond.resolve();
              return `stamped-for-${item}`;
            },
          });
        }),
      ),
    );
    if (broken) throw new Error('tail');
    return result;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  expect(order).toEqual(['fast', 'slow']);
  broken = false;
  order.length = 0;
  const result = await runWorkflow(definition, { ...options(), resume: true });
  expect(order).toEqual(['slow', 'fast']);
  expect(result.output).toEqual(['stamped-for-slow', 'stamped-for-fast']);
  expect(result.steps).toEqual(first.steps);
  expect(called).toHaveLength(4);
});

it.each([
  ['valid', 'bad key'],
  ['same', 'same'],
  ['valid', '.leading'],
])('prevalidates all named-map keys %j before invoking any mapper', async (...keys) => {
  const mapper = vi.fn(() => Promise.resolve('unused'));
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.scope('round', () =>
          ctx.map('items', keys, { concurrency: 1, key: (item) => item }, mapper),
        ),
      ),
      options(),
    ),
  ).rejects.toThrow(/map key/);
  expect(mapper).not.toHaveBeenCalled();
  expect((await readRun(options())).steps).toEqual({});
});

it('resumes a real format-5 legacy-map checkpoint captured before scoped IDs', async () => {
  // Captured with the #43 runtime (2db8a34), before scoped IDs changed the API.
  await writeFile(
    join(stateDir, 'legacy-map.json'),
    await readFile(new URL('./fixtures/legacy-map-format5.json', import.meta.url)),
  );
  const invoke = vi.fn(harness.invoke.bind(harness));
  const definition = defineWorkflow({
    name: 'legacy-map-fixture',
    version: '1',
    input: z.null(),
    output: z.array(z.string()),
    run: (ctx) =>
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Real checkpoint compatibility fixture.
      ctx.map(
        [0, 1],
        2,
        async (index) =>
          (await ctx.claude.text(`legacy/${String(index)}`, { prompt: `item-${String(index)}` }))
            .output,
      ),
  });
  const result = await runWorkflow(definition, {
    stateDir,
    runId: 'legacy-map',
    cwd: '/',
    fingerprint: 'legacy-map-v5',
    resume: true,
    harness: { invoke },
  });
  expect(result.output).toEqual(['item-0', 'item-1']);
  expect(Object.keys(result.steps)).toEqual(['legacy/0', 'legacy/1']);
  expect(invoke).not.toHaveBeenCalled();
});

it('creates deterministic bounded segments from arbitrary text while leaving clean parts unchanged', async () => {
  expect(stepId('a', 3)).toBe('a/3');
  expect(stepId('clean:label._-')).toBe('clean:label._-');
  const parts = [
    'My Component.tsx',
    '@scope',
    'c++',
    'a~b',
    'café',
    'src/file.ts',
    '.github',
    '',
    'x'.repeat(300),
  ];
  for (const raw of parts) {
    const id = stepId(raw);
    expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/);
    expect(id.endsWith(createHash('sha256').update(raw).digest('hex').slice(0, 8))).toBe(true);
    expect(stepId(raw)).toBe(id);
  }
  expect(new Set(parts.map((part) => stepId(part))).size).toBe(parts.length);
  expect(stepId('src/My Component.tsx')).toMatch(/^src-My-Component.tsx-[a-f0-9]{8}$/);
  expect(() => stepId()).toThrow('at least one part');
  expect(() => stepId('x'.repeat(64), 'y'.repeat(64), 'z'.repeat(64), 'too-long')).toThrow('200');
  expect(
    (
      await runWorkflow(
        workflow((ctx) => Promise.resolve(ctx.id('a', 3))),
        options(),
      )
    ).output,
  ).toBe('a/3');
});

it('names invalid and duplicate full IDs with scope, leaf and allowed pattern', async () => {
  const invalid = workflow((ctx) =>
    ctx.scope('verify', () =>
      ctx.step('Division by zero', { input: null, schema: z.null(), run: () => null }),
    ),
  );
  await expect(runWorkflow(invalid, options())).rejects.toThrow(
    /Invalid step ID "verify\/Division by zero" \(scope "verify\/", leaf "Division by zero"\).*first invalid character " ".*index 15.*ctx.id/,
  );
  const duplicate = workflow((ctx) =>
    ctx.scope('panel', async () => {
      await ctx.sleep('nap', 0);
      return ctx.sleep('nap', 0);
    }),
  );
  await expect(runWorkflow(duplicate, { ...options(), runId: 'duplicate' })).rejects.toThrow(
    /Duplicate step ID: "panel\/nap".*scope "panel\/".*leaf "nap".*map key.*Allowed pattern/,
  );
  const callback = vi.fn(() => Promise.resolve(null));
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.scope('bad scope', callback)),
      { ...options(), runId: 'prefix' },
    ),
  ).rejects.toThrow('scope');
  expect(callback).not.toHaveBeenCalled();
});

it('journals named-map outcomes with full IDs and guards original mapper source and keys', async () => {
  let tail = true;
  let changed = false;
  const called = vi.fn(() => 'saved');
  const definition = workflow(async (ctx) => {
    const result = await ctx.scope('round', () =>
      ctx.map(
        'items',
        ['a'],
        { concurrency: 2, key: () => (changed ? 'b' : 'a'), onError: 'settle' },
        () => ctx.step('result', { input: null, schema: z.string(), run: called }),
      ),
    );
    expectTypeOf(result).toEqualTypeOf<Settled<string, MapStepError>[]>();
    if (tail) throw new Error('tail');
    return result;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  expect(first.maps?.['round/items']?.items[0]?.steps).toEqual(['round/items/a/result']);
  changed = true;
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'changed after an item completed',
  );
  changed = false;
  tail = false;
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    { ok: true, value: 'saved' },
  ]);
  expect(called).toHaveBeenCalledTimes(1);
});

it('checks original named mapper source when replaying terminal item outcomes', async () => {
  let mapper = () => Promise.resolve('before');
  const definition = workflow(async (ctx) => {
    await ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, mapper);
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  mapper = () => Promise.resolve('after');
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'changed after an item completed',
  );
});

it('keeps cancellation dynamic through a lexical view and contains abort within the named map', async () => {
  const ready = deferred();
  const result = await runWorkflow(
    workflow(async (ctx) => {
      const panel = ctx.within('panel');
      const rootSignal = panel.signal;
      try {
        await panel.map('items', [0, 1], { concurrency: 2, onError: 'abort' }, (index) =>
          panel.step('work', {
            input: index,
            schema: z.null(),
            run: async ({ signal }) => {
              expect(panel.signal).toBe(signal);
              expect(signal).not.toBe(rootSignal);
              if (index === 0) {
                await ready.promise;
                throw new Error('primary');
              }
              ready.resolve();
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
              return null;
            },
          }),
        );
      } catch {
        /* Continue in the parent scope. */
      }
      expect(panel.signal).toBe(rootSignal);
      expect(panel.signal.aborted).toBe(false);
      return panel.step('after', { input: null, schema: z.string(), run: () => 'recovered' });
    }),
    options(),
  );
  expect(result.output).toBe('recovered');
  expect(result.steps['panel/items/1/work']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'panel/items/0/work',
  });
});

it('tracks unawaited scopes and rejects scope entry from local callbacks', async () => {
  await expect(
    runWorkflow(
      workflow((ctx) => {
        void ctx.scope('ignored', () => Promise.reject(new Error('scope failed')));
        return Promise.resolve(null);
      }),
      options(),
    ),
  ).rejects.toThrow('Unawaited workflow operation "scope"');
  await expect(
    runWorkflow(
      workflow((ctx) =>
        ctx.step('outer', {
          input: null,
          schema: z.null(),
          run: () => ctx.scope('nested', () => Promise.resolve(null)),
        }),
      ),
      { ...options(), runId: 'nested' },
    ),
  ).rejects.toThrow('local effect callback');
  const settled = await runWorkflow(
    workflow((ctx) =>
      ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, () =>
        ctx.scope('nested', () => Promise.reject(new Error('domain error'))),
      ),
    ),
    { ...options(), runId: 'handled' },
  );
  expect(settled.output).toEqual([
    { ok: false, error: { message: 'domain error', kind: 'unknown', attempts: 1, stepId: null } },
  ]);
});

it('keeps long-ID errors bounded while naming both prefix and leaf', async () => {
  const prefix = 'a'.repeat(190);
  const definition = workflow((ctx) => ctx.scope(prefix, () => ctx.sleep('long-leaf-name', 0)));
  const error: unknown = await runWorkflow(definition, options()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw error;
  expect(error.message).toContain(`scope "${'a'.repeat(80)}…"`);
  expect(error.message).toContain('leaf "long-leaf-name"');
  expect(error.message).toContain('index 200');
  expect(error.message.length).toBeLessThan(600);
  expect((await readRun(options())).steps).toEqual({});
});

it('rejects empty or non-string scoped leaves without coercion or a validator crash', async () => {
  for (const [index, id] of ['', undefined, 123].entries()) {
    const runId = `invalid-leaf-${String(index)}`;
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.scope('parent', () => ctx.sleep(id as string, 0))),
        { ...options(), runId },
      ),
    ).rejects.toThrow('Invalid step ID');
    expect((await readRun({ ...options(), runId })).steps).toEqual({});
  }
});

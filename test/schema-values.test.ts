import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type AgentClient,
  type AgentOptions,
  type ErrorMode,
  type Harness,
  type HarnessRequest,
  type Settled,
  type WorkflowContext,
  type WorkflowEvent,
} from '../src/index.js';

const roots: string[] = [];
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-values-'));
  roots.push(stateDir);
  return { stateDir, runId: 'values', input: {} };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const usage = { inputTokens: 2, outputTokens: 3, costUsd: 0.01 };
const reply = { text: 'hello', sessionId: 'native-session', usage };
const workflow = (run: (ctx: WorkflowContext) => Promise<string>) =>
  defineWorkflow({
    name: 'values',
    version: '1',
    input: z.object({}),
    output: z.string(),
    run,
  });

it.each(['claude', 'codex'] as const)(
  '%s value reuses object/text records and emits detached completion accounting once',
  async (provider) => {
    const options = await setup();
    const invoke = vi.fn<Harness['invoke']>((request) =>
      Promise.resolve({
        ...reply,
        text: request.outputSchema ? '{"answer":42}' : 'hello',
      }),
    );
    const schema = z.object({ answer: z.number() });
    let direct = false;
    let fail = true;
    const events: WorkflowEvent[] = [];
    const definition = workflow(async (ctx) => {
      const client: AgentClient<AgentOptions> = ctx.within('scope')[provider];
      const a = direct
        ? await client.value('one', { prompt: 'same', schema })
        : (await client.object('one', { prompt: 'same', schema })).output;
      const b = direct
        ? await client.value('two', { prompt: 'same' })
        : (await client.text('two', { prompt: 'same' })).output;
      if (fail) throw new Error('resume here');
      return `${String(a.answer)} ${b}`;
    });
    const onEvent = (event: WorkflowEvent) => {
      events.push(structuredClone(event));
      if (event.usage) Object.assign(event.usage, { costUsd: 999 });
    };
    await expect(
      runWorkflow(definition, { ...options, harness: { invoke }, onEvent }),
    ).rejects.toThrow('resume here');
    const before = await readRun(options);
    const completed = events.filter((event) => event.type === 'step.completed');
    expect(completed).toHaveLength(2);
    expect(
      completed.every(
        (event) => event.sessionId === reply.sessionId && event.usage?.costUsd === usage.costUsd,
      ),
    ).toBe(true);
    direct = true;
    fail = false;
    events.length = 0;
    const after = await runWorkflow(definition, {
      ...options,
      harness: { invoke },
      onEvent,
      resume: true,
    });
    expect(after.output).toBe('42 hello');
    expect(after.steps).toEqual(before.steps);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'step.replayed')).toHaveLength(2);
    expect(
      events.every((event) => event.usage === undefined && event.sessionId === undefined),
    ).toBe(true);
    const live = await runWorkflow(definition, {
      ...options,
      runId: 'direct',
      harness: { invoke },
    });
    for (const id of ['scope/one', 'scope/two']) {
      expect(live.steps[id]).toMatchObject({
        kind: 'agent',
        harness: provider,
        revision: 1,
        identity: before.steps[id]?.identity,
        fingerprint: before.steps[id]?.fingerprint,
        output: {
          output: (before.steps[id]?.output as { output: unknown }).output,
          sessionId: reply.sessionId,
          usage,
          diagnostics: {
            transcript: { path: expect.stringContaining('/direct/attempts/') as unknown },
          },
        },
      });
    }
  },
);

it('returns typed settled values and preserves settled failure replay across helper changes', async () => {
  const options = await setup();
  const invoke = vi.fn<Harness['invoke']>((request) =>
    request.options.prompt === 'bad'
      ? Promise.reject(new Error('unavailable'))
      : Promise.resolve(reply),
  );
  let direct = true;
  let fail = true;
  const definition = workflow(async (ctx) => {
    const success = await ctx.codex.value('good', { prompt: 'ok', onError: 'return' });
    expectTypeOf(success).toEqualTypeOf<Settled<string>>();
    expect(success).toEqual({ ok: true, value: 'hello' });
    const failure = direct
      ? await ctx.claude.value('bad', {
          prompt: 'bad',
          schema: z.object({ n: z.number() }),
          onError: 'return',
        })
      : await ctx.claude.object('bad', {
          prompt: 'bad',
          schema: z.object({ n: z.number() }),
          onError: 'return',
        });
    expect(failure).toMatchObject({ ok: false, error: { message: 'unavailable' } });
    if (fail) throw new Error('tail');
    return 'done';
  });
  await expect(runWorkflow(definition, { ...options, harness: { invoke } })).rejects.toThrow(
    'tail',
  );
  const before = await readRun(options);
  fail = false;
  direct = false;
  const after = await runWorkflow(definition, { ...options, harness: { invoke }, resume: true });
  expect(after.steps).toEqual(before.steps);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each([false, true])('owns ignored value failures (structured=%s)', async (structured) => {
  const options = await setup();
  const invoke = vi.fn<Harness['invoke']>(() => Promise.reject(new Error('owned failure')));
  const definition = workflow((ctx) => {
    if (structured)
      void ctx
        .within('worker')
        .codex.value('call', { prompt: 'p', schema: z.object({ n: z.number() }) });
    else void ctx.within('worker').claude.value('call', { prompt: 'p' });
    return Promise.resolve('not successful');
  });
  await expect(runWorkflow(definition, { ...options, harness: { invoke } })).rejects.toThrow(
    'Unawaited workflow operation "worker/call"',
  );
  expect((await readRun(options)).steps['worker/call']?.status).toBe('failed');
});

it('schema-only inference accepts enum literals, and value infers structured/dynamic modes', async () => {
  const options = await setup();
  const invoke = vi.fn<Harness['invoke']>((request) =>
    Promise.resolve({ ...reply, text: request.outputSchema ? '{"verdict":"pass"}' : 'hello' }),
  );
  const schema = z.object({ verdict: z.enum(['pass', 'fail']) });
  const definition = defineWorkflow({
    name: 'inference',
    version: '1',
    input: z.object({}),
    output: schema,
    async run(ctx) {
      const literal = await ctx.step('literal', {
        input: null,
        schema: z.enum(['a', 'b']),
        run: () => 'a' as const,
      });
      expectTypeOf(literal).toEqualTypeOf<'a' | 'b'>();
      const object = await ctx.claude.value('object', { prompt: 'p', schema });
      expectTypeOf(object).toEqualTypeOf<{ verdict: 'pass' | 'fail' }>();
      const settled = await ctx.codex.value('settled', { prompt: 'p', schema, onError: 'return' });
      expectTypeOf(settled).toEqualTypeOf<Settled<{ verdict: 'pass' | 'fail' }>>();
      const mode: ErrorMode = options.runId === 'values' ? 'return' : 'throw';
      const dynamic = await ctx.claude.value('dynamic', { prompt: 'p', schema, onError: mode });
      expectTypeOf(dynamic).toEqualTypeOf<
        { verdict: 'pass' | 'fail' } | Settled<{ verdict: 'pass' | 'fail' }>
      >();
      expect(dynamic).toEqual({ ok: true, value: { verdict: 'pass' } });
      const text = await ctx.codex.value('text', { prompt: 'p', onError: mode });
      expectTypeOf(text).toEqualTypeOf<string | Settled<string>>();
      return { verdict: 'pass' };
    },
  });
  expect((await runWorkflow(definition, { ...options, harness: { invoke } })).output).toEqual({
    verdict: 'pass',
  });
});

it('omits undefined at all five boundaries and passes only saved input/results on fresh execution and replay', async () => {
  const options = { ...(await setup()), grants: ['all'] as const };
  const requests: HarnessRequest[] = [];
  const schema = z.object({ note: z.string().optional() });
  let fail = true;
  const local = vi.fn(() => ({ note: undefined }));
  const seen: object[] = [];
  const definition = defineWorkflow({
    name: 'optional',
    version: '1',
    strictProfiles: false,
    input: schema,
    output: schema,
    async run(ctx, input) {
      seen.push(input);
      expect(Object.hasOwn(input, 'note')).toBe(false);
      const result = await ctx.step('local', {
        input: { note: input.note, nested: { note: input.note } },
        schema,
        run: local,
      });
      expect(Object.hasOwn(result, 'note')).toBe(false);
      const agent = await ctx.claude.value('agent', {
        prompt: 'p',
        schema,
        settings: { nested: { keep: true, omitted: undefined } } as never,
        model: undefined,
      } as never);
      expect(agent).toEqual({});
      if (fail) throw new Error('retry body');
      return { note: input.note };
    },
  });
  const harness: Harness = {
    invoke(request) {
      requests.push(request);
      return Promise.resolve({ ...reply, text: '{}' });
    },
  };
  await expect(
    runWorkflow(definition, { ...options, input: { note: undefined }, harness }),
  ).rejects.toThrow('retry body');
  fail = false;
  const after = await runWorkflow(definition, { ...options, harness, resume: true });
  expect(after.input).toEqual({});
  expect(after.output).toEqual({});
  expect(seen).toEqual([{}, {}]);
  expect(local).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.options).not.toHaveProperty('model');
  expect(requests[0]?.options).toMatchObject({ settings: { nested: { keep: true } } });
  expect((await runWorkflow(definition, { ...options, harness, resume: true })).output).toEqual({});
});

it.each(['input', 'dependencies', 'request', 'step output', 'final output'] as const)(
  'names the %s boundary and exact invalid array path',
  async (boundary) => {
    const options = await setup();
    const schema = z.object({ findings: z.array(z.string().optional()) });
    const bad = { findings: ['one', 'two', undefined] };
    const definition = defineWorkflow({
      name: 'invalid',
      version: '1',
      input: schema,
      output: schema,
      async run(ctx) {
        if (boundary === 'dependencies')
          await ctx.step('triage/3', { input: bad as never, schema: z.null(), run: () => null });
        if (boundary === 'request')
          // @ts-expect-error -- strictProfiles omits settings; this probes the request JSON boundary.
          await ctx.claude.value('triage/3', { prompt: 'p', settings: bad as never });
        if (boundary === 'step output')
          return ctx.step('triage/3', { input: null, schema, run: () => bad });
        return bad;
      },
    });
    const label =
      boundary === 'input'
        ? 'Workflow input'
        : boundary === 'final output'
          ? 'Workflow output'
          : `Step "triage/3" ${boundary === 'request' ? 'agent request' : boundary === 'dependencies' ? 'dependencies' : 'output'}`;
    const path = boundary === 'request' ? '$.options.settings.findings[2]' : '$.findings[2]';
    await expect(
      runWorkflow(definition, { ...options, input: boundary === 'input' ? bad : { findings: [] } }),
    ).rejects.toThrow(`${label} is not JSON at ${path}: undefined array element`);
  },
);

it('preserves schema field order in returned values and serialized downstream prompts across replay', async () => {
  const options = await setup();
  const schema = z.object({
    z: z.string(),
    a: z.object({ z: z.number(), a: z.number() }),
    omitted: z.string().optional(),
  });
  const expected = '{"z":"last","a":{"z":2,"a":1}}';
  let fail = true;
  const invoke = vi.fn<Harness['invoke']>((request) =>
    Promise.resolve({ ...reply, text: request.outputSchema ? expected : request.options.prompt }),
  );
  const definition = defineWorkflow({
    name: 'field-order',
    version: '1',
    input: schema,
    output: z.string(),
    async run(ctx, input) {
      expect(JSON.stringify(input)).toBe(expected);
      await ctx.codex.value('input', { prompt: JSON.stringify(input) });
      const local = await ctx.step('local', {
        input: null,
        schema,
        run: () => ({ z: 'last', a: { z: 2, a: 1 }, omitted: undefined }),
      });
      const agent = await ctx.claude.value('agent', { prompt: 'first', schema });
      expect(JSON.stringify(local)).toBe(expected);
      expect(JSON.stringify(agent)).toBe(expected);
      const result = await ctx.codex.value('downstream', { prompt: JSON.stringify(agent) });
      if (fail) throw new Error('tail');
      return result;
    },
  });
  await expect(
    runWorkflow(definition, {
      ...options,
      input: { z: 'last', a: { z: 2, a: 1 }, omitted: undefined },
      harness: { invoke },
    }),
  ).rejects.toThrow('tail');
  fail = false;
  expect(
    (
      await runWorkflow(definition, {
        stateDir: options.stateDir,
        runId: options.runId,
        harness: { invoke },
        resume: true,
      })
    ).output,
  ).toBe(expected);
  expect(invoke).toHaveBeenCalledTimes(3);
});

it('passes the body the once-parsed input when the schema overwrite is not idempotent', async () => {
  const options = await setup();
  const seen: number[] = [];
  const definition = defineWorkflow({
    name: 'overwrite-input',
    version: '1',
    input: z.object({ n: z.number().overwrite((n) => n + 1) }),
    output: z.number(),
    run(_ctx, input) {
      seen.push(input.n);
      return Promise.resolve(input.n);
    },
  });
  const result = await runWorkflow(definition, { ...options, input: { n: 1 } });
  expect(seen).toEqual([2]);
  expect(result.output).toBe(2);
  expect(result.input).toEqual({ n: 2 });
  expect((await readRun(options)).input).toEqual({ n: 2 });
});

it('rejects an explicitly invalid value schema before invoking the harness', async () => {
  const options = await setup();
  const invoke = vi.fn<Harness['invoke']>(() =>
    Promise.resolve({ ...reply, text: '"unexpected"' }),
  );
  const definition = workflow((ctx) =>
    ctx.claude.value('bad', {
      prompt: 'p',
      schema: null as unknown as z.ZodType<string>,
    }),
  );
  await expect(runWorkflow(definition, { ...options, harness: { invoke } })).rejects.toThrow(
    'Step bad',
  );
  expect(invoke).not.toHaveBeenCalled();
  expect((await readRun(options)).steps).toEqual({});
});

// ctx.decide and decision providers (ADR 0066 sections 1-4): constructors, declarations,
// preflight, provider selection, capability checks, model precedence, replay, usage, credentials.
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationError,
  defineWorkflow,
  readRun,
  runWorkflow,
  StepIdentityChangedError,
  summarizeUsage,
  synthesizeOutput,
  z,
  type RunOptions,
  type WorkflowContext,
} from '../src/index.js';
import {
  choice,
  defineDecisionProvider,
  DecisionError,
  jevCompatible,
  noul,
  score,
  type DecisionCapabilities,
  type DecisionProviderDeclaration,
  type ProviderTransportRequest,
} from '../src/integrations/decision.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { checkedDefinition } from '../src/workflow/runtime/definition.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';
import { startFakeDecisionServer, type FakeDecisionServer } from './decision-fake-server.js';

const TOKEN = 'dummy-provider-token-abcdef0123';
const TOKEN_ENV = 'QC_TEST_PROVIDER_TOKEN';
const allCapabilities: DecisionCapabilities = {
  kinds: ['noul', 'choice', 'score'],
  maxOptions: 255,
  levels: [2, 10],
  idempotencyKey: false,
};
const refund = noul({ instructions: 'Refund?' });
const noulBody = (model = 'jev-1.13.0') => ({
  model,
  answers: { refund: { type: 'noul', noul: 0.4 } },
  usage: { input_tokens: 7, output_tokens: 3 },
});

let server: FakeDecisionServer;
let stateDir: string;
beforeEach(async () => {
  vi.stubEnv(TOKEN_ENV, TOKEN);
  server = await startFakeDecisionServer(TOKEN);
  server.script({ status: 200, body: noulBody() });
  stateDir = await mkdtemp(join(tmpdir(), 'choir-decision-provider-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
  await rm(stateDir, { recursive: true, force: true });
});

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'decide',
  stateDir,
  input: null,
  ...overrides,
});
const jev = (overrides: Partial<Parameters<typeof jevCompatible>[0]> = {}) =>
  jevCompatible({
    name: 'jev',
    baseUrl: server.url,
    apiKeyEnv: TOKEN_ENV,
    defaultModel: 'jev-latest',
    ...overrides,
  });
function workflow(
  decisions: readonly DecisionProviderDeclaration[],
  run: (ctx: WorkflowContext) => Promise<unknown>,
  version = '1',
) {
  return defineWorkflow({
    name: 'decide',
    version,
    input: z.null(),
    output: z.unknown(),
    decisions,
    run: async (ctx) => (await run(ctx)) ?? null,
  });
}
/** A provider whose transport records each request and answers every noul question. */
function recording(name: string, defaultModel?: string) {
  const requests: ProviderTransportRequest[] = [];
  const factory = vi.fn(() => (request: ProviderTransportRequest) => {
    requests.push(request);
    return Promise.resolve({
      body: {
        model: 'served',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, { noul: 0.5 }]),
        ),
      },
    });
  });
  const provider = defineDecisionProvider({
    name,
    revision: 1,
    capabilities: allCapabilities,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    transport: factory,
  });
  return { provider, factory, requests };
}

describe('question constructors', () => {
  it('return frozen wire-shaped question objects', () => {
    const question = choice({ instructions: 'Which?', options: { a: null, b: 'B' } });
    expect(question).toEqual({
      type: 'choice',
      instructions: 'Which?',
      options: { a: null, b: 'B' },
    });
    expect(Object.isFrozen(question)).toBe(true);
    expect(Object.isFrozen(question.options)).toBe(true);
    expect(score({ instructions: 'How?', levels: ['low', 'high'] })).toEqual({
      type: 'score',
      instructions: 'How?',
      levels: ['low', 'high'],
    });
    expect(noul({ instructions: 'Yes?', criteria: { true: 'it is', false: 'it is not' } })).toEqual(
      { type: 'noul', instructions: 'Yes?', criteria: { true: 'it is', false: 'it is not' } },
    );
  });

  it('enforce the protocol limits', () => {
    const options = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${String(index)}`, null]));
    expect(() => choice({ instructions: 'x', options: options(255) })).not.toThrow();
    expect(() => choice({ instructions: 'x', options: options(256) })).toThrow(/1 to 255 options/u);
    expect(() => choice({ instructions: 'x', options: {} })).toThrow(/1 to 255 options/u);
    expect(() => choice({ instructions: 'x', options: { '': null } })).toThrow(/option name/u);
    expect(() => choice({ instructions: 'x', options: { a: 1 as unknown as string } })).toThrow(
      /description/u,
    );
    expect(() => score({ instructions: 'x', levels: ['one'] })).toThrow(/2 to 10 levels/u);
    const eleven = Array.from({ length: 11 }, (_, index) => `l${String(index)}`);
    expect(() => score({ instructions: 'x', levels: eleven })).toThrow(/2 to 10 levels/u);
    expect(() => score({ instructions: 'x', levels: eleven.slice(0, 10) })).not.toThrow();
    expect(() => score({ instructions: 'x', levels: ['a', 'a'] })).toThrow(/unique/u);
    expect(() => score({ instructions: 'x', levels: ['a', ' '] })).toThrow(/nonempty/u);
    expect(() => noul({ instructions: ' ' })).toThrow(/instructions/u);
    expect(() =>
      noul({
        instructions: 'x',
        criteria: { true: 'yes' } as unknown as { true: string; false: string },
      }),
    ).toThrow(/criteria/u);
  });
});

describe('defineDecisionProvider', () => {
  const valid = {
    name: 'acme',
    revision: 1,
    capabilities: allCapabilities,
    transport: () => () => Promise.resolve({ body: null }),
  };
  it('returns frozen plain data with a null default model', () => {
    const provider = defineDecisionProvider(valid);
    expect(provider).toMatchObject({ name: 'acme', revision: 1, defaultModel: null });
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(provider.capabilities)).toBe(true);
    expect(Object.getPrototypeOf(provider)).toBe(Object.prototype);
  });

  it.each([
    [{ name: 'Acme' }, /name/u],
    [{ revision: 0 }, /revision/u],
    [{ revision: 1.5 }, /revision/u],
    [{ capabilities: { ...allCapabilities, kinds: [] } }, /kinds/u],
    [{ capabilities: { ...allCapabilities, kinds: ['box'] } }, /kinds/u],
    [{ capabilities: { ...allCapabilities, maxOptions: 256 } }, /maxOptions/u],
    [{ capabilities: { ...allCapabilities, levels: [1, 10] } }, /levels/u],
    [{ capabilities: { ...allCapabilities, levels: [5, 3] } }, /levels/u],
    [{ capabilities: { ...allCapabilities, idempotencyKey: 'yes' } }, /idempotencyKey/u],
    [{ defaultModel: '' }, /defaultModel/u],
    [{ transport: 'http' }, /transport/u],
    [{ extra: true }, /unknown fields extra/u],
  ])('rejects %j', (change, pattern) => {
    expect(() => defineDecisionProvider({ ...valid, ...change } as never)).toThrow(pattern);
  });

  it('jevCompatible fills default capabilities and applies overrides', () => {
    expect(jev().capabilities).toEqual(allCapabilities);
    expect(jev({ capabilities: { kinds: ['choice'], maxOptions: 16 } }).capabilities).toEqual({
      ...allCapabilities,
      kinds: ['choice'],
      maxOptions: 16,
    });
    expect(() => jev({ baseUrl: 'ftp://host' })).toThrow(ConfigurationError);
    expect(() => jev({ path: 'v1' })).toThrow(/path must start with/u);
  });
});

describe('definition preflight', () => {
  it('rejects duplicate and malformed decisions on the root', () => {
    expect(() => checkedDefinition(workflow([jev(), jev()], () => Promise.resolve(null)))).toThrow(
      /duplicate decision provider jev/u,
    );
    expect(() =>
      checkedDefinition({ ...workflow([], () => Promise.resolve(null)), decisions: {} }),
    ).toThrow(/decisions must be an array/u);
    expect(() =>
      checkedDefinition({
        ...workflow([], () => Promise.resolve(null)),
        decisions: [{ ...jev(), revision: -1 }],
      }),
    ).toThrow(/decisions\[0\] revision/u);
  });

  it('rejects malformed decisions on a declared child before the body runs', async () => {
    const body = vi.fn(() => Promise.resolve(null));
    const child = defineWorkflow({
      name: 'child',
      version: '1',
      input: z.null(),
      output: z.null(),
      decisions: [jev(), jev()],
      run: () => Promise.resolve(null),
    });
    const parent = defineWorkflow({
      name: 'parent',
      version: '1',
      input: z.null(),
      output: z.null(),
      children: [child],
      run: body,
    });
    await expect(runWorkflow(parent, options())).rejects.toThrow(/duplicate decision provider/u);
    expect(body).not.toHaveBeenCalled();
  });
});

describe('ctx.decide', () => {
  it('selects the only provider, unwraps answers and records the served model', async () => {
    const result = await runWorkflow(
      workflow([jev()], (ctx) => ctx.decide('ask', { state: 'text', questions: { refund } })),
      options(),
    );
    expect(result.output).toEqual({ refund: { noul: 0.4 } });
    expect(result.steps['ask']?.output).toEqual({
      model: 'jev-1.13.0',
      answers: { refund: { noul: 0.4 } },
    });
  });

  it('accepts structurally valid plain questions built without the constructors', async () => {
    const result = await runWorkflow(
      workflow([jev()], (ctx) =>
        ctx.decide('ask', {
          state: null,
          questions: { refund: { type: 'noul', instructions: 'Refund?' } },
        }),
      ),
      options(),
    );
    expect(result.output).toEqual({ refund: { noul: 0.4 } });
  });

  it('runs inside a bound scope with the prefixed step ID', async () => {
    const result = await runWorkflow(
      workflow([jev()], (ctx) =>
        ctx.within('w').decide('ask', { state: 1, questions: { refund } }),
      ),
      options(),
    );
    expect(Object.keys(result.steps)).toEqual(['w/ask']);
  });

  it.each([
    ['no provider is declared', [], undefined, /declares no decision providers/u],
    ['several are declared', ['a', 'b'], undefined, /several decision providers \(a, b\)/u],
    ['the name is unknown', ['a'], 'z', /no decision provider z; it declares a/u],
  ])(
    'fails before any record when %s',
    async (_name, names: readonly string[], provider, pattern) => {
      const providers = names.map((name) => recording(name).provider);
      await expect(
        runWorkflow(
          workflow(providers, (ctx) =>
            ctx.decide('ask', {
              state: null,
              questions: { refund },
              ...(provider === undefined ? {} : { provider }),
            }),
          ),
          options(),
        ),
      ).rejects.toThrow(pattern);
      const run = await readRun({ stateDir, runId: 'decide' });
      expect(run.steps).toEqual({});
      expect(run.rootCause).toMatchObject({ stepId: 'ask', errorKind: 'configuration' });
    },
  );

  it('picks a named provider among several', async () => {
    const a = recording('a');
    const b = recording('b');
    await runWorkflow(
      workflow([a.provider, b.provider], (ctx) =>
        ctx.decide('ask', { provider: 'b', state: null, questions: { refund } }),
      ),
      options(),
    );
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it("resolves a child's own decisions inside the child", async () => {
    const a = recording('a');
    const b = recording('b');
    const child = defineWorkflow({
      name: 'child',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      decisions: [b.provider],
      run: (ctx) => ctx.decide('ask', { state: null, questions: { refund } }),
    });
    await runWorkflow(
      workflow([a.provider], (ctx) => ctx.workflow('child', child, null)),
      options(),
    );
    expect(b.requests).toHaveLength(1);
    expect(a.requests).toHaveLength(0);
  });

  it("never falls back to the parent's providers inside a child", async () => {
    const a = recording('a');
    const child = defineWorkflow({
      name: 'child',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.decide('ask', { provider: 'a', state: null, questions: { refund } }),
    });
    const error: unknown = await runWorkflow(
      workflow([a.provider], (ctx) => ctx.workflow('child', child, null)),
      options(),
    ).catch((caught: unknown) => caught);
    expect((error as Error).cause).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(/Workflow child declares no decision provider a/u);
    expect(a.requests).toHaveLength(0);
    expect(a.factory).not.toHaveBeenCalled();
  });

  const unsupported: [string, Partial<DecisionCapabilities>, unknown, RegExp][] = [
    [
      'an unsupported kind',
      { kinds: ['choice'] },
      refund,
      /does not answer noul questions \(question q\)/u,
    ],
    [
      'too many options',
      { maxOptions: 2 },
      choice({ instructions: 'x', options: { a: null, b: null, c: null } }),
      /question q has 3 options; provider jev accepts at most 2/u,
    ],
    [
      'too few levels',
      { levels: [3, 10] },
      score({ instructions: 'x', levels: ['a', 'b'] }),
      /question q has 2 levels; provider jev accepts 3 to 10/u,
    ],
    [
      'too many levels',
      { levels: [2, 3] },
      score({ instructions: 'x', levels: ['a', 'b', 'c', 'd'] }),
      /question q has 4 levels/u,
    ],
  ];
  it.each(unsupported)(
    'rejects %s before any request or record',
    async (_name, capabilities, question, pattern) => {
      const factory = vi.fn();
      const provider = jev({ capabilities });
      const spied = { ...provider, transport: factory.mockImplementation(provider.transport) };
      const error: unknown = await runWorkflow(
        workflow([spied], (ctx) =>
          ctx.decide('ask', { state: null, questions: { q: question as typeof refund } }),
        ),
        options(),
      ).catch((caught: unknown) => caught);
      expect((error as Error).cause).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toMatch(pattern);
      expect(server.count).toBe(0);
      expect(factory).not.toHaveBeenCalled();
      const run = await readRun({ stateDir, runId: 'decide' });
      expect(run.steps).toEqual({});
      expect(run.rootCause).toMatchObject({ stepId: 'ask', errorKind: 'configuration' });
    },
  );

  it.each([
    [{ state: undefined, questions: { refund } }, /Decision state is not JSON/u],
    [{ state: null, questions: {} }, /at least one question/u],
    // A computed key is an own property, unlike the literal __proto__: key.
    [{ state: null, questions: { ['__proto__']: refund } }, /nonempty and not __proto__/u],
    [{ state: null, questions: { q: { type: 'box', instructions: 'x' } } }, /question q must be/u],
    [{ state: null, questions: { refund }, model: '' }, /model must be a nonempty string/u],
    [{ state: null, questions: { refund }, onError: 'skip' }, /onError must be/u],
    [{ state: null, questions: { refund }, timeoutMs: 0 }, /timeoutMs must be a positive/u],
    [{ state: null, questions: { refund }, retry: { maxAttempts: 0 } }, /maxAttempts/u],
    [{ state: null, questions: { refund }, schema: z.null() }, /unknown options schema/u],
  ])('rejects invalid options %j before any request', async (settings, pattern) => {
    await expect(
      runWorkflow(
        workflow([jev()], (ctx) => ctx.decide('ask', settings as never)),
        options(),
      ),
    ).rejects.toThrow(pattern);
    expect(server.count).toBe(0);
  });

  it('resolves the model from the call, then RunOptions, then the declaration', async () => {
    const declared = recording('acme', 'declared-model');
    const bare = recording('bare');
    const definition = workflow([declared.provider, bare.provider], async (ctx) => {
      await ctx.decide('call', {
        provider: 'acme',
        model: 'call-model',
        state: null,
        questions: { refund },
      });
      await ctx.decide('default', { provider: 'acme', state: null, questions: { refund } });
      await ctx.decide('none', { provider: 'bare', state: null, questions: { refund } });
      return null;
    });
    await runWorkflow(definition, options({ runId: 'declared' }));
    await runWorkflow(
      definition,
      options({
        runId: 'configured',
        decisionConfigurations: { acme: { defaultModel: 'run-model' } },
      }),
    );
    expect(declared.requests.map((request) => request.model)).toEqual([
      'call-model',
      'declared-model',
      'call-model',
      'run-model',
    ]);
    expect(bare.requests.map((request) => request.model)).toEqual([null, null]);
    expect(bare.requests[0]?.body).toEqual({
      state: null,
      questions: { refund: { type: 'noul', instructions: 'Refund?' } },
    });
    const run = await readRun({ stateDir, runId: 'configured' });
    expect(run.steps['default']?.meta).toMatchObject({ provider: 'acme', model: 'run-model' });
  });

  it('applies RunOptions configuration over the factory and validates it strictly', async () => {
    const definition = workflow(
      [jev({ baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'QC_TEST_UNSET_TOKEN' })],
      (ctx) => ctx.decide('ask', { state: null, questions: { refund } }),
    );
    await runWorkflow(
      definition,
      options({ decisionConfigurations: { jev: { baseUrl: server.url, apiKeyEnv: TOKEN_ENV } } }),
    );
    expect(server.count).toBe(1);
    await expect(
      runWorkflow(
        definition,
        options({ runId: 'bad', decisionConfigurations: { jev: { token: 'x' } as never } }),
      ),
    ).rejects.toThrow(/decisionConfigurations is invalid/u);
    await expect(
      runWorkflow(
        definition,
        options({ runId: 'bad', decisionConfigurations: { jev: { baseUrl: 'nope' } } }),
      ),
    ).rejects.toThrow(/baseUrl must be an http or https URL/u);
  });

  it('returns Settled answers and settled failures with onError return', async () => {
    server.script(
      { status: 200, body: noulBody() },
      { status: 200, body: { model: 'm', answers: {} } },
    );
    const result = await runWorkflow(
      workflow([jev()], async (ctx) => [
        await ctx.decide('ok', { state: null, questions: { refund }, onError: 'return' }),
        await ctx.decide('bad', { state: null, questions: { refund }, onError: 'return' }),
      ]),
      options(),
    );
    expect(result.output).toEqual([
      { ok: true, value: { refund: { noul: 0.4 } } },
      {
        ok: false,
        error: expect.objectContaining({ kind: 'schema', attempts: 1 }) as unknown,
      },
    ]);
  });

  it('tracks an unawaited failing decision, in the body and in a settled map', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      server.script({ status: 500, text: 'boom' });
      await expect(
        runWorkflow(
          workflow([jev()], (ctx) => {
            void ctx.decide('ask', { state: null, questions: { refund } });
            return Promise.resolve('ok');
          }),
          options(),
        ),
      ).rejects.toThrow('Unawaited workflow operation "ask" failed');
      // The mapper drops the failed decision and returns normally; the item is not a success.
      const mapped = runWorkflow(
        workflow([jev()], (ctx) =>
          ctx.map('items', ['x'], { concurrency: 1, onError: 'return' }, () => {
            void ctx.decide('ask', { state: null, questions: { refund } });
            return Promise.resolve('done');
          }),
        ),
        options({ runId: 'mapped' }),
      );
      await expect(mapped).rejects.toThrow('Unawaited workflow operation "items/0/ask" failed');
      const run = await readRun({ stateDir, runId: 'mapped' });
      expect(run.status).toBe('failed');
      expect(JSON.stringify(run.maps ?? {})).not.toContain('"done"');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('synthesizes valid choice and score answers when stubbed in a rehearsal', async () => {
    const stubbed: string[] = [];
    const result = await runWorkflow(
      workflow([jev()], (ctx) =>
        ctx.decide('ask', {
          state: null,
          questions: {
            refund,
            team: choice({ instructions: 'Which team?', options: { a: null, b: 'B', c: null } }),
            urgency: score({ instructions: 'How urgent?', levels: ['low', 'mid', 'high'] }),
          },
        }),
      ),
      options({
        harness: { kind: 'dry-run', invoke: () => Promise.reject(new Error('no agents')) },
        rehearsal: {
          localStep: (id, schema) => {
            stubbed.push(id);
            return { output: synthesizeOutput(schema, id) };
          },
        },
      }),
    );
    expect(stubbed).toEqual(['ask']);
    expect(server.count).toBe(0);
    expect(result.output).toEqual({
      refund: { noul: 0 },
      team: { choice: 'a', probabilities: { a: 1, b: 0, c: 0 }, confidence: 1 },
      urgency: {
        score: 0,
        probabilities: [1, 0, 0],
        legend: ['low', 'mid', 'high'],
        confidence: 1,
      },
    });
  });

  it('strips a confidence a server sends for a noul answer', async () => {
    server.script({
      status: 200,
      body: { model: 'm', answers: { refund: { type: 'noul', noul: 0.4, confidence: 0.9 } } },
    });
    const result = await runWorkflow(
      workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
      options(),
    );
    expect(result.output).toEqual({ refund: { noul: 0.4 } });
  });

  it('replays a completed decision without a request or a transport, and refuses a revision bump', async () => {
    let failNext = true;
    const factory = vi.fn();
    const make = (revision: number) => {
      const provider = jev({ revision });
      return { ...provider, transport: factory.mockImplementation(provider.transport) };
    };
    const definition = (revision: number) =>
      workflow([make(revision)], async (ctx) => {
        const answers = await ctx.decide('ask', { state: { n: 1 }, questions: { refund } });
        await ctx.step('after', {
          input: null,
          schema: z.null(),
          run: () => {
            if (failNext) {
              failNext = false;
              throw new Error('first execution fails');
            }
            return null;
          },
        });
        return answers;
      });
    await expect(runWorkflow(definition(1), options())).rejects.toThrow(/first execution fails/u);
    expect(server.count).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
    const refused: unknown = await runWorkflow(definition(2), options({ resume: true })).catch(
      (caught: unknown) => caught,
    );
    const identity = (refused as Error).cause;
    expect(identity).toBeInstanceOf(StepIdentityChangedError);
    expect((identity as StepIdentityChangedError).stepId).toBe('ask');
    expect((refused as Error).message).toMatch(/changed on a completed step/u);
    const resumed = await runWorkflow(definition(1), options({ resume: true }));
    expect(resumed.output).toEqual({ refund: { noul: 0.4 } });
    expect(server.count).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reports usage under the provider and served model, outside the agent totals', async () => {
    const result = await runWorkflow(
      workflow([jev()], async (ctx) => {
        await ctx.decide('one', { state: 1, questions: { refund } });
        await ctx.decide('two', { state: 2, questions: { refund } });
        return null;
      }),
      options(),
    );
    const usage = summarizeUsage(result);
    expect(usage.attempts).toBe(0);
    expect(usage.byIntegration['decision']?.attempts).toBe(2);
    expect(usage.byProvider['jev']).toMatchObject({
      attempts: 2,
      inputTokens: 14,
      outputTokens: 6,
    });
    expect(usage.byProvider['jev']?.byModel['jev-1.13.0']).toMatchObject({
      attempts: 2,
      inputTokens: 14,
      outputTokens: 6,
      costUsd: null,
    });
    expect(usage.byModel).toEqual({});
    const { summary } = await inspectRun({ stateDir, runId: 'decide' });
    expect(formatRunSummary(summary)).toContain(
      'Provider jev model jev-1.13.0: 2 attempts, 14 in / 6 out, ? reported USD',
    );
  });

  it('counts a failed attempt in the usage totals with unknown tokens', async () => {
    server.script({ hold: true }, { status: 200, body: noulBody() });
    const result = await runWorkflow(
      workflow([jev()], (ctx) =>
        ctx.decide('ask', {
          state: null,
          questions: { refund },
          timeoutMs: 100,
          retry: { maxAttempts: 2, delayMs: 0, on: ['timeout'] },
        }),
      ),
      options(),
    );
    expect(result.steps['ask']?.attemptHistory?.map((attempt) => attempt.errorKind)).toEqual([
      'timeout',
      undefined,
    ]);
    const usage = summarizeUsage(result);
    expect(usage.attempts).toBe(0);
    expect(usage.byIntegration['decision']).toMatchObject({
      attempts: 2,
      inputTokens: 7,
      outputTokens: 3,
      unknownTokenAttempts: 1,
      outcomes: { completed: 1, failed: 1 },
    });
    expect(usage.byProvider['jev']).toMatchObject({ attempts: 2, inputTokens: 7 });
    expect(usage.byProvider['jev']?.byModel['(unknown)']).toMatchObject({
      attempts: 1,
      inputTokens: null,
      outcomes: { failed: 1 },
    });
    expect(usage.byProvider['jev']?.byModel['jev-1.13.0']).toMatchObject({
      attempts: 1,
      inputTokens: 7,
    });
  });

  it('groups usage without a served model under (unknown), never the requested alias', async () => {
    server.script({
      status: 200,
      body: { answers: { refund: { noul: 0.4 } }, usage: { inputTokens: 5, outputTokens: 1 } },
    });
    const result = await runWorkflow(
      workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
      options(),
    );
    expect(result.steps['ask']?.output).toEqual({
      model: null,
      answers: { refund: { noul: 0.4 } },
    });
    const { byProvider } = summarizeUsage(result);
    expect(Object.keys(byProvider['jev']?.byModel ?? {})).toEqual(['(unknown)']);
    expect(byProvider['jev']?.byModel['(unknown)']).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
    });
  });

  it('never records the token, and a missing token is a fatal configuration failure', async () => {
    vi.stubEnv(TOKEN_ENV, '');
    const definition = workflow([jev()], (ctx) =>
      ctx.decide('ask', {
        state: null,
        questions: { refund },
        onError: 'return',
        retry: { maxAttempts: 3 },
      }),
    );
    const error: unknown = await runWorkflow(definition, options()).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).cause).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(
      /reads its bearer token from QC_TEST_PROVIDER_TOKEN, which is unset/u,
    );
    let run = await readRun({ stateDir, runId: 'decide' });
    expect(run.steps['ask']).toMatchObject({ status: 'failed', attempts: 1 });
    expect(server.count).toBe(0);
    vi.stubEnv(TOKEN_ENV, TOKEN);
    const resumed = await runWorkflow(definition, options({ resume: true }));
    expect(resumed.output).toEqual({ ok: true, value: { refund: { noul: 0.4 } } });
    run = await readRun({ stateDir, runId: 'decide' });
    expect(run.steps['ask']?.status).toBe('completed');
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await walk(join(directory, entry.name));
        else files.push(join(directory, entry.name));
    };
    await walk(stateDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it('keeps the token out of HTTP failure errors', async () => {
    server.script({ status: 500, text: 'boom' });
    const error: unknown = await runWorkflow(
      workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
      options(),
    ).catch((caught: unknown) => caught);
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(DecisionError);
    expect(cause).toMatchObject({ provider: 'jev', status: 500, rawText: 'boom' });
    expect((error as Error).message).not.toContain(TOKEN);
    expect(errorKind(cause)).toBe('overloaded');
  });

  it('redacts a token the host echoes from errors, evidence and validation', async () => {
    for (const [index, reply] of [
      { status: 401, text: `bad credentials: Bearer ${TOKEN}` },
      { status: 200, text: `not json, Bearer ${TOKEN}` },
      { status: 200, body: { model: 'm', answers: { refund: { type: 'noul', noul: TOKEN } } } },
    ].entries()) {
      server.script(reply);
      const runId = `echo${String(index)}`;
      const error: unknown = await runWorkflow(
        workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
        options({ runId }),
      ).catch((caught: unknown) => caught);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(DecisionError);
      expect((cause as DecisionError).rawText).toContain('[redacted]');
      expect((cause as DecisionError).rawText).not.toContain(TOKEN);
      expect((cause as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(TOKEN);
      const run = await readRun({ stateDir, runId });
      expect(run.steps['ask']?.attemptHistory?.[0]?.response).toContain('[redacted]');
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    }
  });

  it('cancels an unending response body at the cap and keeps truncated evidence', async () => {
    for (const [status, kind, message] of [
      [200, 'schema', /jev: response exceeds 1048576 bytes/u],
      [503, 'overloaded', /jev: HTTP 503: response exceeds 1048576 bytes/u],
    ] as const) {
      server.script({ flood: true, status });
      const runId = `flood${String(status)}`;
      const error: unknown = await runWorkflow(
        workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
        options({ runId }),
      ).catch((caught: unknown) => caught);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(DecisionError);
      expect(cause).toMatchObject({ provider: 'jev', kind, status, responseTruncated: true });
      expect((cause as Error).message).toMatch(message);
      expect((cause as DecisionError).rawText).toBe('x'.repeat(256 * 1024));
      const run = await readRun({ stateDir, runId });
      expect(run.steps['ask']?.attemptHistory?.[0]).toMatchObject({
        status: 'failed',
        errorKind: kind,
        responseTruncated: true,
      });
    }
    await server.disconnected;
  });

  it('fails a token that is not a valid header value as configuration without echoing it', async () => {
    const secret = 'secret-token-part';
    for (const [index, token] of [
      `${secret}\nX-Injected: 1`,
      `${secret}\u0007`,
      ` ${secret}`,
      `${secret}\u2028`,
    ].entries()) {
      vi.stubEnv(TOKEN_ENV, token);
      const runId = `invalid${String(index)}`;
      const error: unknown = await runWorkflow(
        workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
        options({ runId }),
      ).catch((caught: unknown) => caught);
      expect((error as Error).cause).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toMatch(
        /reads its bearer token from QC_TEST_PROVIDER_TOKEN, whose value is not a valid HTTP header value/u,
      );
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(await readRun({ stateDir, runId }))).not.toContain(secret);
    }
    expect(server.count).toBe(0);
  });

  it('redacts the token from a client error message', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error(`bad header Bearer ${TOKEN}`)));
    try {
      const error: unknown = await runWorkflow(
        workflow([jev()], (ctx) => ctx.decide('ask', { state: null, questions: { refund } })),
        options(),
      ).catch((caught: unknown) => caught);
      expect((error as Error).cause).toBeInstanceOf(DecisionError);
      expect((error as Error).message).toContain('request failed: bad header Bearer [redacted]');
      expect((error as Error).message).not.toContain(TOKEN);
      expect(JSON.stringify(await readRun({ stateDir, runId: 'decide' }))).not.toContain(TOKEN);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails a missing base URL or token variable as configuration from the factory', async () => {
    for (const [provider, pattern] of [
      [jevCompatible({ name: 'jev', apiKeyEnv: TOKEN_ENV, defaultModel: 'm' }), /has no baseUrl/u],
      [jevCompatible({ name: 'jev', baseUrl: server.url, defaultModel: 'm' }), /has no apiKeyEnv/u],
    ] as const) {
      const runId = provider.name + String(pattern);
      const error: unknown = await runWorkflow(
        workflow([provider], (ctx) =>
          ctx.decide('ask', { state: null, questions: { refund }, onError: 'return' }),
        ),
        options({ runId: runId.replace(/[^a-z]/gu, '') }),
      ).catch((caught: unknown) => caught);
      expect((error as Error).cause).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toMatch(pattern);
    }
    expect(server.count).toBe(0);
  });

  it('caches a transport factory failure for the run', async () => {
    const factory = vi.fn(() => {
      throw new Error('no client');
    });
    const provider = defineDecisionProvider({
      name: 'broken',
      revision: 1,
      capabilities: allCapabilities,
      transport: factory,
    });
    const run = await runWorkflow(
      workflow([provider], async (ctx) => {
        const outcomes: string[] = [];
        for (const id of ['a', 'b'])
          try {
            await ctx.decide(id, { state: null, questions: { refund } });
          } catch (error) {
            outcomes.push((error as Error).message);
          }
        return outcomes;
      }),
      options(),
    );
    expect(run.output).toEqual([
      'Decision provider broken transport factory failed: no client',
      'Decision provider broken transport factory failed: no client',
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

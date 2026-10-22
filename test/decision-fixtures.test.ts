// Decision fixtures (#652, ADR 0066 section 5): the internal RunOptions.decisionFixture hook answers
// ctx.decide in place of the provider transport, from FixtureHarness `decisions` entries or by
// synthesis, with the same validation, usage, retry and settled behavior as a live response.
import { describe, expect, vi } from 'vitest';
import {
  ConfigurationError,
  defineWorkflow,
  FixtureHarness,
  parseHarnessFixtures,
  readRun,
  summarizeUsage,
  z,
  type HarnessFixtures,
  type JsonValue,
  type RunOptions,
  type WorkflowContext,
} from '../src/index.js';
import {
  choice,
  defineDecisionProvider,
  DecisionError,
  noul,
  score,
  type DecisionCapabilities,
  type DecisionProviderDeclaration,
  type ProviderTransportFactory,
} from '../src/integrations/decision.js';
import { RehearsalHarness } from '../src/workflow/loader/rehearsal.js';
import { fixtureDecisionBody } from '../src/workflow/runtime/decision-protocol.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';
import { it } from './setup/state-dir.js';

const allCapabilities: DecisionCapabilities = {
  kinds: ['noul', 'choice', 'score'],
  maxOptions: 255,
  levels: [2, 10],
  idempotencyKey: false,
};
const refund = noul({ instructions: 'Refund?' });
const team = choice({ instructions: 'Which team?', options: { a: null, b: 'B', c: null } });
const urgency = score({ instructions: 'How urgent?', levels: ['low', 'mid', 'high'] });
const questions = { refund, team, urgency };
const answers = {
  refund: { noul: 0.25 },
  team: { choice: 'b', probabilities: { a: 0.1, b: 0.7, c: 0.2 }, confidence: 0.8 },
  urgency: {
    score: 1.5,
    probabilities: [0.1, 0.3, 0.6],
    legend: ['low', 'mid', 'high'],
    confidence: 0.9,
  },
};

/** A provider whose transport factory throws: a fixture-answered decision must never build it. */
function guarded(name = 'acme', transport?: ProviderTransportFactory) {
  const factory = vi.fn<ProviderTransportFactory>(
    transport ??
      (() => {
        throw new Error('the transport factory must not be called');
      }),
  );
  return {
    factory,
    provider: defineDecisionProvider({
      name,
      revision: 1,
      capabilities: allCapabilities,
      defaultModel: 'acme-1',
      transport: factory,
    }),
  };
}
function workflow(
  decisions: readonly DecisionProviderDeclaration[],
  run: (ctx: WorkflowContext) => Promise<unknown>,
) {
  return defineWorkflow({
    name: 'decision-fixtures',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    decisions,
    run: async (ctx) => (await run(ctx)) ?? null,
  });
}
function fixtureOptions(
  stateDir: string,
  fixtures: Omit<HarnessFixtures, 'version' | 'calls'>,
  overrides: Partial<Omit<RunOptions, 'harness' | 'decisionFixture'>> = {},
): RunOptions {
  const harness = new FixtureHarness({ version: 1, calls: [], ...fixtures });
  return {
    runId: 'decide',
    stateDir,
    input: null,
    ...overrides,
    harness,
    decisionFixture: (request) => harness.decide(request),
  };
}

describe('fixtureDecisionBody', () => {
  it('infers each answer type from its one headline field and keeps live usage key names', () => {
    expect(
      fixtureDecisionBody({
        answers: { ...answers, odd: { noul: 1, choice: 'a' }, none: { confidence: 1 }, raw: 3 },
        model: 'served',
        usage: { inputTokens: 7, outputTokens: null },
      }),
    ).toEqual({
      model: 'served',
      answers: {
        refund: { type: 'noul', noul: 0.25 },
        team: { type: 'choice', ...answers.team },
        urgency: { type: 'score', ...answers.urgency },
        odd: { noul: 1, choice: 'a' },
        none: { confidence: 1 },
        raw: 3,
      },
      usage: { input_tokens: 7 },
    });
    expect(fixtureDecisionBody({ answers: {}, model: null })).toEqual({ answers: {} });
  });
});

describe('decision fixtures', () => {
  it('return fixture answers verbatim and record the served model and usage', async ({
    stateDir,
    runs,
  }) => {
    const { provider, factory } = guarded();
    const result = await runs.run(
      workflow([provider], (ctx) => ctx.within('w').decide('ask', { state: 1, questions })),
      fixtureOptions(stateDir, {
        decisions: {
          'w/ask': { answers, model: 'served-1', usage: { inputTokens: 7, outputTokens: 3 } },
        },
      }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(result.output).toEqual(answers);
    const step = result.steps['w/ask'];
    expect(step?.output).toEqual({ model: 'served-1', answers });
    expect(step?.attemptHistory?.at(-1)?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      costUsd: null,
      model: { requested: 'acme-1', effective: ['served-1'] },
      provider: 'acme',
      reported: { input_tokens: 7, output_tokens: 3 },
      completeness: 'reported',
    });
    const usage = summarizeUsage(result);
    expect(usage.byProvider['acme']?.byModel['served-1']).toMatchObject({
      attempts: 1,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it('record no served model or reported usage for an entry without them', async ({
    stateDir,
    runs,
  }) => {
    const { provider } = guarded();
    const result = await runs.run(
      workflow([provider], (ctx) => ctx.decide('ask', { state: 1, questions: { refund } })),
      fixtureOptions(stateDir, { decisions: { ask: { answers: { refund: { noul: 1 } } } } }),
    );
    expect(result.steps['ask']?.output).toEqual({ model: null, answers: { refund: { noul: 1 } } });
    expect(result.steps['ask']?.attemptHistory?.at(-1)?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      model: { requested: 'acme-1', effective: null },
      provider: 'acme',
      completeness: 'unavailable',
    });
  });

  it.for([
    [
      'a choice outside the options',
      { ...answers, team: { ...answers.team, choice: 'z' } },
      /answers\.team\.choice/u,
    ],
    [
      'probabilities summing to 0.9',
      { ...answers, team: { ...answers.team, probabilities: { a: 0.1, b: 0.6, c: 0.2 } } },
      /answers\.team\.probabilities: Probabilities must sum to 1/u,
    ],
    [
      'a legend that differs from the levels',
      { ...answers, urgency: { ...answers.urgency, legend: ['low', 'high', 'mid'] } },
      /answers\.urgency\.legend/u,
    ],
    [
      'a noul-shaped answer for a choice question',
      { ...answers, team: { noul: 0.5 } },
      /answers\.team\.type: Answer type is required and must be choice/u,
    ],
  ] as const)(
    'fail a stale entry with kind schema: %s',
    async ([, stale, message], { stateDir, runs }) => {
      const { provider, factory } = guarded();
      const definition = (onError?: 'return') =>
        workflow([provider], (ctx) =>
          ctx.decide('ask', { state: 1, questions, ...(onError ? { onError } : {}) }),
        );
      const fixtures = {
        decisions: {
          ask: { answers: JSON.parse(JSON.stringify(stale)) as Record<string, JsonValue> },
        },
      };
      const thrown: unknown = await runs
        .run(definition(), fixtureOptions(stateDir, fixtures, { runId: 'thrown' }))
        .catch((caught: unknown) => caught);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(DecisionError);
      expect(cause).toMatchObject({ kind: 'schema', provider: 'acme' });
      expect((cause as Error).message).toMatch(message);
      const settled = await runs.run(definition('return'), fixtureOptions(stateDir, fixtures));
      expect(settled.output).toMatchObject({ ok: false, error: { kind: 'schema', attempts: 1 } });
      const attempt = settled.steps['ask']?.attemptHistory?.at(-1);
      expect(attempt?.validationIssues?.length).toBeGreaterThan(0);
      expect(JSON.parse(attempt?.response ?? 'null')).toEqual(
        fixtureDecisionBody(fixtures.decisions.ask),
      );
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it('drive retry.on and onError from an error entry, counting each attempt', async ({
    stateDir,
    runs,
  }) => {
    const { provider, factory } = guarded();
    const definition = (on: 'rate-limit' | 'overloaded') =>
      workflow([provider], (ctx) =>
        ctx.decide('ask', {
          state: null,
          questions: { refund },
          onError: 'return',
          retry: { maxAttempts: 3, delayMs: 0, on: [on] },
        }),
      );
    const fixtures = { decisions: { ask: { error: 'busy', kind: 'rate-limit' as const } } };
    const retried = await runs.run(
      definition('rate-limit'),
      fixtureOptions(stateDir, fixtures, { runId: 'retried' }),
    );
    expect(retried.output).toMatchObject({
      ok: false,
      error: { kind: 'rate-limit', attempts: 3, message: 'Decision provider acme: busy' },
    });
    const usage = summarizeUsage(retried);
    expect(usage.byProvider['acme']).toMatchObject({ attempts: 3, inputTokens: null });
    expect(usage.byProvider['acme']?.byModel['(unknown)']).toMatchObject({
      attempts: 3,
      outcomes: { failed: 3 },
    });
    const once = await runs.run(
      definition('overloaded'),
      fixtureOptions(stateDir, fixtures, { runId: 'once' }),
    );
    expect(once.output).toMatchObject({ ok: false, error: { kind: 'rate-limit', attempts: 1 } });
    const caught = await runs.run(
      workflow([provider], async (ctx) => {
        try {
          await ctx.decide('ask', { state: null, questions: { refund } });
          return 'answered';
        } catch (error) {
          return errorKind(error);
        }
      }),
      fixtureOptions(stateDir, fixtures, { runId: 'caught' }),
    );
    expect(caught.output).toBe('rate-limit');
    const kindless = await runs.run(
      workflow([provider], (ctx) =>
        ctx.decide('ask', { state: null, questions: { refund }, onError: 'return' }),
      ),
      fixtureOptions(stateDir, { decisions: { ask: { error: 'nope' } } }, { runId: 'kindless' }),
    );
    expect(kindless.output).toMatchObject({ ok: false, error: { kind: 'unknown' } });
    expect(factory).not.toHaveBeenCalled();
  });

  it('fail an unmatched decision as fatal configuration, unless unmatched is synthesize', async ({
    stateDir,
    runs,
  }) => {
    const { provider, factory } = guarded();
    const definition = workflow([provider], (ctx) =>
      ctx.decide('ask', {
        state: null,
        questions,
        onError: 'return',
        retry: { maxAttempts: 3, delayMs: 0 },
      }),
    );
    const refused: unknown = await runs
      .run(definition, fixtureOptions(stateDir, { decisions: { other: { answers } } }))
      .catch((caught: unknown) => caught);
    const cause = (refused as Error).cause ?? refused;
    expect(cause).toBeInstanceOf(ConfigurationError);
    expect((cause as Error).message).toBe(
      'No decision fixture matches step ask (provider acme, attempt 1).',
    );
    const step = (await readRun({ stateDir, runId: 'decide' })).steps['ask'];
    expect(step?.status).not.toBe('settled-failed');
    expect(step?.settledError).toBeUndefined();
    expect(step?.attemptHistory).toHaveLength(1);
    const synthesized = await runs.run(
      definition,
      fixtureOptions(stateDir, { unmatched: 'synthesize' }, { runId: 'synthesized' }),
    );
    expect(synthesized.output).toEqual({
      ok: true,
      value: {
        refund: { noul: 0 },
        team: { choice: 'a', probabilities: { a: 1, b: 0, c: 0 }, confidence: 1 },
        urgency: {
          score: 0,
          probabilities: [1, 0, 0],
          legend: ['low', 'mid', 'high'],
          confidence: 1,
        },
      },
    });
    expect(synthesized.steps['ask']?.output).toMatchObject({ model: null });
    expect(factory).not.toHaveBeenCalled();
  });

  it('keep the identity of the same call answered live', async ({ stateDir, runs }) => {
    const fixtureProvider = guarded().provider;
    const live = guarded(
      'acme',
      () => () => Promise.resolve({ body: fixtureDecisionBody({ answers, model: 'served-1' }) }),
    );
    const run = (provider: DecisionProviderDeclaration) =>
      workflow([provider], (ctx) => ctx.decide('ask', { state: { n: 1 }, questions }));
    const fixture = await runs.run(
      run(fixtureProvider),
      fixtureOptions(stateDir, { decisions: { ask: { answers, model: 'served-1' } } }),
    );
    const real = await runs.run(run(live.provider), {
      runId: 'live',
      stateDir,
      input: null,
    });
    expect(live.factory).toHaveBeenCalledTimes(1);
    expect(fixture.steps['ask']?.identity).toEqual(real.steps['ask']?.identity);
    expect(fixture.steps['ask']?.fingerprint).toBe(real.steps['ask']?.fingerprint);
    expect(fixture.steps['ask']?.output).toEqual(real.steps['ask']?.output);
  });
});

describe('parseHarnessFixtures decisions', () => {
  const parse = (decisions: unknown) => parseHarnessFixtures({ version: 1, calls: [], decisions });
  it('accepts answer and error entries keyed by exact step IDs', () => {
    expect(
      parse({
        'w/ask': { answers, model: null, usage: { inputTokens: 1, outputTokens: null } },
        'map:item/x': { answers: {}, model: 'm' },
        fail: { error: 'busy', kind: 'rate-limit' },
        plain: { error: 'boom' },
      }).decisions,
    ).toEqual({
      'w/ask': { answers, model: null, usage: { inputTokens: 1, outputTokens: null } },
      'map:item/x': { answers: {}, model: 'm' },
      fail: { error: 'busy', kind: 'rate-limit' },
      plain: { error: 'boom' },
    });
  });

  it.for([
    ['a glob key', { 'w/*': { answers: {} } }],
    ['a __proto__ key', JSON.parse('{"__proto__":{"answers":{}}}') as unknown],
    ['a leading underscore', { _ask: { answers: {} } }],
    ['model on an error entry', { ask: { error: 'x', model: 'm' } }],
    ['usage on an error entry', { ask: { error: 'x', usage: {} } }],
    ['kind without error', { ask: { answers: {}, kind: 'schema' } }],
    ['an empty error', { ask: { error: '' } }],
    ['an unknown kind', { ask: { error: 'x', kind: 'nope' } }],
    ['the reserved kind configuration', { ask: { error: 'x', kind: 'configuration' } }],
    ['an unknown field', { ask: { answers: {}, extra: true } }],
    ['an unknown usage field', { ask: { answers: {}, usage: { costUsd: 1 } } }],
    ['negative tokens', { ask: { answers: {}, usage: { inputTokens: -1 } } }],
    ['both answers and error', { ask: { answers: {}, error: 'x' } }],
    ['a __proto__ answer', { ask: { answers: JSON.parse('{"__proto__":{"noul":1}}') as unknown } }],
    ['an array', []],
  ] as const)('rejects %s', ([, decisions]) => {
    expect(() => parse(decisions)).toThrow();
  });
});

describe('RehearsalHarness decisions', () => {
  it('synthesize unmatched decisions regardless of the file and report every attempt', async ({
    stateDir,
    runs,
  }) => {
    const { provider, factory } = guarded();
    const harness = new RehearsalHarness(
      {
        kind: 'fixture',
        config: {},
        fixtures: parseHarnessFixtures({
          version: 1,
          calls: [],
          unmatched: 'error',
          decisions: {
            ask: { answers, model: 'served-1' },
            fail: { error: 'busy', kind: 'rate-limit' },
            never: { answers: {} },
            stubbed: { answers: {} },
          },
        }),
      },
      ['stubbed'],
    );
    const result = await runs.run(
      workflow([provider], async (ctx) => {
        const asked = await ctx.decide('ask', { state: null, questions, model: 'asked-model' });
        const failed = await ctx.decide('fail', {
          state: null,
          questions: { refund },
          onError: 'return',
          retry: { maxAttempts: 2, delayMs: 0, on: ['rate-limit'] },
        });
        const synthesized = await ctx.decide('synth', { state: null, questions: { team } });
        await ctx.decide('stubbed', { state: null, questions: { refund } });
        return { asked, failed: failed.ok, synthesized };
      }),
      {
        runId: 'rehearse',
        stateDir,
        input: null,
        harness,
        rehearsal: harness.hooks,
        decisionFixture: (request) => harness.decide(request),
      },
    );
    expect(factory).not.toHaveBeenCalled();
    expect(result.output).toEqual({
      asked: answers,
      failed: false,
      synthesized: { team: { choice: 'a', probabilities: { a: 1, b: 0, c: 0 }, confidence: 1 } },
    });
    const report = harness.report(await readRun({ stateDir, runId: 'rehearse' }));
    expect(report.decisions).toEqual([
      {
        stepId: 'ask',
        attempt: 1,
        provider: 'acme',
        model: 'asked-model',
        outputSource: 'fixture',
        error: null,
      },
      ...[1, 2].map((attempt) => ({
        stepId: 'fail',
        attempt,
        provider: 'acme',
        model: 'acme-1',
        outputSource: 'fixture',
        error: 'busy',
      })),
      {
        stepId: 'synth',
        attempt: 1,
        provider: 'acme',
        model: 'acme-1',
        outputSource: 'synthesized',
        error: null,
      },
    ]);
    expect(report.stubbedSteps).toEqual(['stubbed']);
    expect(report.staleDecisionFixtures).toEqual(['never', 'stubbed']);
    expect(report.warnings).toContainEqual(
      expect.stringContaining('Decision fixture entries never, stubbed answered no decision'),
    );
    expect(report.warnings).toContainEqual(
      expect.stringContaining('Decisions without a fixture entry are synthesized'),
    );
  });

  it('add no decision warnings or entries when no decision runs', async ({ stateDir, runs }) => {
    const harness = new RehearsalHarness({ kind: 'cli', config: {} });
    await runs.run(
      workflow([], () => Promise.resolve('done')),
      {
        runId: 'quiet',
        stateDir,
        input: null,
        harness,
        rehearsal: harness.hooks,
        decisionFixture: (request) => harness.decide(request),
      },
    );
    const report = harness.report(await readRun({ stateDir, runId: 'quiet' }));
    expect(report.decisions).toEqual([]);
    expect(report.staleDecisionFixtures).toEqual([]);
    expect(report.warnings.join('\n')).not.toMatch(/Decision/u);
  });
});

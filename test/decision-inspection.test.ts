// Completed decision steps in inspect and on their step.completed event lines (ADR 0066 section 5,
// #653): the pure summarizer, the run summary and its text, the live --events line and the
// follower's line, and a legacy decision/1 choose step. In-process providers only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type AgentUsage,
  type DecisionStepSummary,
  type WorkflowContext,
  type WorkflowEvent,
} from '../src/index.js';
import {
  choice,
  decision,
  defineDecisionProvider,
  noul,
  score,
  type DecisionProviderDeclaration,
} from '../src/integrations/decision.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { recordEventLines } from '../src/workflow/loader/event-follow.js';
import {
  EventLineMemory,
  WorkflowEventLog,
  formatEventLine,
} from '../src/workflow/loader/events.js';
import type { EventLine } from '../src/workflow/loader/event-line.js';
import { inspectRun, type RunSummary } from '../src/workflow/loader/inspection.js';
import { summarizeDecisionStep } from '../src/workflow/runtime/decision-summary.js';
import type { StepRecord } from '../src/workflow/runtime/record.js';

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-decision-inspection-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const questions = {
  refund: noul({ instructions: 'Refund?' }),
  team: choice({ instructions: 'Which team?', options: { a: null, b: 'B' } }),
  grade: score({ instructions: 'How good?', levels: ['poor', 'fair', 'good'] }),
};

/** A provider that answers the three questions and reports a served model and tokens. */
function stubProvider(): DecisionProviderDeclaration {
  return defineDecisionProvider({
    name: 'stub',
    revision: 1,
    defaultModel: 'stub-latest',
    capabilities: {
      kinds: ['noul', 'choice', 'score'],
      maxOptions: 255,
      levels: [2, 10],
      idempotencyKey: false,
    },
    transport: () => () =>
      Promise.resolve({
        body: {
          model: 'stub-1.2',
          answers: {
            refund: { type: 'noul', noul: 0.25 },
            team: {
              type: 'choice',
              choice: 'a',
              probabilities: { a: 0.8, b: 0.2 },
              confidence: 0.8,
            },
            grade: {
              type: 'score',
              score: 1.9,
              probabilities: [0, 0.1, 0.9],
              legend: ['poor', 'fair', 'good'],
              confidence: 0.7,
            },
          },
          usage: { input_tokens: 120, output_tokens: 15 },
        },
      }),
  });
}

const workflow = (run: (ctx: WorkflowContext) => Promise<unknown>, decisions = [stubProvider()]) =>
  defineWorkflow({
    name: 'decisions',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    decisions,
    run: async (ctx) => (await run(ctx)) ?? null,
  });

const stepSummary = (summary: RunSummary, id: string): RunSummary['steps'][number] => {
  const found = summary.steps.find((step) => step.id === id);
  if (!found) throw new Error(`No summary entry for ${id}.`);
  return found;
};

/** A hand-built decision step record; the summarizer reads only these fields. */
function record(fields: Record<string, unknown>): StepRecord {
  return {
    kind: 'step',
    status: 'completed',
    meta: { integration: 'decision', op: 'decide', provider: 'p', model: 'req' },
    attempts: 1,
    attemptHistory: [],
    output: { model: 'srv', answers: {} },
    ...fields,
  } as unknown as StepRecord;
}

const usage = (inputTokens: number | null, outputTokens: number | null): AgentUsage => ({
  inputTokens,
  outputTokens,
  costUsd: null,
});

describe('summarizeDecisionStep', () => {
  it('summarizes the three kinds from the answer shapes, in recorded order', () => {
    const summary = summarizeDecisionStep(
      record({
        attempts: 2,
        attemptHistory: [{ usage: usage(10, 2) }, { usage: usage(5, 1) }],
        output: {
          model: 'srv-1',
          answers: {
            zed: { noul: 0.5 },
            team: { choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 },
            grade: {
              score: 1.4,
              probabilities: [0, 0.6, 0.4],
              legend: ['lo', 'mid', 'hi'],
              confidence: 0.6,
            },
          },
        },
      }),
    );
    expect(summary).toEqual({
      op: 'decide',
      provider: 'p',
      requestedModel: 'req',
      servedModel: 'srv-1',
      questions: [
        { name: 'zed', kind: 'noul', answer: 0.5 },
        { name: 'team', kind: 'choice', answer: 'b', confidence: 0.9 },
        { name: 'grade', kind: 'score', answer: 1.4, level: 'mid', confidence: 0.6 },
      ],
      usage: { attempts: 2, inputTokens: 15, outputTokens: 3 },
    } satisfies DecisionStepSummary);
    expect(summary?.questions[0]).not.toHaveProperty('confidence');
  });

  it('rounds a score to the nearest level and clamps it to the legend', () => {
    const level = (value: number): string | undefined =>
      summarizeDecisionStep(
        record({
          output: { model: null, answers: { q: { score: value, legend: ['a', 'b', 'c'] } } },
        }),
      )?.questions[0]?.level;
    expect(level(0)).toBe('a');
    expect(level(0.49)).toBe('a');
    expect(level(0.5)).toBe('b');
    expect(level(1.6)).toBe('c');
    expect(level(7)).toBe('c');
    expect(level(-3)).toBe('a');
  });

  it('reports null token totals when any attempt has an unknown count, never a partial sum', () => {
    const summary = summarizeDecisionStep(
      record({
        attempts: 3,
        attemptHistory: [
          { usage: usage(10, 2) },
          { usage: usage(null, 3) },
          { usage: usage(4, null) },
        ],
      }),
    );
    expect(summary?.usage).toEqual({ attempts: 3, inputTokens: null, outputTokens: null });
    const partial = summarizeDecisionStep(
      record({ attemptHistory: [{ usage: usage(10, 2) }, { usage: usage(4, null) }] }),
    );
    expect(partial?.usage).toMatchObject({ inputTokens: 14, outputTokens: null });
  });

  it('reads provider and requested model from the latest attempt, not the original meta', () => {
    const attempt = (provider: string, requested: string | null): Record<string, unknown> => ({
      usage: { ...usage(1, 1), provider, model: { requested, effective: null } },
    });
    const summarize = (fields: Record<string, unknown>) => summarizeDecisionStep(record(fields));
    const later = summarize({
      meta: { integration: 'decision', op: 'decide', provider: 'p1', model: 'm1' },
      attemptHistory: [attempt('p1', 'm1'), attempt('p2', 'm2')],
    });
    expect(later).toMatchObject({ provider: 'p2', requestedModel: 'm2' });
    // A recorded null requested model is the provider default, not a reason to use meta.
    const standard = summarize({
      meta: { integration: 'decision', op: 'decide', provider: 'p1', model: 'm1' },
      attemptHistory: [attempt('p2', null)],
    });
    expect(standard).toMatchObject({ provider: 'p2', requestedModel: null });
    // Without attempt usage, or without its fields, meta still answers.
    for (const attemptHistory of [[], [{ usage: usage(1, 1) }], [{}]])
      expect(
        summarize({
          meta: { integration: 'decision', op: 'decide', provider: 'p1', model: 'm1' },
          attemptHistory,
        }),
      ).toMatchObject({ provider: 'p1', requestedModel: 'm1' });
  });

  it('reports zero usage for a fork-reused step and names its source run', () => {
    const reusedFrom = {
      runId: 'source-run',
      stateDir: '/tmp/source',
      stepId: 'ask',
      fingerprint: 'f',
      at: '2026-01-01T00:00:00.000Z',
    };
    const reused = summarizeDecisionStep(
      record({
        reusedFrom,
        attempts: 2,
        attemptHistory: [{ usage: usage(10, 2) }, { usage: usage(5, 1) }],
        output: { model: 'srv', answers: { q: { noul: 0.5 } } },
      }),
    );
    expect(reused).toEqual({
      op: 'decide',
      provider: 'p',
      requestedModel: 'req',
      servedModel: 'srv',
      questions: [{ name: 'q', kind: 'noul', answer: 0.5 }],
      reusedFrom: 'source-run',
      usage: { attempts: 0, inputTokens: 0, outputTokens: 0 },
    } satisfies DecisionStepSummary);
  });

  it('summarizes a legacy choose step from its answer and last attempt usage', () => {
    const summary = summarizeDecisionStep(
      record({
        meta: { integration: 'decision', op: 'choose' },
        output: { answer: 'yes', probabilities: { yes: 0.7, no: 0.3 } },
        attemptHistory: [
          {
            usage: {
              ...usage(4, 1),
              provider: 'svc',
              model: { requested: 'old', effective: null },
            },
          },
          {
            usage: {
              ...usage(6, 2),
              provider: 'svc',
              model: { requested: 'm1', effective: ['x'] },
            },
          },
        ],
        attempts: 2,
      }),
    );
    expect(summary).toEqual({
      op: 'choose',
      provider: 'svc',
      requestedModel: 'm1',
      servedModel: null,
      questions: [{ name: 'answer', kind: 'choice', answer: 'yes' }],
      usage: { attempts: 2, inputTokens: 10, outputTokens: 3 },
    });
  });

  it('returns null for steps that are not completed decide or choose steps', () => {
    expect(summarizeDecisionStep(record({ status: 'failed' }))).toBeNull();
    expect(summarizeDecisionStep(record({ status: 'settled-failed' }))).toBeNull();
    expect(summarizeDecisionStep(record({ kind: 'exec' }))).toBeNull();
    expect(summarizeDecisionStep(record({ meta: undefined }))).toBeNull();
    expect(
      summarizeDecisionStep(record({ meta: { integration: 'github', op: 'decide' } })),
    ).toBeNull();
    expect(
      summarizeDecisionStep(record({ meta: { integration: 'decision', op: 'other' } })),
    ).toBeNull();
  });

  it('never throws on malformed records', () => {
    const odd = summarizeDecisionStep(
      record({
        meta: { integration: 'decision', op: 'decide', provider: 7, model: null },
        attempts: 'x',
        attemptHistory: [null, 'text', { usage: 'bad' }, {}],
        output: {
          model: 5,
          answers: {
            a: 'text',
            b: null,
            c: [1],
            d: { score: 'high' },
            e: { score: 99, legend: 'nope' },
            f: { score: Number.NaN, legend: ['x'] },
            g: { choice: 3 },
            h: { score: 1, legend: [null, 7] },
          },
        },
      }),
    );
    expect(odd).toMatchObject({
      provider: null,
      requestedModel: null,
      servedModel: null,
      usage: { attempts: 4, inputTokens: null, outputTokens: null },
    });
    expect(odd?.questions.map((entry) => [entry.name, entry.kind, entry.answer])).toEqual([
      ['a', 'unknown', null],
      ['b', 'unknown', null],
      ['c', 'unknown', null],
      ['d', 'unknown', null],
      ['e', 'score', 99],
      ['f', 'unknown', null],
      ['g', 'unknown', null],
      ['h', 'score', 1],
    ]);
    expect(odd?.questions[4]).not.toHaveProperty('level');
    expect(odd?.questions[7]).not.toHaveProperty('level');
    for (const output of [null, 'text', 3, [], { answers: 'x' }, { answers: null }]) {
      expect(summarizeDecisionStep(record({ output }))?.questions).toEqual([]);
      expect(
        summarizeDecisionStep(record({ output, meta: { integration: 'decision', op: 'choose' } })),
      ).toMatchObject({ questions: [], servedModel: null });
    }
    expect(summarizeDecisionStep(record({ attemptHistory: undefined }))?.usage).toEqual({
      attempts: 1,
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe('a ctx.decide run', () => {
  const header = 'decision stub stub-latest->stub-1.2 120/15 tok 1 att';

  it('lists the decision in the inspect summary and text', async () => {
    await runWorkflow(
      workflow((ctx) => ctx.decide('ask', { state: 'ticket text', questions })),
      { runId: 'decide', stateDir, input: null },
    );
    const { summary } = await inspectRun({ stateDir, runId: 'decide' });
    const entry = stepSummary(summary, 'ask');
    expect(entry.status).toBe('completed');
    expect(entry.decision).toEqual({
      op: 'decide',
      provider: 'stub',
      requestedModel: 'stub-latest',
      servedModel: 'stub-1.2',
      questions: [
        { name: 'grade', kind: 'score', answer: 1.9, level: 'good', confidence: 0.7 },
        { name: 'refund', kind: 'noul', answer: 0.25 },
        { name: 'team', kind: 'choice', answer: 'a', confidence: 0.8 },
      ],
      usage: { attempts: 1, inputTokens: 120, outputTokens: 15 },
    });
    expect(entry.decision?.questions[1]).not.toHaveProperty('confidence');
    // The JSON projection carries the same object.
    expect((JSON.parse(JSON.stringify(summary)) as RunSummary).steps[0]?.decision).toEqual(
      entry.decision,
    );
    const text = formatRunSummary({
      ...summary,
      steps: summary.steps.map((step) => ({ ...step, elapsedMs: 1500 })),
    });
    expect(text).toContain(
      [
        'completed ask  decision stub stub-latest -> stub-1.2  1 attempts, 120 in / 15 out tokens  1s',
        '  grade score 1.90 (good) confidence 0.70',
        '  refund noul 0.25',
        '  team choice a confidence 0.80',
      ].join('\n'),
    );
  });

  it('prints a fork-reused decision step as reused instead of its attempts and tokens', async () => {
    await runWorkflow(
      workflow((ctx) => ctx.decide('ask', { state: 'ticket text', questions })),
      { runId: 'decide-source', stateDir, input: null },
    );
    const { summary } = await inspectRun({ stateDir, runId: 'decide-source' });
    const decision = stepSummary(summary, 'ask').decision;
    if (decision === null) throw new Error('Expected a decision summary.');
    const text = formatRunSummary({
      ...summary,
      steps: summary.steps.map((step) => ({
        ...step,
        elapsedMs: null,
        decision: {
          ...decision,
          reusedFrom: 'decide-source',
          usage: { attempts: 0, inputTokens: 0, outputTokens: 0 },
        },
      })),
    });
    expect(text).toContain(
      'completed ask  decision stub stub-latest -> stub-1.2  reused from decide-source',
    );
    expect(text).not.toContain('decision stub stub-latest -> stub-1.2  1 attempts');
  });

  it('prints the defaults for an absent requested model, served model and tokens', async () => {
    const bare = defineDecisionProvider({
      name: 'bare',
      revision: 1,
      capabilities: {
        kinds: ['noul'],
        maxOptions: 255,
        levels: [2, 10],
        idempotencyKey: false,
      },
      transport: () => () =>
        Promise.resolve({ body: { answers: { refund: { type: 'noul', noul: 1 } } } }),
    });
    await runWorkflow(
      workflow(
        (ctx) => ctx.decide('ask', { state: 1, questions: { refund: questions.refund } }),
        [bare],
      ),
      { runId: 'bare', stateDir, input: null },
    );
    const { summary } = await inspectRun({ stateDir, runId: 'bare' });
    expect(stepSummary(summary, 'ask').decision).toMatchObject({
      requestedModel: null,
      servedModel: null,
      usage: { attempts: 1, inputTokens: null, outputTokens: null },
    });
    expect(
      formatRunSummary({
        ...summary,
        steps: summary.steps.map((step) => ({ ...step, elapsedMs: null })),
      }),
    ).toContain(
      'completed ask  decision bare (provider default) -> unknown  1 attempts, ? in / ? out tokens\n  refund noul 1.00',
    );
  });

  it('keeps a failed decision off the decision summary', async () => {
    const failing = defineDecisionProvider({
      name: 'bad',
      revision: 1,
      capabilities: { kinds: ['noul'], maxOptions: 255, levels: [2, 10], idempotencyKey: false },
      defaultModel: 'm',
      transport: () => () => Promise.reject(new Error('down')),
    });
    await runWorkflow(
      workflow(
        (ctx) =>
          ctx.decide('ask', {
            state: 1,
            questions: { refund: questions.refund },
            onError: 'return',
            retry: { maxAttempts: 1 },
          }),
        [failing],
      ),
      { runId: 'failed', stateDir, input: null },
    );
    const { summary } = await inspectRun({ stateDir, runId: 'failed' });
    expect(stepSummary(summary, 'ask')).toMatchObject({ status: 'settled-failed', decision: null });
    expect(formatRunSummary(summary)).toContain('settled-failed ask  decision.decide');
  });

  it('carries the same msg on the live --events line and the followed line', async () => {
    const events: WorkflowEvent[] = [];
    const written: string[] = [];
    const log = new WorkflowEventLog({
      target: { write: (line) => written.push(line.trimEnd()) },
      logger: { log: () => undefined },
    });
    await runWorkflow(
      workflow((ctx) => ctx.decide('ask', { state: 'ticket text', questions })),
      {
        runId: 'live',
        stateDir,
        input: null,
        onEvent: (event) => {
          events.push(event);
          log.observe(event);
        },
      },
    );
    const completed = events.find((event) => event.type === 'step.completed');
    expect(completed?.decision?.op).toBe('decide');
    const live = written
      .map((line) => JSON.parse(line) as EventLine)
      .find((line) => line.ev === 'step.completed');
    const expected = `${header}: grade=1.90 good c0.70, refund=0.25, team=a c0.80`;
    expect(live?.msg).toBe(expected);
    const run = await readRun({ stateDir, runId: 'live' });
    const followed = recordEventLines(run, null, 'all').lines.map(
      (line) => JSON.parse(line) as EventLine,
    );
    const followedLine = followed.find((line) => line.ev === 'step.completed');
    expect(followedLine?.msg).toBe(expected);
    expect(followedLine?.step).toBe(live?.step);
  });
});

describe('a legacy decision/1 choose run', () => {
  it('inspects, formats and follows without error', async () => {
    await runWorkflow(
      defineWorkflow({
        name: 'legacy',
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: async (ctx) =>
          decision(ctx, () =>
            Promise.resolve({
              output: { answer: 'yes', probabilities: { yes: 0.75, no: 0.25 } },
              usage: {
                inputTokens: 4,
                outputTokens: 1,
                costUsd: null,
                provider: 'svc',
                model: { requested: 'm1', effective: null },
              },
            }),
          ).choose('pick', { state: 'x', question: 'Ship?', answers: ['yes', 'no'] }),
      }),
      { runId: 'legacy', stateDir, input: null },
    );
    const { summary, run } = await inspectRun({ stateDir, runId: 'legacy' });
    const entry = stepSummary(summary, 'pick');
    expect(entry.decision).toEqual({
      op: 'choose',
      provider: 'svc',
      requestedModel: 'm1',
      servedModel: null,
      questions: [{ name: 'answer', kind: 'choice', answer: 'yes' }],
      usage: { attempts: 1, inputTokens: 4, outputTokens: 1 },
    });
    expect(entry.decision?.questions[0]).not.toHaveProperty('confidence');
    const text = formatRunSummary({
      ...summary,
      steps: summary.steps.map((step) => ({ ...step, elapsedMs: null })),
    });
    expect(text).toContain(
      'completed pick  decision svc m1 -> unknown  1 attempts, 4 in / 1 out tokens\n  answer choice yes',
    );
    const lines = recordEventLines(run, null, 'all').lines.map(
      (line) => JSON.parse(line) as EventLine,
    );
    expect(lines.find((line) => line.ev === 'step.completed')?.msg).toBe(
      'decision svc m1->- 4/1 tok 1 att: answer=yes',
    );
    // The live formatter agrees with the follower.
    const live = formatEventLine(
      {
        type: 'step.completed',
        at: '2026-10-01T12:00:00.000Z',
        execution: 1,
        runId: 'legacy',
        stepId: 'pick',
        attempt: 1,
        decision: entry.decision ?? undefined,
      } as WorkflowEvent,
      new EventLineMemory(),
    );
    expect((JSON.parse(live ?? '{}') as EventLine).msg).toBe(
      'decision svc m1->- 4/1 tok 1 att: answer=yes',
    );
  });

  it('still inspects a legacy step that reported no usage', async () => {
    await runWorkflow(
      defineWorkflow({
        name: 'legacy',
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: async (ctx) =>
          decision(ctx, () =>
            Promise.resolve({ output: { answer: 'no', probabilities: { yes: 0.1, no: 0.9 } } }),
          ).choose('pick', { state: 'x', question: 'Ship?', answers: ['yes', 'no'] }),
      }),
      { runId: 'legacy-bare', stateDir, input: null },
    );
    const { summary, run } = await inspectRun({ stateDir, runId: 'legacy-bare' });
    expect(stepSummary(summary, 'pick').decision).toMatchObject({
      op: 'choose',
      provider: null,
      requestedModel: null,
      usage: { attempts: 1, inputTokens: null, outputTokens: null },
    });
    expect(() => formatRunSummary(summary)).not.toThrow();
    expect(() => recordEventLines(run, null, 'all')).not.toThrow();
  });
});

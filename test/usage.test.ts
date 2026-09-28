import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  summarizeUsage,
  z,
  type AgentUsage,
  type RunRecord,
  type StepRecord,
} from '../src/index.js';
import { parseClaude, parseCodex } from '../src/harnesses/protocol.js';
import { claudeUsage, codexUsage } from '../src/harnesses/usage.js';
import { normalizeUsage } from '../src/workflow/runtime/usage.js';

type StepKind = StepRecord['kind'];

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'choir-usage-'));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('uses Claude session model totals from the original 2.1.283 capture and preserves raw cache TTLs', async () => {
  const fixture = z
    .object({ stdout: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          new URL('./fixtures/harness-usage/claude-session-usage.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const parsed = parseClaude(fixture.stdout, true, 'haiku');
  expect(parsed.kind).toBe('success');
  if (parsed.kind !== 'success') throw new Error('fixture failed');
  const usage = parsed.response.usage;
  expect(usage).toMatchObject({
    inputTokens: 22605,
    outputTokens: 812,
    tokens: { uncachedInput: 937, cacheRead: 18662, cacheWrite: 3006, output: 812, reasoning: 560 },
    model: { requested: 'haiku', effective: ['claude-haiku-4-5-20251001'] },
    reported: { usage: { input_tokens: 19, cache_creation: { ephemeral_1h_input_tokens: 3006 } } },
  });
  expect(
    Object.values(usage.byModel ?? {}).reduce((sum, model) => sum + (model.costUsd ?? 0), 0),
  ).toBeCloseTo(usage.costUsd ?? 0, 12);
  expect(usage.costUsd).toBeCloseTo(0.0128752, 12);
});

it('retains all five nonzero Codex 0.157.1 counters and does not invent an effective model', async () => {
  const fixture = z
    .object({ stdout: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          new URL('./fixtures/harness-usage/codex-usage-success.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  expect(parseCodex(fixture.stdout, 'gpt-5.5')).toMatchObject({
    kind: 'success',
    response: {
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        costUsd: null,
        tokens: { uncachedInput: null, cacheRead: 40, cacheWrite: 20, output: 30, reasoning: 12 },
        model: { requested: 'gpt-5.5', effective: null },
        reported: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 12,
        },
      },
    },
  });
});

it('classifies partial native measurements consistently even without aggregate counters', () => {
  expect(codexUsage({ cached_input_tokens: 4 }, null)).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    tokens: { cacheRead: 4 },
    completeness: 'reported',
  });
  expect(claudeUsage({ modelUsage: { model: { inputTokens: 'invalid' } } }, null)).toMatchObject({
    inputTokens: null,
    completeness: 'unavailable',
  });
});

it('keeps known custom fields and extras while making missing or malformed measurements unknown', () => {
  const usage = normalizeUsage({
    costUsd: 0.1,
    outputTokens: -2,
    inputTokens: NaN,
    future: { seconds: 3 },
    tokens: { cacheRead: 4, futureCategory: 5 },
    byModel: { model: { output: 2, custom: true } },
  });
  expect(usage).toMatchObject({
    costUsd: 0.1,
    inputTokens: null,
    outputTokens: null,
    future: { seconds: 3 },
    tokens: { cacheRead: 4, uncachedInput: null, futureCategory: 5 },
    byModel: { model: { output: 2, custom: true } },
  });
  expect(usage['normalizationWarnings']).toHaveLength(2);
  expect(normalizeUsage(undefined)).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    completeness: 'unavailable',
  });
});

it('accepts missing custom usage and preserves extra measurements through the result and checkpoint', async () => {
  const stateDir = await directory();
  const definition = defineWorkflow({
    name: 'lenient-usage',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      const first = await ctx.claude.text('partial', { prompt: 'first', model: 'requested-model' });
      expect(first.usage).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        costUsd: 0.02,
        future: { requests: 3 },
        model: { requested: 'requested-model', effective: null },
      });
      const absent = await ctx.codex.text('absent', { prompt: 'second' });
      expect(absent.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
      return null;
    },
  });
  await runWorkflow(definition, {
    stateDir,
    runId: 'lenient',
    input: null,
    harness: {
      invoke: (request) =>
        Promise.resolve({
          text: 'ok',
          sessionId: null,
          ...(request.provider === 'claude'
            ? { usage: { costUsd: 0.02, future: { requests: 3 } } }
            : {}),
        }),
    },
  });
  const record = await readRun({ stateDir, runId: 'lenient' });
  expect(record.steps['partial']?.attemptHistory?.[0]?.usage).toMatchObject({
    costUsd: 0.02,
    future: { requests: 3 },
  });
  expect(summarizeUsage(record)).toMatchObject({
    attempts: 2,
    unknownUsageAttempts: 1,
    unknownCostAttempts: 1,
    costUsd: 0.02,
    outcomes: { completed: 2 },
    byHarness: { claude: { attempts: 1 }, codex: { attempts: 1 } },
    byModel: { '(unknown)': { attempts: 2 } },
  });
});

it('resumes an actual pre-change checkpoint without changing agent identity or invoking again', async () => {
  const stateDir = await directory();
  const bytes = await readFile(
    new URL('./fixtures/harness-usage/pre-usage-checkpoint.json', import.meta.url),
    'utf8',
  );
  await mkdir(join(stateDir, 'pre-usage'));
  await writeFile(join(stateDir, 'pre-usage', 'run.json'), bytes);
  await writeFile(join(stateDir, 'pre-usage', 'journal.jsonl'), '');
  let observed: AgentUsage | undefined;
  const definition = defineWorkflow({
    name: 'usage-compatibility',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      observed = (await ctx.claude.text('agent', { prompt: 'hello' })).usage;
      return null;
    },
  });
  const result = await runWorkflow(definition, {
    stateDir,
    cwd: '/',
    runId: 'pre-usage',
    resume: true,
    fingerprint: 'usage-compatibility',
    maxRunCostUsd: 0,
    maxRunAgentAttempts: 0,
    harness: {
      invoke() {
        throw new Error('replay must not invoke');
      },
    },
  });
  expect(result.status).toBe('completed');
  expect(observed).toMatchObject({ inputTokens: 12, outputTokens: 3, costUsd: 0.01 });
  expect(summarizeUsage(result)).toMatchObject({
    attempts: 1,
    legacyTokenAttempts: 1,
    costUsd: 0.01,
  });
});

it('counts a rejected response and its successful retry once, and excludes fork-reused spend', async () => {
  const stateDir = await directory();
  let calls = 0;
  const definition = defineWorkflow({
    name: 'usage-retry',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.claude.object('answer', {
        prompt: 'x',
        schema: z.object({ count: z.number() }),
        retry: { maxAttempts: 2, delayMs: 0 },
      });
      return null;
    },
  });
  const tokens = { uncachedInput: 5, cacheRead: 3, cacheWrite: 2, output: 3, reasoning: 1 };
  const harness = {
    invoke: () => {
      calls++;
      const costUsd = calls / 10;
      return Promise.resolve({
        text: calls === 1 ? '{"count":"bad"}' : '{"count":2}',
        sessionId: `session-${String(calls)}`,
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          costUsd,
          tokens,
          model: { requested: 'alias', effective: ['actual-model'] },
          byModel: { 'actual-model': { ...tokens, costUsd } },
        },
      });
    },
  };
  const run = await runWorkflow(definition, { stateDir, runId: 'retry', input: null, harness });
  expect(run.steps['answer']?.attemptHistory?.[0]).toMatchObject({
    status: 'failed',
    sessionId: 'session-1',
    response: '{"count":"bad"}',
    validationIssues: [{ path: ['count'] }],
    usage: { costUsd: 0.1 },
  });
  const summary = summarizeUsage(run);
  expect(summary).toMatchObject({
    attempts: 2,
    inputTokens: 20,
    outputTokens: 6,
    unknownCostAttempts: 0,
    outcomes: { failed: 1, completed: 1 },
    tokens: { reasoning: 2, output: 6 },
    byModel: { 'actual-model': { attempts: 2, inputTokens: 20, outputTokens: 6 } },
  });
  expect(summary.costUsd).toBeCloseTo(0.3);
  const resumed = await runWorkflow(definition, {
    stateDir,
    runId: 'retry',
    resume: true,
    harness,
  });
  expect(summarizeUsage(resumed)).toEqual(summary);
  const fork = await runWorkflow(definition, {
    stateDir,
    runId: 'fork',
    forkFrom: { runId: 'retry' },
    harness,
    maxRunCostUsd: 0,
    maxRunAgentAttempts: 0,
  });
  expect(summarizeUsage(fork)).toMatchObject({ attempts: 0, costUsd: 0, unknownUsageAttempts: 0 });
  expect(calls).toBe(2);
});

it('classifies legacy attempts by the kind they ran under across redefinitions', async () => {
  const stateDir = await directory();
  const agent = defineWorkflow({
    name: 'usage-redefined',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.claude.text('effect', { prompt: 'x' });
      return null;
    },
  });
  const localWorkflow = defineWorkflow({
    ...agent,
    async run(ctx) {
      await ctx.step('effect', {
        input: null,
        schema: z.null(),
        run: () => {
          throw new Error('local failed');
        },
      });
      return null;
    },
  });
  const options = {
    stateDir,
    runId: 'redefined',
    fingerprint: 'usage-redefined',
    harness: { invoke: () => Promise.reject(new Error('agent failed')) },
  };
  await expect(runWorkflow(agent, { ...options, input: null })).rejects.toThrow('agent failed');
  await expect(runWorkflow(localWorkflow, { ...options, resume: true })).rejects.toThrow(
    'local failed',
  );
  const saved = await readRun(options);
  expect(saved.steps['effect']).toMatchObject({
    kind: 'step',
    attempts: 2,
    redefinitions: [{ kind: 'claude', attempts: 1 }],
  });
  expect(summarizeUsage(saved)).toMatchObject({ attempts: 1, legacyAttempts: 0 });

  // A migrated format-one attempt has no history entry; it keeps the kind it ran under.
  const legacy = (run: RunRecord, kinds: [StepKind, StepKind]): RunRecord => {
    const copy = structuredClone(run);
    const step = copy.steps['effect'];
    const redefinition = step?.redefinitions?.[0];
    if (!step?.attemptHistory || !redefinition) throw new Error('missing fixture');
    step.redefinitions = [{ ...redefinition, kind: kinds[0] }];
    step.kind = kinds[1];
    step.legacyAttempts = 1;
    step.attemptHistory = step.attemptHistory.filter((attempt) => attempt.attempt !== 1);
    return copy;
  };
  expect(summarizeUsage(legacy(saved, ['claude', 'step']))).toMatchObject({
    attempts: 1,
    byHarness: { claude: { attempts: 1, outcomes: { failed: 1 } } },
    legacyAttempts: 1,
    undercounted: true,
  });
  // The reverse direction never charges a legacy local attempt as agent work.
  expect(summarizeUsage(legacy(saved, ['step', 'claude']))).toMatchObject({
    attempts: 0,
    legacyAttempts: 0,
    undercounted: false,
  });

  // A redefinition from an older runtime cannot say what ran before it: never charged, but flagged.
  const ambiguous = legacy(saved, ['claude', 'step']);
  const step = ambiguous.steps['effect'];
  const redefinition = step?.redefinitions?.[0];
  if (!step || !redefinition) throw new Error('missing fixture');
  const { fingerprint, identity, redefinedAt } = redefinition;
  step.redefinitions = [{ fingerprint, identity, redefinedAt }];
  expect(summarizeUsage(ambiguous)).toMatchObject({
    attempts: 0,
    legacyAttempts: 1,
    undercounted: true,
  });
});

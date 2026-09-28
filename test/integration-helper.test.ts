import { pinnedFork } from '../src/workflow/runtime/fork.js';
import type { ForkProvenance } from '../src/workflow/runtime/replay-model.js';
/* eslint-disable @typescript-eslint/require-await -- Deliberately immediate asynchronous fake transports. */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defineWorkflow, runWorkflow, readRun, summarizeUsage, z } from '../src/index.js';
import { decision } from '../src/integrations/decision.js';
import { agentIdentity } from '../src/workflow/runtime/identity.js';
import { digest } from '../src/workflow/runtime/json.js';
import { parseRunRecord } from '../src/workflow/runtime/record.js';

const directories: string[] = [];
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-helper-'));
  directories.push(stateDir);
  return { stateDir, runId: 'helper', input: null };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const base = { name: 'helper', version: '1', input: z.null(), output: z.string() };
const usage = { inputTokens: 2, outputTokens: 1, costUsd: 0.2 };

it('records one ordinary effect per fake-transport helper call and retains separate usage on replay', async () => {
  const options = await setup();
  const keys: string[] = [];
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const answer = await decision(ctx, async (_question, context) => {
        keys.push(context.idempotencyKey);
        expect(context.signal.aborted).toBe(false);
        return { output: { answer: 'fix', probabilities: { fix: 0.75, skip: 0.25 } }, usage };
      }).choose('route', {
        state: { ready: true },
        question: 'What next?',
        answers: ['fix', 'skip'],
      });
      await ctx.codex.value('note', { prompt: answer.answer });
      return answer.answer;
    },
  });
  const runOptions = {
    ...options,
    maxRunAgentAttempts: 1,
    harness: { invoke: async () => ({ text: 'noted', sessionId: null }) },
  };
  const result = await runWorkflow(definition, runOptions);
  expect(Object.keys(result.steps)).toEqual(['route', 'note']);
  expect(result.steps['route']).toMatchObject({
    kind: 'step',
    meta: { integration: 'decision', op: 'choose' },
    attemptHistory: [{ integration: 'decision', usage }],
  });
  expect(summarizeUsage(result)).toMatchObject({
    attempts: 1,
    integrationUsage: { attempts: 1, costUsd: 0.2 },
    byIntegration: { decision: { attempts: 1, costUsd: 0.2 } },
  });
  await runWorkflow(definition, { ...runOptions, resume: true, acceptCodeChange: true });
  expect(keys).toEqual(['helper/route']);
});

it('gives every transport attempt a copy of the fingerprinted decision snapshot', async () => {
  const seen: unknown[] = [];
  const options = await setup();
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const question = {
        state: { ready: true, items: ['a'] },
        question: 'What next?',
        answers: ['fix', 'skip'] as const,
      };
      const pending = decision(ctx, async (asked) => {
        seen.push(structuredClone(asked));
        if (seen.length === 1) {
          // A transport that mutates its argument must not change the retried request.
          Object.assign(asked, { question: 'Mutated by transport' });
          (asked.state as { items: string[] }).items.push('transport');
          throw new Error('transient');
        }
        return { output: { answer: 'fix', probabilities: { fix: 1, skip: 0 } } };
      }).choose('route', question);
      // Caller mutations after choose() returns must not reach the transport.
      Object.assign(question, { question: 'Mutated by caller' });
      question.state.items.push('caller');
      return (await pending).answer;
    },
  });
  const result = await runWorkflow(definition, {
    ...options,
    policy: [{ match: 'route', retry: { maxAttempts: 2, delayMs: 0 } }],
  });
  expect(result.output).toBe('fix');
  const original = {
    state: { ready: true, items: ['a'] },
    question: 'What next?',
    answers: ['fix', 'skip'],
  };
  expect(seen).toEqual([original, original]);
  const unmutated = await runWorkflow(
    defineWorkflow({
      ...base,
      async run(ctx) {
        const answer = await decision(ctx, async () => ({
          output: { answer: 'fix', probabilities: { fix: 1, skip: 0 } },
        })).choose('route', { ...original, answers: ['fix', 'skip'] });
        return answer.answer;
      },
    }),
    await setup(),
  );
  // The durable identity is the original question, not either mutated form.
  expect(result.steps['route']?.fingerprint).toBe(unmutated.steps['route']?.fingerprint);
});

it('retains helper usage on local validation failure and includes cost when gating new agents', async () => {
  const options = await setup();
  const bad = defineWorkflow({
    ...base,
    async run(ctx) {
      await decision(ctx, async () => ({ output: { answer: 'unknown' }, usage })).choose('bad', {
        state: null,
        question: 'x',
        answers: ['a', 'b'],
      });
      return 'unreachable';
    },
  });
  await expect(runWorkflow(bad, options)).rejects.toThrow();
  expect(summarizeUsage(await readRun(options))).toMatchObject({
    attempts: 0,
    integrationUsage: { attempts: 1, outcomes: { failed: 1 }, costUsd: 0.2 },
  });
  const capped = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.step('billed', {
        input: null,
        schema: z.null(),
        run({ reportUsage }) {
          reportUsage(usage);
          return null;
        },
      });
      return ctx.codex.value('agent', { prompt: 'x' });
    },
  });
  const cappedOptions = {
    ...(await setup()),
    maxRunCostUsd: 0.1,
    harness: {
      invoke: async () => {
        throw new Error('must not invoke');
      },
    },
  };
  await expect(runWorkflow(capped, cappedOptions)).rejects.toThrow('maxRunCostUsd');
  expect(summarizeUsage(await readRun(cappedOptions)).attempts).toBe(0);
});

it('rejects non-normalized decision distributions and tolerates float error', async () => {
  const choose = (probabilities: Record<string, number>) =>
    defineWorkflow({
      ...base,
      async run(ctx) {
        const answers = Object.keys(probabilities) as [string, ...string[]];
        const answer = await decision(ctx, async () => ({
          output: { answer: answers[0], probabilities },
        })).choose('route', { state: null, question: 'x', answers });
        return answer.answer;
      },
    });
  const options = await setup();
  await expect(runWorkflow(choose({ fix: 0.2, skip: 0.2 }), options)).rejects.toThrow(
    'Probabilities must sum to 1.',
  );
  expect((await readRun(options)).steps['route']).toMatchObject({
    status: 'failed',
    output: null,
  });
  // 0.7 + 0.2 + 0.1 is 0.9999999999999999 in binary floating point.
  expect((await runWorkflow(choose({ a: 0.7, b: 0.2, c: 0.1 }), await setup())).output).toBe('a');
});

it('excludes step labels from identity and rejects late usage reporters', async () => {
  const options = await setup();
  let label = 'first';
  let late: ((value: typeof usage) => void) | undefined;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.step('local', {
        meta: { label },
        input: null,
        schema: z.string(),
        run({ reportUsage }) {
          late = reportUsage;
          return 'saved';
        },
      });
    },
  });
  const first = await runWorkflow(definition, options);
  expect(() => late?.(usage)).toThrow('active local callback');
  label = 'second';
  const next = await runWorkflow(definition, { ...options, resume: true, acceptCodeChange: true });
  expect(next.steps['local']?.fingerprint).toBe(first.steps['local']?.fingerprint);
});

it('pins built-in revision-one digests to predecessor e25f264 and normalizes its recorded names on read', async () => {
  // Generated by the actual predecessor identity function before the provider rename.
  expect(
    digest(
      agentIdentity(
        {
          harness: 'claude',
          revision: 1,
          cwd: '/repo',
          outputSchema: null,
          options: {
            prompt: 'golden',
            isolation: 'restricted',
            ...{ tools: [], allowedTools: [] },
          },
        },
        { type: 'string' },
      ),
    ),
  ).toBe('eba9c4cc41cf4e7947e5d6a17985c9dc8b9b73a7a8c1a19f9b71198e302fd7c4');
  expect(
    digest(
      agentIdentity(
        {
          harness: 'codex',
          revision: 1,
          cwd: '/repo',
          outputSchema: null,
          options: {
            prompt: 'golden',
            isolation: 'restricted',
            ...{ sandbox: 'read-only', reasoningEffort: 'high' },
          },
        },
        { type: 'string' },
      ),
    ),
  ).toBe('54cb5c4986fa7137d459cde11de005fae90ab1854887030c95b8387d90ef3e5e');
  const result = await runWorkflow(
    defineWorkflow({
      ...base,
      async run(ctx) {
        return ctx.codex.value('old', { prompt: 'x' });
      },
    }),
    { ...(await setup()), harness: { invoke: async () => ({ text: 'saved', sessionId: null }) } },
  );
  const legacy = structuredClone(result);
  const step = legacy.steps['old'];
  if (!step) throw new Error('Missing step');
  step.kind = 'codex';
  delete step.harness;
  delete step.revision;
  for (const request of [
    step.request,
    ...(step.attemptHistory?.map((attempt) => attempt.request) ?? []),
  ]) {
    if (!request) continue;
    Object.assign(request, { provider: request.harness });
    Reflect.deleteProperty(request, 'harness');
    Reflect.deleteProperty(request, 'revision');
  }
  const bytes = JSON.stringify(legacy);
  const normalized = parseRunRecord(bytes, 'helper');
  expect(normalized.steps['old']).toMatchObject({
    kind: 'agent',
    harness: 'codex',
    revision: 1,
    fingerprint: result.steps['old']?.fingerprint,
    request: { harness: 'codex' },
  });
  expect(JSON.stringify(legacy)).toBe(bytes);
  const oldSource = { ...legacy, id: 'old-source', formatVersion: 6 };
  const oldState = await setup();
  const path = join(oldState.stateDir, 'old-source.json');
  const saved = JSON.stringify(oldSource);
  await writeFile(path, saved);
  const pin: ForkProvenance = {
    runId: 'old-source',
    stateDir: oldState.stateDir,
    sourceDigest: digest(oldSource),
    fingerprint: oldSource.workflow.fingerprint,
    reuse: 'prefix',
    invalidate: [],
    differences: [],
    at: oldSource.createdAt,
    cursor: 0,
    reuseClosed: false,
  };
  expect((await pinnedFork(pin))?.steps['old']?.kind).toBe('agent');
  expect(pin.reuseClosed).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(saved);
  await writeFile(path, JSON.stringify({ ...oldSource, error: 'changed source' }));
  expect(await pinnedFork(pin)).toBeUndefined();
  expect(pin.reuseClosed).toBe(true);
});

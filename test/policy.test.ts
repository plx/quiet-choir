import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  CliHarness,
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type ClaudeOptions,
  type Harness,
  type PolicyOverride,
  type WorkflowContext,
} from '../src/index.js';

let stateDir: string;
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
const options = () => ({ runId: 'policy', stateDir, input: null });
const workflow = (run: (ctx: WorkflowContext) => Promise<string>) =>
  defineWorkflow({ name: 'policy', version: '1', input: z.null(), output: z.string(), run });
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-policy-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('recovers a timed-out review with a sticky override and replays completed work', async () => {
  const calls: string[] = [];
  const local = vi.fn(() => 'ok');
  const write = vi.fn(() => 'done');
  let pause = true;
  const harness: Harness = {
    policyDefaults: () => ({
      timeoutMs: 100,
      maxTurns: 25,
      maxBudgetUsd: 0.25,
      binary: 'fixture',
      maxOutputBytes: 8000,
      killGraceMs: 250,
    }),
    invoke(request) {
      calls.push(request.options.prompt);
      if (request.options.prompt === 'review' && request.options.timeoutMs === 100)
        return Promise.reject(new Error('deadline'));
      return Promise.resolve(reply);
    },
  };
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('plan', { prompt: 'plan' });
    await ctx.step('local', { input: null, schema: z.string(), run: local });
    await ctx.claude.text('review', { prompt: 'review' });
    const output = await ctx.step('write', { input: null, schema: z.string(), run: write });
    if (pause) throw new Error('pause');
    return output;
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('deadline');
  const first = (await readRun(options())).steps['review']?.attemptHistory?.[0];
  expect(first).toMatchObject({
    status: 'failed',
    error: 'deadline',
    policy: { timeoutMs: 100, retry: { maxAttempts: 1, delayMs: 100 } },
    sources: { timeoutMs: 'harness', 'retry.maxAttempts': 'runtime' },
  });
  await expect(
    runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      policy: [{ match: 'review', timeoutMs: 600_000 }],
    }),
  ).rejects.toThrow('pause');
  pause = false;
  const result = await runWorkflow(definition, { ...options(), harness, resume: true });
  expect(calls).toEqual(['plan', 'review', 'review']);
  expect(local).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(result.policy).toEqual([{ match: 'review', timeoutMs: 600_000 }]);
  expect(result.steps['review']?.attemptHistory?.[0]).toEqual(first);
  expect(result.steps['review']?.attemptHistory?.[1]).toMatchObject({
    status: 'completed',
    policy: { timeoutMs: 600_000, maxTurns: 25, maxBudgetUsd: 0.25, binary: 'fixture' },
    sources: { timeoutMs: 'override:0', maxTurns: 'harness' },
  });
  expect(
    result.steps['review']?.attemptHistory?.every((attempt) => attempt.finishedAt !== null),
  ).toBe(true);
});

it.each(['timeoutMs', 'maxTurns', 'maxBudgetUsd', 'retry'] as const)(
  'allows call-site %s changes for failed and completed calls',
  async (field) => {
    let updated = false;
    let pause = true;
    const invoke = vi
      .fn<Harness['invoke']>()
      .mockRejectedValueOnce(new Error('limit'))
      .mockResolvedValue(reply);
    const definition = workflow(async (ctx) => {
      const values =
        field === 'retry'
          ? { retry: { maxAttempts: updated ? 2 : 1, delayMs: 0 } }
          : { [field]: updated ? 1000 : 1 };
      const result = await ctx.claude.text('ask', { prompt: 'fixed', ...values });
      if (pause) throw new Error('pause');
      return result.output;
    });
    const setup = { ...options(), harness: { invoke } };
    await expect(runWorkflow(definition, setup)).rejects.toThrow('limit');
    updated = true;
    await expect(runWorkflow(definition, { ...setup, resume: true })).rejects.toThrow('pause');
    updated = false;
    pause = false;
    const result = await runWorkflow(definition, { ...setup, resume: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.steps['ask']?.redefinitions).toBeUndefined();
    expect(result.steps['ask']?.attemptHistory).toHaveLength(2);
  },
);

it('changes local retry policy without changing identity and retries agents explicitly', async () => {
  let retry = { maxAttempts: 1, delayMs: 0 };
  const local = vi.fn().mockRejectedValueOnce(new Error('local')).mockResolvedValue('ok');
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('agent'))
    .mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), retry, run: local });
    return (
      await ctx.codex.text('agent', { prompt: 'same', retry: { maxAttempts: 2, delayMs: 0 } })
    ).output;
  });
  await expect(runWorkflow(definition, { ...options(), harness: { invoke } })).rejects.toThrow(
    'local',
  );
  retry = { maxAttempts: 3, delayMs: 0 };
  const result = await runWorkflow(definition, { ...options(), harness: { invoke }, resume: true });
  expect(local).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[0]?.[0].options).not.toHaveProperty('retry');
  expect(result.steps['local']?.redefinitions).toBeUndefined();
  expect(result.steps['agent']?.attemptHistory?.map((a) => a.status)).toEqual([
    'failed',
    'completed',
  ]);
});

it.each(['failed', 'running'] as const)(
  'adopts changed %s identity, retains its history, and emits after persistence',
  async (status) => {
    let prompt = 'old';
    const invoke = vi
      .fn<Harness['invoke']>()
      .mockRejectedValueOnce(new Error('incomplete'))
      .mockResolvedValue(reply);
    const definition = workflow(async (ctx) => (await ctx.claude.text('ask', { prompt })).output);
    const setup = { ...options(), harness: { invoke } };
    await expect(runWorkflow(definition, setup)).rejects.toThrow('incomplete');
    const saved = await readRun(options());
    const old = saved.steps['ask'];
    if (!old) throw new Error('missing fixture');
    const fingerprint = old.fingerprint;
    old.status = status;
    await writeFile(join(stateDir, 'policy.json'), JSON.stringify(saved));
    prompt = 'new';
    const events: string[] = [];
    const snapshots: Promise<unknown>[] = [];
    const result = await runWorkflow(definition, {
      ...setup,
      resume: true,
      onEvent(event) {
        events.push(event.type);
        if (event.type === 'step.redefined')
          snapshots.push(
            readRun(options()).then((record) => {
              expect(record.steps['ask']?.redefinitions?.[0]?.fingerprint).toBe(fingerprint);
            }),
          );
      },
    });
    await Promise.all(snapshots);
    expect(events).toEqual(['step.redefined', 'step.started', 'step.completed']);
    expect(result.steps['ask']?.fingerprint).not.toBe(fingerprint);
    expect(result.steps['ask']?.redefinitions?.[0]).toMatchObject({
      fingerprint,
      identity: old.identity,
    });
    expect(result.steps['ask']?.attemptHistory?.map((a) => a.fingerprint)).toEqual([
      fingerprint,
      result.steps['ask']?.fingerprint,
    ]);
  },
);

it.each([
  ['prompt', { prompt: 'different' }],
  ['model', { model: 'different' }],
  ['tools', { tools: ['Read'] }],
  ['allowedTools', { allowedTools: ['Read'] }],
  ['cwd', { cwd: '..' }],
] as const)('names %s drift in a completed agent step', async (component, change) => {
  let args: ClaudeOptions = { prompt: 'same' };
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('ask', args);
    throw new Error('pause');
  });
  await expect(runWorkflow(definition, { ...options(), harness: { invoke } })).rejects.toThrow(
    'pause',
  );
  args = { ...args, ...change };
  await expect(
    runWorkflow(definition, { ...options(), harness: { invoke }, resume: true }),
  ).rejects.toThrow(`${component} changed on a completed step`);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('allows changing the kind and schema of unfinished work, but keeps completed schema checks', async () => {
  let local = true;
  let narrow = false;
  const definition = workflow(async (ctx) => {
    if (local)
      return ctx.step('ask', {
        input: null,
        schema: z.string(),
        run() {
          throw new Error('local');
        },
      });
    const result = await ctx.codex.object('ask', {
      prompt: 'new',
      schema: z.object({ answer: narrow ? z.literal('ok') : z.string() }),
    });
    if (!narrow) throw new Error('pause');
    return result.output.answer;
  });
  const harness: Harness = { invoke: () => Promise.resolve({ ...reply, text: '{"answer":"ok"}' }) };
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('local');
  local = false;
  await expect(runWorkflow(definition, { ...options(), harness, resume: true })).rejects.toThrow(
    'pause',
  );
  narrow = true;
  await expect(runWorkflow(definition, { ...options(), harness, resume: true })).rejects.toThrow(
    'schema changed on a completed step',
  );
  expect((await readRun(options())).steps['ask']?.redefinitions).toHaveLength(1);
});

it('supersedes a renamed failed step without rerunning downstream completed work', async () => {
  let name = 'review';
  let pause = true;
  const write = vi.fn(() => 'written');
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.claude.text(name, { prompt: 'review' });
    const result = await ctx.step('write', { input: null, schema: z.string(), run: write });
    if (pause) throw new Error('pause');
    return result;
  });
  const setup = { ...options(), harness: { invoke } };
  await expect(runWorkflow(definition, setup)).rejects.toThrow('timeout');
  name = 'review-again';
  await expect(runWorkflow(definition, { ...setup, resume: true })).rejects.toThrow('pause');
  pause = false;
  const events: string[] = [];
  const result = await runWorkflow(definition, {
    ...setup,
    resume: true,
    onEvent(e) {
      events.push(e.type);
    },
  });
  expect(result.steps['review']?.status).toBe('superseded');
  expect(result.steps['review']?.attemptHistory?.[0]?.error).toBe('timeout');
  expect(events).toContain('step.superseded');
  expect(write).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(2);
  await runWorkflow(definition, { ...setup, resume: true });
  expect(write).toHaveBeenCalledTimes(1);
});

it('requires model authorization for new rules, saves it, and leaves completed models untouched', async () => {
  let pause = true;
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('first'))
    .mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.codex.text('ask', { prompt: 'same', model: 'original', reasoningEffort: 'low' });
    if (pause) throw new Error('pause');
    return 'done';
  });
  const setup = { ...options(), harness: { invoke } };
  const policy: PolicyOverride[] = [{ model: 'replacement', reasoningEffort: 'high' }];
  await expect(runWorkflow(definition, { ...setup, policy })).rejects.toThrow('allowModelOverride');
  expect(invoke).not.toHaveBeenCalled();
  await expect(runWorkflow(definition, setup)).rejects.toThrow('first');
  await expect(
    runWorkflow(definition, { ...setup, resume: true, policy, allowModelOverride: true }),
  ).rejects.toThrow('pause');
  expect(invoke.mock.calls[1]?.[0].options).toMatchObject({
    model: 'replacement',
    reasoningEffort: 'high',
  });
  const attempt = (await readRun(options())).steps['ask']?.attemptHistory?.[1];
  expect(attempt).toMatchObject({
    requestedModel: 'replacement',
    reasoningEffort: 'high',
    sources: { model: 'override:0', reasoningEffort: 'override:0' },
  });
  pause = false;
  await runWorkflow(definition, { ...setup, resume: true });
  expect(invoke).toHaveBeenCalledTimes(2);
  const result = await runWorkflow(definition, {
    ...setup,
    resume: true,
    policy: [{ model: 'third' }],
    allowModelOverride: true,
  });
  expect(result.policy).toHaveLength(2);
  expect(result.steps['ask']?.attemptHistory?.[1]).toEqual(attempt);
  expect(invoke).toHaveBeenCalledTimes(2);
  await expect(
    runWorkflow(definition, { ...setup, resume: true, policy: [{ model: 'fourth' }] }),
  ).rejects.toThrow('allowModelOverride');
  const reset = await runWorkflow(definition, { ...setup, resume: true, policyReset: true });
  expect(reset.policy).toEqual([]);
  expect(reset.allowModelOverride).toBe(false);
});

it('applies ordered segment globs and kind filters, warns about unmatched rules, and resets saved rules', async () => {
  let pause = true;
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    for (const id of ['verify/skeptic-a', 'verify/deep/skeptic-b', 'other'])
      await ctx.claude.text(id, { prompt: id, timeoutMs: 20 });
    await ctx.step('local', { input: null, schema: z.null(), run: () => null });
    if (pause) throw new Error('pause');
    return 'done';
  });
  const policy: PolicyOverride[] = [
    { match: 'verify/**/skeptic-*', timeoutMs: 100 },
    { match: 'verify/*', timeoutMs: 200 },
    { kind: 'step', retry: { maxAttempts: 2, delayMs: 0 } },
    { match: 'missing.*', timeoutMs: 10 },
    { kind: 'codex', match: '**', timeoutMs: 9 },
  ];
  const setup = { ...options(), harness: { invoke } };
  await expect(runWorkflow(definition, { ...setup, policy })).rejects.toThrow('pause');
  expect(invoke.mock.calls.map(([request]) => request.options.timeoutMs)).toEqual([200, 100, 20]);
  const saved = await readRun(options());
  expect(saved.policyWarnings).toHaveLength(2);
  expect(saved.steps['local']?.attemptHistory?.[0]).toMatchObject({
    policy: { retry: { maxAttempts: 2, delayMs: 0 } },
    sources: { 'retry.maxAttempts': 'override:2' },
  });
  pause = false;
  const result = await runWorkflow(definition, { ...setup, resume: true });
  expect(result.warnings).toEqual(saved.policyWarnings);
  const reset = await runWorkflow(definition, {
    ...setup,
    resume: true,
    policyReset: true,
    policy: [{ match: 'other', timeoutMs: 30 }],
  });
  expect(reset.policy).toEqual([{ match: 'other', timeoutMs: 30 }]);
});

it.each([
  { timeoutMs: -1 },
  { timeoutMs: 2_147_483_648 },
  { maxTurns: 1.5 },
  { maxBudgetUsd: 0 },
  { retry: { maxAttempts: 0 } },
  { retry: { maxAttempts: 1, delayMs: -1 } },
  { match: '[' },
  { kind: 'sleep' },
  { kind: 'step', timeoutMs: 1 },
  { kind: 'codex', maxTurns: 1 },
  { kind: 'claude', reasoningEffort: 'high' },
  { tools: ['Bash'] },
  { model: 'x' },
  { reasoningEffort: 'high' },
])('rejects invalid or unauthorized policy %j before workflow effects', async (policy) => {
  const run = vi.fn(() => Promise.resolve('done'));
  await expect(
    runWorkflow(workflow(run), { ...options(), policy: [policy] as unknown as PolicyOverride[] }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await expect(readFile(join(stateDir, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports adapter defaults and preserves custom-harness unknowns', async () => {
  expect(new CliHarness().policyDefaults('claude')).toEqual({
    timeoutMs: 900_000,
    maxTurns: 25,
    maxBudgetUsd: 0.25,
    maxOutputBytes: 8 * 1024 * 1024,
    killGraceMs: 250,
    binary: 'claude',
  });
  expect(
    new CliHarness({
      codexBinary: '/fixture/codex',
      killGraceMs: 99,
      maxOutputBytes: 100,
    }).policyDefaults('codex'),
  ).toEqual({ timeoutMs: 900_000, maxOutputBytes: 100, killGraceMs: 99, binary: '/fixture/codex' });
  const result = await runWorkflow(
    workflow(async (ctx) => (await ctx.codex.text('ask', { prompt: 'x' })).output),
    { ...options(), harness: { invoke: () => Promise.resolve(reply) } },
  );
  expect(result.steps['ask']?.attemptHistory?.[0]).toMatchObject({
    policy: { retry: { maxAttempts: 1, delayMs: 100 } },
    requestedModel: null,
    reasoningEffort: null,
  });
  expect(result.steps['ask']?.attemptHistory?.[0]?.policy).not.toHaveProperty('timeoutMs');
});

it('uses saved policy for a still-unfinished call on bare resume, and reset restores call-site limits', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockRejectedValue(new Error('offline'));
  const definition = workflow(
    async (ctx) => (await ctx.codex.text('ask', { prompt: 'x', timeoutMs: 100 })).output,
  );
  const setup = { ...options(), harness: { invoke } };
  await expect(runWorkflow(definition, setup)).rejects.toThrow('offline');
  await expect(
    runWorkflow(definition, { ...setup, resume: true, policy: [{ timeoutMs: 500 }] }),
  ).rejects.toThrow('offline');
  await expect(runWorkflow(definition, { ...setup, resume: true })).rejects.toThrow('offline');
  invoke.mockResolvedValue(reply);
  const result = await runWorkflow(definition, { ...setup, resume: true, policyReset: true });
  expect(invoke.mock.calls.map(([request]) => request.options.timeoutMs)).toEqual([
    100, 500, 500, 100,
  ]);
  expect(
    result.steps['ask']?.attemptHistory?.map((attempt) => attempt.sources['timeoutMs']),
  ).toEqual(['call-site', 'override:0', 'override:0', 'call-site']);
});

it('does not include capability options with reserved component names in another component', async () => {
  let extra = 'first';
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('ask', { prompt: 'x', kind: extra } as ClaudeOptions);
    throw new Error('pause');
  });
  const setup = { ...options(), harness: { invoke } };
  await expect(runWorkflow(definition, setup)).rejects.toThrow('pause');
  extra = 'second';
  await expect(runWorkflow(definition, { ...setup, resume: true })).rejects.toThrow(
    'option.kind changed on a completed step',
  );
});

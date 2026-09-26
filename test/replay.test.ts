import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  checkResume,
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type Harness,
  type RunOptions,
  type WorkflowContext,
} from '../src/index.js';
import { lockRun } from '../src/workflow/runtime/store.js';

let stateDir: string;
const reply = {
  text: 'ok',
  sessionId: 'fixture',
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
const workflow = (run: (ctx: WorkflowContext, input: { n: number }) => Promise<string>) =>
  defineWorkflow({
    name: 'replay',
    version: '1',
    input: z.object({ n: z.number().default(1) }),
    output: z.string(),
    run,
  });
const options = (runId = 'source'): RunOptions => ({
  runId,
  stateDir,
  input: { n: 1 },
  fingerprint: 'code-1',
});
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-replay-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('forks the unchanged launch prefix, records differences/provenance, and never writes its source', async () => {
  let edited = false;
  const calls: string[] = [];
  const harness: Harness = {
    invoke(request) {
      calls.push(request.options.prompt);
      return Promise.resolve(reply);
    },
  };
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('plan', { prompt: 'plan' });
    await ctx.claude.text('review', { prompt: edited ? 'new review' : 'review' });
    return (await ctx.claude.text('write', { prompt: 'write' })).output;
  });
  await runWorkflow(definition, { ...options(), harness });
  const before = await readFile(join(stateDir, 'source.json'), 'utf8');
  calls.length = 0;
  edited = true;
  const events: string[] = [];
  const fork = await runWorkflow(
    { ...definition, version: '2' },
    {
      ...options('fork'),
      fingerprint: 'code-2',
      input: { n: 2 },
      harness,
      forkFrom: { runId: 'source' },
      onEvent(e) {
        events.push(e.type);
      },
    },
  );
  expect(calls).toEqual(['new review', 'write']);
  expect(events[0]).toBe('step.reused');
  expect(fork.steps['plan']?.reusedFrom).toMatchObject({ runId: 'source', stepId: 'plan' });
  expect(fork.steps['review']?.reusedFrom).toBeUndefined();
  expect(fork.forkedFrom).toMatchObject({
    reuse: 'prefix',
    invalidate: [],
    differences: ['version', 'code', 'input'],
    cursor: 1,
    reuseClosed: true,
  });
  expect(Object.values(fork.steps).map((step) => step.seq)).toEqual([1, 2, 3]);
  expect(await readFile(join(stateDir, 'source.json'), 'utf8')).toBe(before);
});

it('supports matching reuse and explicit invalidation globs, while prefix misses close reuse', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  let edited = false;
  const definition = workflow(async (ctx) => {
    for (const id of ['plan', 'review', 'write/report'])
      await ctx.codex.text(id, { prompt: id === 'review' && edited ? 'new' : id });
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  edited = true;
  invoke.mockClear();
  const matched = await runWorkflow(definition, {
    ...options('matching'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching' },
  });
  expect(invoke.mock.calls.map(([request]) => request.options.prompt)).toEqual(['new']);
  expect(matched.steps['write/report']?.reusedFrom?.runId).toBe('source');
  invoke.mockClear();
  const invalidated = await runWorkflow(definition, {
    ...options('invalidate'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching', invalidate: ['write/**'] },
  });
  expect(invoke.mock.calls.map(([request]) => request.options.prompt)).toEqual([
    'new',
    'write/report',
  ]);
  expect(invalidated.forkedFrom?.invalidate).toEqual(['write/**']);
  const skipped = workflow(
    async (ctx) => (await ctx.codex.text('write/report', { prompt: 'write/report' })).output,
  );
  invoke.mockClear();
  await runWorkflow(skipped, {
    ...options('skip-prefix'),
    harness: { invoke },
    forkFrom: { runId: 'source' },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('closes prefix reuse synchronously when concurrent launches encounter a miss', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  let edited = false;
  const definition = workflow(async (ctx) => {
    await ctx.map(['a', 'b', 'c'], 3, (id) =>
      ctx.claude.text(id, { prompt: edited && id === 'a' ? 'changed' : id }),
    );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  edited = true;
  invoke.mockClear();
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness: { invoke },
    forkFrom: { runId: 'source' },
  });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(Object.values(fork.steps).every((step) => step.reusedFrom === undefined)).toBe(true);
});

it.each(['failed', 'running'] as const)('never copies a %s source record', async (status) => {
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('source failed'))
    .mockResolvedValue(reply);
  const definition = workflow(async (ctx) => {
    await ctx.claude.text('a', { prompt: 'a' }).catch(() => undefined);
    return (await ctx.claude.text('b', { prompt: 'b' })).output;
  });
  await runWorkflow(definition, { ...options(), harness: { invoke } });
  const source = await readRun(options());
  const unfinished = source.steps['a'];
  if (!unfinished) throw new Error('missing fixture');
  unfinished.status = status;
  await writeFile(join(stateDir, 'source.json'), JSON.stringify(source));
  const before = await readFile(join(stateDir, 'source.json'), 'utf8');
  invoke.mockClear();
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness: { invoke },
    forkFrom: { runId: 'source', reuse: 'matching' },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(fork.steps['a']?.attempts).toBe(1);
  expect(fork.steps['a']?.reusedFrom).toBeUndefined();
  expect(fork.steps['b']?.reusedFrom).toBeDefined();
  expect(await readFile(join(stateDir, 'source.json'), 'utf8')).toBe(before);
});

it.each(['unchanged', 'changed', 'missing'] as const)(
  'resumes a fork against an %s pinned source',
  async (state) => {
    let pause = false;
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = workflow(async (ctx) => {
      await ctx.codex.text('a', { prompt: 'a' });
      if (pause) throw new Error('pause');
      return (await ctx.codex.text('b', { prompt: 'b' })).output;
    });
    const base = { ...options(), harness: { invoke } };
    await runWorkflow(definition, base);
    pause = true;
    invoke.mockClear();
    await expect(
      runWorkflow(definition, {
        ...base,
        runId: 'fork',
        input: undefined,
        forkFrom: { runId: 'source' },
      }),
    ).rejects.toThrow('pause');
    expect((await readRun({ stateDir, runId: 'fork' })).input).toEqual({ n: 1 });
    if (state === 'changed')
      await runWorkflow(definition, { ...base, resume: true, policyReset: true });
    if (state === 'missing') await rm(join(stateDir, 'source.json'));
    pause = false;
    const result = await runWorkflow(definition, { ...base, runId: 'fork', resume: true });
    expect(invoke).toHaveBeenCalledTimes(state === 'unchanged' ? 0 : 1);
    expect(result.steps['a']?.reusedFrom).toBeDefined();
    if (state !== 'unchanged')
      expect(result.warnings?.[0]).toContain('remaining effects will execute live');
  },
);

it('rejects an old format, different name, existing target, invalid flags, or invalid globs without touching the source', async () => {
  const definition = workflow(() => Promise.resolve('done'));
  await runWorkflow(definition, options());
  const path = join(stateDir, 'source.json');
  const before = await readFile(path, 'utf8');
  await expect(
    runWorkflow(
      { ...definition, name: 'different' },
      { ...options('other'), forkFrom: { runId: 'source' } },
    ),
  ).rejects.toThrow('name');
  await expect(
    runWorkflow(definition, { ...options(), forkFrom: { runId: 'source' } }),
  ).rejects.toThrow('already exists');
  await expect(
    runWorkflow(definition, { ...options('other'), resume: true, forkFrom: { runId: 'source' } }),
  ).rejects.toThrow('cannot be combined');
  await expect(
    runWorkflow(definition, { ...options('other'), acceptCodeChange: true }),
  ).rejects.toThrow('requires resume');
  await expect(
    runWorkflow(definition, {
      ...options('other'),
      forkFrom: { runId: 'source', invalidate: ['[invalid'] },
    }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(before);
  await writeFile(path, JSON.stringify({ ...(JSON.parse(before) as object), formatVersion: 2 }));
  const legacy = await readFile(path, 'utf8');
  await expect(
    runWorkflow(definition, { ...options('old-fork'), forkFrom: { runId: 'source' } }),
  ).rejects.toThrow('format version 2');
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
    'format version 2',
  );
  expect((await checkResume(definition, options())).compatible).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(legacy);
});

it('accepts a fix to an unfinished callback with both code-change and step-redefinition history', async () => {
  let callback = (): string => {
    throw new Error('bug');
  };
  const definition = workflow((ctx) =>
    ctx.step('local', { input: null, schema: z.string(), run: callback }),
  );
  await expect(runWorkflow(definition, options())).rejects.toThrow('bug');
  callback = () => 'fixed';
  await expect(
    runWorkflow(definition, { ...options(), resume: true, fingerprint: 'code-2' }),
  ).rejects.toThrow('code changed');
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(resumed.output).toBe('fixed');
  expect(resumed.codeChanges?.[0]).toMatchObject({ components: ['code'], files: [] });
  expect(resumed.steps['local']?.redefinitions).toHaveLength(1);
  expect(resumed.steps['local']?.attemptHistory).toHaveLength(2);
  await runWorkflow(definition, { ...options(), resume: true, fingerprint: 'code-2' });
});

it('rejects edited completed callbacks on accepted resume and runs them live in a fork', async () => {
  let callback = () => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  callback = () => 'two';
  await expect(
    runWorkflow(definition, {
      ...options(),
      resume: true,
      fingerprint: 'code-2',
      acceptCodeChange: true,
    }),
  ).rejects.toThrow('callback changed on a completed step');
  const forked = await runWorkflow(
    {
      ...definition,
      run: (ctx) => ctx.step('local', { input: null, schema: z.string(), run: callback }),
    },
    { ...options('fork'), forkFrom: { runId: 'source' } },
  );
  expect(forked.output).toBe('two');
  expect(forked.steps['local']?.reusedFrom).toBeUndefined();
});

it('honors local versions and revalidates candidates even when callback source cannot see captured values', async () => {
  let value = 'one';
  let version = '1';
  let allowOld = true;
  const callback = () => value;
  const definition = workflow((ctx) =>
    ctx.step('local', {
      input: null,
      version,
      schema: z.string().refine((x) => allowOld || x === value),
      run: callback,
    }),
  );
  await runWorkflow(definition, options());
  value = 'two';
  const unchanged = await runWorkflow(definition, {
    ...options('unchanged'),
    forkFrom: { runId: 'source' },
  });
  expect(unchanged.output).toBe('one'); // Captured state is intentionally not guessed by toString.
  allowOld = false;
  const invalid = await runWorkflow(definition, {
    ...options('invalid-result'),
    forkFrom: { runId: 'source' },
  });
  expect(invalid.output).toBe('two');
  expect(invalid.steps['local']?.reusedFrom).toBeUndefined();
  version = '2';
  const changed = await runWorkflow(definition, {
    ...options('versioned'),
    forkFrom: { runId: 'source' },
  });
  expect(changed.output).toBe('two');
  expect(changed.steps['local']?.reusedFrom).toBeUndefined();
});

it('re-finalizes an output-validation failure with no repeated effects and records schema changes', async () => {
  const effect = vi.fn(() => 'done');
  let broken = true;
  const definition = workflow(async (ctx) => {
    const value = await ctx.step('effect', { input: null, schema: z.string(), run: effect });
    return broken ? (undefined as unknown as string) : value;
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow();
  expect((await readRun(options())).recoveryHint).toContain('All recorded effects completed');
  broken = false;
  const changed = {
    ...definition,
    output: z.literal('done'),
    run: definition.run as (ctx: WorkflowContext, input: { n: number }) => Promise<'done'>,
  };
  const before = await checkResume(changed, { ...options(), fingerprint: 'code-2' });
  expect(before).toMatchObject({
    compatible: false,
    canAcceptCodeChange: true,
    refinalizable: true,
  });
  expect(before.message).toContain('zero repeated effects');
  const result = await runWorkflow(changed, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(result.output).toBe('done');
  expect(result.codeChanges?.[0]?.components).toEqual(['code', 'output schema']);
  expect(result.recoveryHint).toBeUndefined();
  expect(effect).toHaveBeenCalledTimes(1);
});

it('checks compatibility while a writer lock exists, itemizes changed files, and retains non-code gates', async () => {
  const run = vi.fn(() => Promise.resolve('done'));
  const definition = workflow(run);
  const source = { hash: 'old', files: { 'lib/report.ts': 'old', 'removed.ts': 'old' } };
  const setup = { runId: 'source', stateDir, input: { n: 1 }, source };
  await runWorkflow(definition, setup);
  const before = await readFile(join(stateDir, 'source.json'), 'utf8');
  const release = await lockRun(stateDir, 'source');
  try {
    const current = { hash: 'new', files: { 'lib/report.ts': 'new', 'added.ts': 'new' } };
    const report = await checkResume(definition, { ...setup, source: current });
    expect(report.files).toEqual(['added.ts', 'lib/report.ts', 'removed.ts']);
    expect(report.message).toContain('code (added.ts, lib/report.ts, removed.ts) changed');
    expect(report.unchanged).toContain('name');
    expect(
      (await checkResume(definition, { ...setup, source: current, acceptCodeChange: true }))
        .compatible,
    ).toBe(true);
    for (const next of [{ input: { n: 2 } }, { input: { n: 'bad' } }, { cwd: stateDir }]) {
      expect(
        (await checkResume(definition, { ...setup, ...next, acceptCodeChange: true }))
          .canAcceptCodeChange,
      ).toBe(false);
    }
    expect(
      (
        await checkResume(
          { ...definition, name: 'different' },
          { ...setup, acceptCodeChange: true },
        )
      ).compatible,
    ).toBe(false);
    expect(
      (await checkResume({ ...definition, version: '2' }, { ...setup, acceptCodeChange: true }))
        .compatible,
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(stateDir, 'source.json'), 'utf8')).toBe(before);
  } finally {
    await release();
  }
});

it.each([false, true])(
  'emits divergence before live work, with strictReplay=%s',
  async (strictReplay) => {
    let resumePath = false;
    const order: string[] = [];
    const first = () => 'saved';
    const definition = workflow(async (ctx) => {
      if (!resumePath) {
        await ctx.step('first', { input: null, schema: z.string(), run: first });
        throw new Error('pause');
      }
      await ctx.map(['live-a', 'live-b'], 2, (id) =>
        ctx.step(id, {
          input: null,
          schema: z.string(),
          run() {
            order.push(id);
            return 'live';
          },
        }),
      );
      return 'done';
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
    resumePath = true;
    await expect(
      runWorkflow(definition, {
        ...options(),
        resume: true,
        strictReplay,
        onEvent(event) {
          if (event.type === 'replay.divergence') {
            order.push('warning');
            expect(event.skippedStepIds).toEqual(['first']);
          }
        },
      }),
    ).rejects.toThrow(strictReplay ? 'Replay divergence' : 'skipped recorded steps');
    expect(order[0]).toBe('warning');
    expect(order).toHaveLength(strictReplay ? 1 : 3);
    const saved = await readRun(options());
    expect(saved.replayWarnings?.[0]).toContain('first');
    if (strictReplay) expect(saved.steps['live-a']).toBeUndefined();
  },
);

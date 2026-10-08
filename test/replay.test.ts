import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  checkResume,
  type RunRecord,
  type WorkflowEvent,
  ConfigurationError,
  defineWorkflow,
  FileRunStore,
  FixtureHarness,
  readRun,
  RunInterruptedError,
  runWorkflow,
  ReplaySkippedError,
  StepIdentityChangedError,
  WorkflowRunError,
  z,
  type Harness,
  type RunOptions,
  type WorkflowContext,
  writeAnswer,
} from '../src/index.js';
import { disposableRunCopy } from '../src/workflow/runtime/accepted-replay-preflight.js';
import { answerCandidates } from '../src/workflow/runtime/inbox.js';
import {
  findAcceptedReplayDivergence,
  findStepIdentityChange,
  ReplayDivergenceError,
} from '../src/workflow/runtime/run-errors.js';
import type * as images from '../src/workflow/runtime/images.js';
import { digest } from '../src/workflow/runtime/json.js';
import { hasTerminalOutcomes, lockRun } from '../src/workflow/runtime/store.js';

// A gate on Codex image snapshots: the only await an agent call makes before its effect starts.
const preparation = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('../src/workflow/runtime/images.js', async (importOriginal) => {
  const original = await importOriginal<typeof images>();
  return {
    ...original,
    snapshotImages: async (...args: Parameters<typeof original.snapshotImages>) => {
      await preparation.gate;
      return original.snapshotImages(...args);
    },
  };
});

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
  preparation.gate = undefined;
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
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
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
  expect(events.slice(0, 2)).toEqual(['run.started', 'step.reused']);
  expect(fork.steps['plan']?.reusedFrom).toMatchObject({ runId: 'source', stepId: 'plan' });
  expect(fork.steps['review']?.reusedFrom).toBeUndefined();
  expect(fork.forkedFrom).toMatchObject({
    reuse: 'prefix',
    invalidate: [],
    differences: ['version', 'code', 'input'],
    cursor: 1,
    // A miss no longer closes reuse for the whole fork; `write` ran live because `review` did.
    reuseClosed: false,
  });
  expect(Object.values(fork.steps).map((step) => step.seq)).toEqual([1, 2, 3]);
  expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
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

it('keeps same-tick concurrent siblings reusable after a prefix miss', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  let edited = false;
  const definition = workflow(async (ctx) => {
    // Unscoped concurrent root effects, not a named map: named-map items are declared independent.
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        ctx.claude.text(id, { prompt: edited && id === 'a' ? 'changed' : id }),
      ),
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
  // b and c launched before a settled in the source, so a's miss is not their cause.
  expect(invoke.mock.calls.map(([request]) => request.options.prompt)).toEqual(['changed']);
  expect(fork.steps['a']?.reusedFrom).toBeUndefined();
  expect(fork.steps['b']?.reusedFrom).toBeDefined();
  expect(fork.steps['c']?.reusedFrom).toBeDefined();
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
  await writeFile(join(stateDir, 'source', 'run.json'), JSON.stringify(source));
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
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
  expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
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
    if (state === 'missing') await rm(join(stateDir, 'source', 'run.json'));
    pause = false;
    const result = await runWorkflow(definition, { ...base, runId: 'fork', resume: true });
    expect(invoke).toHaveBeenCalledTimes(state === 'unchanged' ? 0 : 1);
    expect(result.steps['a']?.reusedFrom).toBeDefined();
    if (state !== 'unchanged')
      expect(result.warnings?.[0]).toContain('remaining effects will execute live');
  },
);

/** A fixture harness with 0-4 ms of random latency, recording every live step ID. */
function delayedFixture(fail: (stepId: string) => boolean = () => false) {
  const fixture = new FixtureHarness({ version: 1, calls: [{ step: '**', text: 'ok' }] });
  const live: string[] = [];
  const harness: Harness = {
    async invoke(request, invocation) {
      live.push(request.call.stepId);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
      if (fail(request.call.stepId)) throw new Error(`${request.call.stepId} failed`);
      return fixture.invoke(request, invocation);
    },
  };
  return { harness, live };
}
const reusedIds = (record: RunRecord): string[] =>
  Object.entries(record.steps)
    .filter(([, step]) => step.reusedFrom !== undefined)
    .map(([id]) => id)
    .sort();
const mapItems = Array.from({ length: 12 }, (_, index) => `item ${String(index)}`);
/** A 12x3 named map at concurrency 6, optionally followed by a root step over its results. */
function reviewMap(state: { edited?: boolean; pause?: boolean; summary?: boolean }) {
  return workflow(async (ctx) => {
    const results = await ctx.map('review', mapItems, { concurrency: 6 }, async (item, index) => {
      if (state.pause && index >= 6) throw new Error('pause');
      const s1 = await ctx.claude.text('s1', { prompt: `s1 ${item}` });
      const s2 = await ctx.claude.text('s2', { prompt: `s2 ${s1.output}` });
      return (
        await ctx.claude.text('s3', { prompt: `s3${state.edited ? ' v2' : ''} ${s2.output}` })
      ).output;
    });
    if (state.summary)
      await ctx.step('summary', { input: results, schema: z.number(), run: () => results.length });
    return 'done';
  });
}
const stageIds = (stages: string[], indexes = mapItems.map((_, index) => index)) =>
  indexes.flatMap((index) => stages.map((stage) => `review/${String(index)}/${stage}`)).sort();

// measured: 1.6-1.9 s alone, 3.0 s in a full coverage run (load average 11 on 16 cores); a sequential
// loop passed the 5 s default at iteration 15 under the gate. CI: 3.9 s on Node 26, 6.7 s on Node 24
// with coverage, and 11.7 s on the Node 22.13 leg, which flaked the old 10 s value on main and on
// #309. CPU-bound: 40 runs saving per step.
it('reuses every step of an unchanged concurrent named map whatever the source schedule', async () => {
  const definition = reviewMap({});
  // Twenty independent source/fork pairs, run side by side: each source gets its own schedule.
  const forks = await Promise.all(
    Array.from({ length: 20 }, async (_, iteration) => {
      const { harness, live } = delayedFixture();
      const sourceId = `source-${String(iteration)}`;
      await runWorkflow(definition, { ...options(sourceId), harness });
      live.length = 0;
      const fork = await runWorkflow(definition, {
        ...options(`fork-${String(iteration)}`),
        harness,
        forkFrom: { runId: sourceId },
      });
      return { fork, live };
    }),
  );
  for (const { fork, live } of forks) {
    expect(live).toEqual([]);
    expect(reusedIds(fork)).toEqual(stageIds(['s1', 's2', 's3']));
    expect(fork.forkedFrom).toMatchObject({ cursor: 36, reuseClosed: false });
  }
}, 30_000);

it('re-runs only the edited stage of a named map, and a root step after the map', async () => {
  const { harness, live } = delayedFixture();
  const state = { edited: false, summary: true };
  const definition = reviewMap(state);
  await runWorkflow(definition, { ...options(), harness });
  const source = await readRun(options());
  live.length = 0;
  state.edited = true;
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  expect(live.sort()).toEqual(stageIds(['s3']));
  expect(reusedIds(fork)).toEqual(stageIds(['s1', 's2']));
  // The summary's input is unchanged, but it was launched after the edited stage settled.
  expect(fork.steps['summary']?.fingerprint).toBe(source.steps['summary']?.fingerprint);
  expect(fork.steps['summary']?.reusedFrom).toBeUndefined();
  expect(fork.steps['summary']?.status).toBe('completed');
});

it.each([
  ['a failed implementer', false],
  ['a completed implementer and a later check', true],
])(
  'reuses an independent same-tick side effect after invalidating %s',
  async (_name, completed) => {
    let followups = 0;
    let checks = 0;
    const source = delayedFixture((stepId) => !completed && stepId === 'fix/1/impl');
    const definition = workflow(async (ctx) => {
      for (const id of ['load', 'plan', 'branch', 'context', 'tests', 'prompt'])
        await ctx.step(id, { input: null, schema: z.string(), run: () => id });
      await Promise.all([
        ctx.claude.text('fix/1/impl', { prompt: 'implement' }),
        ctx.step('fix/1/followups', { input: null, schema: z.number(), run: () => ++followups }),
      ]);
      await ctx.step('fix/1/check', { input: null, schema: z.number(), run: () => ++checks });
      return 'done';
    });
    if (completed) await runWorkflow(definition, { ...options(), harness: source.harness });
    else
      await expect(
        runWorkflow(definition, { ...options(), harness: source.harness }),
      ).rejects.toThrow(WorkflowRunError);
    expect(followups).toBe(1);
    const { harness, live } = delayedFixture();
    const fork = await runWorkflow(definition, {
      ...options('fork'),
      harness,
      forkFrom: { runId: 'source', invalidate: ['fix/1/impl*'] },
    });
    expect(live).toEqual(['fix/1/impl']);
    expect(followups).toBe(1);
    expect(fork.steps['fix/1/followups']?.reusedFrom).toMatchObject({
      runId: 'source',
      stepId: 'fix/1/followups',
    });
    expect(fork.steps['fix/1/impl']?.reusedFrom).toBeUndefined();
    // The check was launched after the implementer settled in the source: a real dependent.
    expect(fork.steps['fix/1/check']?.reusedFrom).toBeUndefined();
    expect(checks).toBe(completed ? 2 : 1);
    expect(reusedIds(fork)).toEqual(
      ['branch', 'context', 'fix/1/followups', 'load', 'plan', 'prompt', 'tests'].sort(),
    );
  },
);

it('treats sibling items of nested named maps as independent, through a within view', async () => {
  const { harness, live } = delayedFixture();
  let edited = false;
  // Sequential items, so each later item's first stage launches after an earlier item's edit.
  const definition = workflow(async (ctx) => {
    await ctx.map('outer', ['a', 'b'], { concurrency: 1, key: (key) => key }, (outer) =>
      ctx.map('inner', ['x', 'y'], { concurrency: 1, key: (key) => key }, async (inner) => {
        const view = ctx.within('w');
        await view.claude.text('s1', { prompt: `${outer}${inner}` });
        return (await view.claude.text('s2', { prompt: edited ? 'changed' : 's2' })).output;
      }),
    );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness });
  live.length = 0;
  edited = true;
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  const leaves = (stage: string) =>
    ['a/inner/x', 'a/inner/y', 'b/inner/x', 'b/inner/y'].map((item) => `outer/${item}/w/${stage}`);
  expect(live).toEqual(leaves('s2'));
  expect(reusedIds(fork)).toEqual(leaves('s1'));
});

/** A sequential named map keyed by its items, followed by a root step over its results. */
function keyedReview(state: { keys: string[] }) {
  return workflow(async (ctx) => {
    const results = await ctx.map(
      'review',
      state.keys,
      { concurrency: 1, key: (key) => key },
      async (key) => {
        const s1 = await ctx.claude.text('s1', { prompt: `s1 ${key}` });
        return (await ctx.claude.text('s2', { prompt: `s2 ${s1.output}` })).output;
      },
    );
    await ctx.step('summary', { input: results, schema: z.number(), run: () => results.length });
    return 'done';
  });
}

it('reuses surviving named-map items after a fork drops a key, and runs the root step live', async () => {
  const { harness, live } = delayedFixture();
  const state = { keys: ['a', 'gone/x', 'b'] };
  const definition = keyedReview(state);
  await runWorkflow(definition, { ...options(), harness });
  const source = await readRun(options());
  // Each step records its exact item prefix and its invocation's prefix, ordinal and key-set digest.
  const invocation = digest(['review/', '0', 'review/a/', 'review/b/', 'review/gone/x/']);
  expect(source.steps['review/b/s1']?.mapItems).toEqual([{ item: 'review/b/', invocation }]);
  expect(source.steps['review/gone/x/s1']?.mapItems).toEqual([
    { item: 'review/gone/x/', invocation },
  ]);
  expect(source.steps['summary']).not.toHaveProperty('mapItems');
  live.length = 0;
  // The source ran 'gone/x' between 'a' and 'b', so 'b' launched after its steps settled.
  state.keys = ['a', 'b'];
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  expect(live).toEqual([]);
  expect(reusedIds(fork)).toEqual(['review/a/s1', 'review/a/s2', 'review/b/s1', 'review/b/s2']);
  expect(fork.forkedFrom).toMatchObject({ cursor: 4, reuseClosed: false });
  // The removed key's steps are possible causes of a step outside the map.
  expect(fork.steps['summary']?.reusedFrom).toBeUndefined();
  expect(fork.steps['summary']?.status).toBe('completed');
  // Reused copies carry this run's own invocation, not the source's.
  expect(fork.steps['review/b/s1']?.mapItems).toEqual([
    { item: 'review/b/', invocation: digest(['review/', '0', 'review/a/', 'review/b/']) },
  ]);
  // A fork of the fork that also drops 'a' still reuses 'b'.
  state.keys = ['b'];
  const again = await runWorkflow(definition, {
    ...options('fork-again'),
    harness,
    forkFrom: { runId: 'fork' },
  });
  expect(live).toEqual([]);
  expect(reusedIds(again)).toEqual(['review/b/s1', 'review/b/s2']);
  expect(again.steps['summary']?.reusedFrom).toBeUndefined();
});

it('does not treat another invocation of the same map ID as a sibling of a dropped key', async () => {
  const { harness, live } = delayedFixture();
  const state = { first: ['r1-a', 'r1-gone'] };
  const definition = workflow(async (ctx) => {
    for (const keys of [state.first, ['r2-a', 'r2-b']])
      await ctx.map('review', keys, { concurrency: 1, key: (key) => key }, (key) =>
        ctx.claude.text('s', { prompt: key }),
      );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness });
  live.length = 0;
  state.first = ['r1-a'];
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  // Round 2 launched after the dropped round-1 item settled, in another invocation.
  expect(live).toEqual(['review/r2-a/s', 'review/r2-b/s']);
  expect(reusedIds(fork)).toEqual(['review/r1-a/s']);
});

it('does not treat a later invocation of the same map ID with the same keys as a sibling', async () => {
  const { harness, live } = delayedFixture();
  const state = { keys: ['a', 'gone', 'b'] };
  const definition = workflow(async (ctx) => {
    for (const round of [1, 2])
      await ctx.map('review', state.keys, { concurrency: 1, key: (key) => key }, (key) =>
        ctx.claude.text(`r${String(round)}`, { prompt: `${key} round ${String(round)}` }),
      );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness });
  const source = await readRun(options());
  // Same keys in both rounds, but each round is its own invocation.
  const items = ['review/a/', 'review/b/', 'review/gone/'];
  expect(source.steps['review/a/r1']?.mapItems).toEqual([
    { item: 'review/a/', invocation: digest(['review/', '0', ...items]) },
  ]);
  expect(source.steps['review/a/r2']?.mapItems).toEqual([
    { item: 'review/a/', invocation: digest(['review/', '1', ...items]) },
  ]);
  live.length = 0;
  state.keys = ['a', 'b'];
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  // Round 2 launched after the dropped round-1 item settled, so it may depend on it.
  expect(live).toEqual(['review/a/r2', 'review/b/r2']);
  expect(reusedIds(fork)).toEqual(['review/a/r1', 'review/b/r1']);
});

it('does not treat a map at another prefix with the same item prefixes as a sibling', async () => {
  const { harness, live } = delayedFixture();
  const state = { first: true, keys: ['a', 'b'] };
  const definition = workflow(async (ctx) => {
    // `review` with slash keys spells the same item prefixes as the map at `review/group/`.
    if (state.first)
      await ctx.map(
        'review',
        ['group/a', 'group/b'],
        { concurrency: 1, key: (key) => key },
        (key) =>
          key === 'group/a' ? ctx.claude.text('s1', { prompt: key }) : Promise.resolve(null),
      );
    await ctx
      .within('review')
      .map('group', state.keys, { concurrency: 1, key: (key) => key }, (key) =>
        ctx.claude.text('s2', { prompt: key }),
      );
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness });
  const source = await readRun(options());
  const items = ['review/group/a/', 'review/group/b/'];
  expect(source.steps['review/group/a/s1']?.mapItems).toEqual([
    { item: 'review/group/a/', invocation: digest(['review/', '0', ...items]) },
  ]);
  expect(source.steps['review/group/b/s2']?.mapItems).toEqual([
    { item: 'review/group/b/', invocation: digest(['review/group/', '0', ...items]) },
  ]);
  live.length = 0;
  state.first = false;
  state.keys = ['b'];
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  // The second map launched after the first map's dropped step settled, so it may depend on it.
  expect(live).toEqual(['review/group/b/s2']);
  expect(reusedIds(fork)).toEqual([]);
});

it('does not match an invocation numbered after a skipped settled item to an earlier one', async () => {
  const state = { outer: true, fail: true, keys: ['a', 'b'] };
  const { harness, live } = delayedFixture((id) => state.fail && id === 'w/inner/b/s2');
  const definition = workflow(async (ctx) => {
    const view = ctx.within('w');
    if (state.outer)
      await ctx.map('outer', ['k'], { concurrency: 1, onError: 'return' }, async () => {
        // Through the root view, the nested map runs at `w/inner/`, outside the item's prefix.
        await view.map('inner', ['a', 'b'], { concurrency: 1, key: (key) => key }, (key) =>
          key === 'a' ? ctx.claude.text('s1', { prompt: key }) : Promise.resolve(null),
        );
        return 'ok';
      });
    await view.map('inner', state.keys, { concurrency: 1, key: (key) => key }, (key) =>
      key === 'b' ? ctx.claude.text('s2', { prompt: key }) : Promise.resolve(null),
    );
    return 'done';
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow(
    WorkflowRunError,
  );
  // The resume skips the committed item, so it never counts the item's `w/inner/` invocation.
  state.fail = false;
  await runWorkflow(definition, { ...options(), harness, resume: true });
  const source = await readRun(options());
  expect(source.status).toBe('completed');
  const first = digest(['w/inner/', '0', 'w/inner/a/', 'w/inner/b/']);
  expect(source.steps['w/inner/a/s1']?.mapItems).toEqual([
    { item: 'w/inner/a/', invocation: first },
  ]);
  const healed = source.steps['w/inner/b/s2']?.mapItems;
  expect(healed).toHaveLength(1);
  expect(healed?.[0]?.item).toBe('w/inner/b/');
  expect(healed?.[0]?.invocation).not.toBe(first);
  live.length = 0;
  state.outer = false;
  state.keys = ['b'];
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  // The healed step launched after the dropped first invocation's step settled.
  expect(live).toEqual(['w/inner/b/s2']);
  expect(reusedIds(fork)).toEqual([]);
});

it('records the enclosing named-map item on a wait launched inside it', async () => {
  const ready = (id: string) =>
    ({
      timeoutMs: 60_000,
      poll: {
        input: id,
        schema: z.boolean(),
        every: 1_000,
        observe: () => Promise.resolve({ done: true as const, value: true }),
      },
    }) as const;
  const definition = workflow(async (ctx) => {
    await ctx.map('gate', ['a'], { concurrency: 1, key: (key) => key }, () =>
      ctx.wait('ready', ready('inside')),
    );
    await ctx.wait('outside', ready('outside'));
    return 'done';
  });
  await runWorkflow(definition, options());
  const record = await readRun(options());
  expect(record.steps['gate/a/ready']).toMatchObject({
    kind: 'wait',
    status: 'completed',
    mapItems: [{ item: 'gate/a/', invocation: digest(['gate/', '0', 'gate/a/']) }],
  });
  expect(record.steps['outside']).not.toHaveProperty('mapItems');
});

it('re-runs a sequential chain from its changed step', async () => {
  const { harness, live } = delayedFixture();
  let edited = false;
  const definition = workflow(async (ctx) => {
    for (const id of ['a1', 'a2', 'a3', 'a4'])
      await ctx.claude.text(id, { prompt: edited && id === 'a2' ? 'changed' : id });
    return 'done';
  });
  await runWorkflow(definition, { ...options(), harness });
  live.length = 0;
  edited = true;
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    harness,
    forkFrom: { runId: 'source' },
  });
  expect(live).toEqual(['a2', 'a3', 'a4']);
  expect(reusedIds(fork)).toEqual(['a1']);
});

it.each(['current', 'legacy open', 'legacy closed'] as const)(
  'keeps reuse progress when a %s fork target resumes',
  async (provenance) => {
    const { harness, live } = delayedFixture();
    const state = { edited: false, pause: false };
    const definition = reviewMap(state);
    await runWorkflow(definition, { ...options(), harness });
    live.length = 0;
    state.edited = true;
    state.pause = true;
    await expect(
      runWorkflow(definition, { ...options('fork'), harness, forkFrom: { runId: 'source' } }),
    ).rejects.toThrow('pause');
    const first = [...live];
    expect(first.sort()).toEqual(stageIds(['s3'], [0, 1, 2, 3, 4, 5]));
    if (provenance !== 'current') {
      // A record saved by an older build: cursor was a launch-order position.
      const saved = await readRun(options('fork'));
      if (!saved.forkedFrom) throw new Error('missing provenance');
      saved.forkedFrom.cursor = 1;
      saved.forkedFrom.reuseClosed = provenance === 'legacy closed';
      await writeFile(join(stateDir, 'fork', 'run.json'), JSON.stringify(saved));
    }
    state.pause = false;
    live.length = 0;
    const resumed = await runWorkflow(definition, {
      ...options('fork'),
      harness,
      resume: true,
    });
    const rest = [6, 7, 8, 9, 10, 11];
    expect(resumed.status).toBe('completed');
    if (provenance === 'legacy closed') {
      expect(live.sort()).toEqual(stageIds(['s1', 's2', 's3'], rest));
      expect(reusedIds(resumed)).toEqual(stageIds(['s1', 's2'], [0, 1, 2, 3, 4, 5]));
      expect(resumed.warnings ?? []).toEqual([]);
    } else {
      expect(live.sort()).toEqual(stageIds(['s3'], rest));
      expect(reusedIds(resumed)).toEqual(stageIds(['s1', 's2']));
    }
  },
);

it('rejects an old format, different name, existing target, invalid flags, or invalid globs without touching the source', async () => {
  const definition = workflow(() => Promise.resolve('done'));
  await runWorkflow(definition, options());
  const path = join(stateDir, 'source', 'run.json');
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
  await rm(join(stateDir, 'source'), { recursive: true });
  const legacyPath = join(stateDir, 'source.json');
  for (const formatVersion of [1, 2, 3, 4, 5]) {
    await writeFile(
      legacyPath,
      JSON.stringify({ ...(JSON.parse(before) as object), formatVersion }),
    );
    const legacy = await readFile(legacyPath, 'utf8');
    expect((await readRun(options())).formatVersion).toBe(formatVersion);
    await expect(
      runWorkflow(definition, { ...options('old-fork'), forkFrom: { runId: 'source' } }),
    ).rejects.toThrow(`format version ${String(formatVersion)}`);
    await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow(
      `format version ${String(formatVersion)}`,
    );
    expect((await checkResume(definition, options())).compatible).toBe(false);
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
  }
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
  const reaccepted = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(reaccepted.codeChanges).toHaveLength(1);
});

it('rejects edited completed callbacks on accepted resume and runs them live in a fork', async () => {
  let callback = () => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  callback = () => 'two';
  const rejected = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  }).catch((error: unknown) => error);
  // The preflight refuses before the run changes, with the typed error itself (#215).
  expect(rejected).toBeInstanceOf(StepIdentityChangedError);
  expect(rejected).not.toBeInstanceOf(WorkflowRunError);
  expect((rejected as Error).message).toContain('callback changed on a completed step');
  expect((rejected as Error).message).toContain(
    '--fork-from RUN --reuse matching --invalidate local',
  );
  const change = findStepIdentityChange(rejected);
  expect(change).toBe(rejected);
  expect(change).toMatchObject({ stepId: 'local', components: ['callback'], status: 'completed' });
  expect(findStepIdentityChange(new AggregateError([new Error('x'), change]))).toBe(change);
  expect(findStepIdentityChange(new Error('plain'))).toBeUndefined();
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

/** Every checkpoint file of a run, by name, so a refusal can prove it wrote nothing. */
async function runFiles(runId: string): Promise<Record<string, string>> {
  const directory = join(stateDir, runId);
  const names = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name.slice(directory.length + 1),
        await readFile(name, 'utf8'),
      ]),
    ),
  );
}

/** Resume `definition` with an accepted code change and return what it rejected with. */
async function acceptedRejection(
  definition: ReturnType<typeof workflow>,
  extra: Partial<RunOptions> = {},
): Promise<unknown> {
  return runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
    ...extra,
  }).then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

/**
 * The rejection is the preflight's bare refusal, and the record and lock are as they were. A
 * `kind` in `change` expects a skip ({@link ReplaySkippedError}), otherwise an identity change.
 */
async function expectUnchanged(
  rejected: unknown,
  before: { readonly record: RunRecord; readonly files: Record<string, string> },
  change:
    | Pick<StepIdentityChangedError, 'stepId' | 'components' | 'status'>
    | Pick<ReplaySkippedError, 'kind' | 'skipped' | 'healed'>,
): Promise<void> {
  const type = 'kind' in change ? ReplaySkippedError : StepIdentityChangedError;
  expect(rejected).toBeInstanceOf(type);
  expect(rejected).not.toBeInstanceOf(WorkflowRunError);
  expect(rejected).toMatchObject(change);
  expect(findAcceptedReplayDivergence(rejected)).toBe(rejected);
  expect((rejected as Error).cause).toBeInstanceOf(type);
  expect((rejected as Error).message).toContain('refused before run source was changed');
  const after = await readRun(options());
  expect(after.status).toBe(before.record.status);
  expect(after.workflow.fingerprint).toBe(before.record.workflow.fingerprint);
  expect(after.output).toEqual(before.record.output);
  expect(after.codeChanges).toEqual(before.record.codeChanges);
  expect(await runFiles('source')).toEqual(before.files);
  // The writer lock was released: another owner can take it at once.
  const release = await lockRun(stateDir, 'source');
  await release();
}

it('refuses an embedded accepted resume over an edited completed callback without changing a completed run', async () => {
  let ran = 0;
  let callback = (): string => {
    ran++;
    return 'one';
  };
  const definition = workflow((ctx) =>
    ctx.step('local', { input: null, schema: z.string(), run: callback }),
  );
  expect((await runWorkflow(definition, options())).output).toBe('one');
  const before = { record: await readRun(options()), files: await runFiles('source') };
  callback = () => {
    ran++;
    return 'two';
  };
  await expectUnchanged(await acceptedRejection(definition), before, {
    stepId: 'local',
    components: ['callback'],
    status: 'completed',
  });
  expect(ran).toBe(1);
  // The saved output is still served to a plain resume of the original code.
  const kept = await runWorkflow(definition, { ...options(), resume: true });
  expect(kept.output).toBe('one');
  expect(ran).toBe(1);
});

it('refuses an embedded accepted resume without changing a failed run', async () => {
  let callback = (): string => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const before = { record: await readRun(options()), files: await runFiles('source') };
  expect(before.record.status).toBe('failed');
  callback = () => 'two';
  await expectUnchanged(await acceptedRejection(definition), before, {
    stepId: 'local',
    components: ['callback'],
    status: 'completed',
  });
});

it('refuses an embedded accepted resume without changing a suspended run or its waiting question', async () => {
  let callback = (): string => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    return ctx.ask('q', { prompt: 'Text?', schema: z.string() });
  });
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const before = { record: await readRun(options()), files: await runFiles('source') };
  callback = () => 'two';
  await expectUnchanged(await acceptedRejection(definition), before, {
    stepId: 'local',
    components: ['callback'],
    status: 'completed',
  });
  const after = await readRun(options());
  expect(after.status).toBe('suspended');
  expect(after.steps['q']?.status).toBe('waiting');
});

// #217: the preflight's copy holds the run's pending deliveries, so it consumes a delivered but
// unconsumed answer as the real run would and reaches the changed step or the end of the body.
it.each([
  {
    edit: 'moves an edited completed step after it',
    change: { stepId: 's', components: ['callback'], status: 'completed' },
  },
  {
    edit: 'drops a completed step before it',
    change: { kind: 'steps', skipped: ['early'], healed: [] },
  },
] as const)(
  'refuses an accepted resume over a delivered answer that $edit, leaving the delivery',
  async ({ change }) => {
    let edited = false;
    let ran = 0;
    let callback = (): string => {
      ran++;
      return 'one';
    };
    const skips = 'kind' in change;
    const definition = workflow(async (ctx) => {
      if (!(edited && skips))
        await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
      if (!(edited && !skips))
        await ctx.step('s', { input: null, schema: z.string(), run: callback });
      const answer = await ctx.ask('q', { prompt: 'Text?', schema: z.string() });
      if (edited && !skips) await ctx.step('s', { input: null, schema: z.string(), run: callback });
      return answer;
    });
    expect((await runWorkflow(definition, options())).status).toBe('suspended');
    const delivery = await writeAnswer({ stateDir, runId: 'source', stepId: 'q', value: 'yes' });
    const before = { record: await readRun(options()), files: await runFiles('source') };
    edited = true;
    if (!skips)
      callback = () => {
        ran++;
        return 'two';
      };
    await expectUnchanged(await acceptedRejection(definition), before, change);
    // The preflight consumed its own copy; the source delivery waits for the real run.
    expect(await readFile(delivery.path, 'utf8')).toBe(
      before.files[delivery.path.slice(join(stateDir, 'source').length + 1)],
    );
    expect(ran).toBe(1);
    const after = await readRun(options());
    expect(after.status).toBe('suspended');
    expect(after.steps['q']?.status).toBe('waiting');
  },
);

it('re-finalizes a tail-only fix over a delivered answer, consuming the source delivery', async () => {
  let ran = 0;
  let tail = (answer: string): string => answer;
  const definition = workflow(async (ctx) => {
    await ctx.step('s', {
      input: null,
      schema: z.string(),
      run: () => {
        ran++;
        return 's';
      },
    });
    return tail(await ctx.ask('q', { prompt: 'Text?', schema: z.string() }));
  });
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const delivery = await writeAnswer({ stateDir, runId: 'source', stepId: 'q', value: 'yes' });
  tail = (answer) => `${answer}!`;
  const result = await runWorkflow(definition, {
    ...options(),
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(result).toMatchObject({ status: 'completed', output: 'yes!' });
  expect(result.steps['q']).toMatchObject({ status: 'completed', output: 'yes' });
  expect(result.codeChanges).toHaveLength(1);
  expect(ran).toBe(1);
  // The real run consumed the source delivery, which stays as its audit file.
  expect(JSON.parse(await readFile(delivery.path, 'utf8'))).toMatchObject({ value: 'yes' });
});

it('copies the first pending delivery from either inbox layout and never a rejected one', async () => {
  const definition = workflow((ctx) => ctx.ask('q', { prompt: 'Text?', schema: z.string() }));
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const delivery = await writeAnswer({ stateDir, runId: 'source', stepId: 'q', value: 'yes' });
  const candidates = answerCandidates(stateDir, 'source', 'q');
  expect(candidates[0]).toBe(delivery.path);
  // Move the delivery into the legacy flat inbox under its format-6 name, the last candidate.
  const flat = candidates.at(-1) ?? '';
  expect(flat).toContain('source.inbox');
  await mkdir(dirname(flat), { recursive: true });
  await rename(delivery.path, flat);
  await writeFile(`${flat}.rejected.0.json`, 'rejected');
  await writeFile(`${delivery.path}.rejected.1.json`, 'rejected');
  const record = await readRun(options());
  const copied = async (): Promise<Record<string, string>> => {
    const copy = await disposableRunCopy(record, stateDir);
    try {
      const names = (await readdir(copy.stateDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.includes('.answer.json'))
        .map((entry) => join(entry.parentPath, entry.name));
      return Object.fromEntries(
        await Promise.all(
          names.map(async (name): Promise<[string, string]> => [
            relative(copy.stateDir, name),
            await readFile(name, 'utf8'),
          ]),
        ),
      );
    } finally {
      await copy.dispose();
    }
  };
  const flatText = await readFile(flat, 'utf8');
  expect(await copied()).toEqual({ [relative(stateDir, flat)]: flatText });
  // With deliveries in both layouts, only the one the question reads first is copied.
  await writeFile(delivery.path, 'first');
  expect(await copied()).toEqual({ [relative(stateDir, delivery.path)]: 'first' });
  // The source deliveries are untouched.
  expect(await readFile(flat, 'utf8')).toBe(flatText);
  expect(await readFile(delivery.path, 'utf8')).toBe('first');
});

it('refuses an embedded accepted resume through a bound store without writing to it', async () => {
  class CountingStore extends FileRunStore {
    public opened = 0;
    public override open(
      ...args: Parameters<FileRunStore['open']>
    ): ReturnType<FileRunStore['open']> {
      this.opened++;
      return super.open(...args);
    }
  }
  let callback = (): string => 'one';
  const definition = workflow(async (ctx) => {
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const before = { record: await readRun(options()), files: await runFiles('source') };
  callback = () => 'two';
  const store = new CountingStore(stateDir);
  await expectUnchanged(await acceptedRejection(definition, { store }), before, {
    stepId: 'local',
    components: ['callback'],
    status: 'completed',
  });
  // Only the real run opened the store; the preflight copy lives in its own directory.
  expect(store.opened).toBe(1);
});

it.each([
  { status: 'completed', failing: false },
  { status: 'failed', failing: true },
] as const)(
  'refuses an embedded accepted resume that skips a completed step without changing a $status run',
  async ({ status, failing }) => {
    let early = true;
    let tail = failing;
    const definition = workflow(async (ctx) => {
      if (early) await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
      const shared = await ctx.step('shared', { input: null, schema: z.string(), run: () => 's' });
      if (tail) throw new Error('tail');
      return shared;
    });
    await runWorkflow(definition, options()).catch(() => undefined);
    const before = { record: await readRun(options()), files: await runFiles('source') };
    expect(before.record.status).toBe(status);
    // The accepted edit fixes the tail and drops the completed call, so replay would fail only at
    // the end of the body.
    early = false;
    tail = false;
    const rejected = await acceptedRejection(definition);
    await expectUnchanged(rejected, before, { kind: 'steps', skipped: ['early'], healed: [] });
    // The plain-resume text stays first, followed by the refusal and the fork that replaces it.
    expect((rejected as Error).message).toMatch(
      /^Replay skipped recorded steps \(early\); workflow control flow changed\. The accepted replay was refused before run source was changed\. Fork a new run with --fork-from RUN --reuse matching --invalidate early\.$/u,
    );
  },
);

it('refuses an accepted fix to a failed step whose catch fallback already completed', async () => {
  let fixed = false;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('primary', {
        input: null,
        schema: z.string(),
        run: fixed
          ? () => 'primary'
          : () => {
              throw new Error('primary failed');
            },
      });
    } catch {
      await ctx.step('fallback', { input: null, schema: z.string(), run: () => 'fallback' });
    }
    if (!fixed) throw new Error('tail');
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const before = { record: await readRun(options()), files: await runFiles('source') };
  // The fix heals primary, so the body no longer reaches the completed fallback.
  fixed = true;
  await expectUnchanged(await acceptedRejection(definition), before, {
    kind: 'steps',
    skipped: ['fallback'],
    healed: ['primary'],
  });
  expect((await readRun(options())).steps['primary']?.status).toBe('failed');
});

it('re-finalizes an embedded tail-only fix with zero repeated effects and runs a fixed callback once', async () => {
  const counted = vi.fn(() => 'counted');
  let lateRuns = 0;
  let late = (): string => {
    lateRuns++;
    throw new Error('bug');
  };
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const harness: Harness = { invoke };
  const definition = workflow(async (ctx) => {
    const value = await ctx.step('counted', { input: null, schema: z.string(), run: counted });
    const agent = await ctx.claude.text('agent', { prompt: 'p' });
    const repaired = await ctx.step('late', { input: null, schema: z.string(), run: late });
    return `${value}/${agent.output}/${repaired}`;
  });
  await expect(runWorkflow(definition, { ...options(), harness })).rejects.toThrow('bug');
  late = () => {
    lateRuns++;
    return 'late';
  };
  const events: WorkflowEvent[] = [];
  const result = await runWorkflow(definition, {
    ...options(),
    harness,
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
    onEvent(event) {
      events.push(event);
    },
  });
  expect(result).toMatchObject({ status: 'completed', output: 'counted/ok/late' });
  expect(counted).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  // The preflight stubbed the fixed callback; only the real resume ran it.
  expect(lateRuns).toBe(2);
  expect(result.codeChanges).toHaveLength(1);
  // The probe drops onEvent: only the real resume reported a start.
  expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
});

it.each([
  { abort: 'a cancel', reason: () => new Error('stop'), status: 'cancelled' },
  {
    abort: 'a marked interruption',
    reason: () => new RunInterruptedError('Workflow interrupted by SIGINT.'),
    status: 'suspended',
  },
] as const)(
  'ends the run on $abort during the preflight without recording the acceptance',
  async ({ reason, status }) => {
    let bodies = 0;
    const controller = new AbortController();
    const cause = reason();
    let callback = (): string => 'one';
    const definition = workflow(async (ctx) => {
      // The second body is the preflight's: abort there, before it meets the changed step.
      if (++bodies === 2) controller.abort(cause);
      await ctx.step('local', { input: null, schema: z.string(), run: callback });
      throw new Error('tail');
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    const before = await readRun(options());
    callback = () => 'two';
    const events: WorkflowEvent[] = [];
    const rejected = await acceptedRejection(definition, {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(bodies).toBe(2);
    // The abort ends this execution, as one in the body would: the saved run, with the reason.
    expect(rejected).toBeInstanceOf(WorkflowRunError);
    expect((rejected as WorkflowRunError).cause).toBe(cause);
    expect((rejected as WorkflowRunError).run.status).toBe(status);
    const after = await readRun(options());
    expect(after.status).toBe(status);
    if (status === 'cancelled') {
      expect(after).toMatchObject({ error: 'stop', rootCause: { stepId: null, error: 'stop' } });
      expect(after.interruptedBy).toBeUndefined();
    } else {
      expect(after).toMatchObject({
        error: null,
        rootCause: null,
        interruptedBy: { reason: 'Workflow interrupted by SIGINT.' },
      });
      expect(after.nextWakeAt).toEqual(expect.any(Number));
    }
    // The execution ends with its lifecycle record, which the observer sees once saved.
    const type = status === 'cancelled' ? 'run.cancelled' : 'run.suspended';
    expect(after.events?.at(-1)).toMatchObject({
      type,
      execution: (before.executions?.length ?? 0) + 1,
      message: status === 'cancelled' ? 'stop' : null,
    });
    expect(after.executions).toHaveLength((before.executions?.length ?? 0) + 1);
    expect(after.executions?.at(-1)).toMatchObject({
      outcome: status,
      error: status === 'cancelled' ? 'stop' : null,
    });
    expect(after.executions?.at(-1)?.endedAt).not.toBeNull();
    expect(events).toEqual([
      expect.objectContaining({
        type,
        runId: 'source',
        attempt: 0,
        message:
          status === 'cancelled'
            ? 'stop'
            : 'Run interrupted; resumable: Workflow interrupted by SIGINT.',
      }),
    ]);
    // The acceptance was never recorded.
    expect(after.workflow.fingerprint).toBe(before.workflow.fingerprint);
    expect(after.output).toEqual(before.output);
    expect(after.codeChanges).toEqual(before.codeChanges);
    expect(after.steps).toEqual(before.steps);
    // So a later accepted resume still meets the changed step on its preflight.
    const refused = await acceptedRejection(definition);
    expect(refused).toBeInstanceOf(StepIdentityChangedError);
    expect(refused).not.toBeInstanceOf(WorkflowRunError);
    expect((await readRun(options())).status).toBe(status);
  },
);

it('still fails and changes the run when the preflight cannot reach a changed completed step', async () => {
  let callback = (): string => 'one';
  let gap = false;
  const definition = workflow(async (ctx) => {
    // A pattern the preflight cannot synthesize: its copy fails here and finds nothing.
    if (gap)
      await ctx.step('gap', { input: null, schema: z.string().regex(/^x$/u), run: () => 'x' });
    await ctx.step('local', { input: null, schema: z.string(), run: callback });
    throw new Error('tail');
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  gap = true;
  callback = () => 'two';
  const rejected = await acceptedRejection(definition);
  expect(rejected).toBeInstanceOf(WorkflowRunError);
  expect(findStepIdentityChange(rejected)).toMatchObject({ stepId: 'local', status: 'completed' });
  const after = await readRun(options());
  expect(after.status).toBe('failed');
  expect(after.workflow.identity?.code).toBe('code-2');
  expect(after.codeChanges).toHaveLength(1);
  expect(after.steps['gap']?.status).toBe('completed');
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
  const failed = await readRun(options());
  expect(failed.recoveryHint).toContain('All recorded work has terminal outcomes');
  expect(failed.recoveryCause).toEqual({ kind: 'authoring' });
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
  // A successful resume clears the saved cause with the hint, in memory and on disk.
  expect(result.recoveryCause).toBeUndefined();
  expect((await readRun(options())).recoveryCause).toBeUndefined();
  expect(effect).toHaveBeenCalledTimes(1);
});

it('clears stale output before re-finalizing, so a failed re-finalization reports null output', async () => {
  const definition = workflow(() => Promise.resolve('done'));
  await runWorkflow(definition, options());
  const before = await readRun(options());
  expect(before.status).toBe('completed');
  expect(before.output).toBe('done');
  // A deliberately mismatched output schema; schema-first inference would otherwise reject it.
  const broken = { ...definition, output: z.literal('other') } as unknown as typeof definition;
  await expect(
    runWorkflow(broken, {
      ...options(),
      resume: true,
      fingerprint: 'code-2',
      acceptCodeChange: true,
    }),
  ).rejects.toThrow();
  const after = await readRun(options());
  expect(after.status).toBe('failed');
  expect(after.output).toBeNull();
});

it('checks compatibility while a writer lock exists, itemizes changed files, and retains non-code gates', async () => {
  const run = vi.fn(() => Promise.resolve('done'));
  const definition = workflow(run);
  const source = { hash: 'old', files: { 'lib/report.ts': 'old', 'removed.ts': 'old' } };
  const setup = { runId: 'source', stateDir, input: { n: 1 }, source };
  await runWorkflow(definition, setup);
  const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
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
    expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
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
      await ctx.map('live', ['a', 'b'], { concurrency: 2, key: (id) => id }, (id) =>
        ctx.step('run', {
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
    if (strictReplay) expect(saved.steps['live/a/run']).toBeUndefined();
    // The same source took a different path, so the hint blames a body-computed value even when
    // the strict stop cancelled map siblings.
    for (const phrase of ['ctx.now', 'ctx.step', 'strictReplay: true', '--fork-from source'])
      expect(saved.recoveryHint).toContain(phrase);
    expect(saved.recoveryHint).not.toContain('accept-code-change');
  },
);

const nondeterministicHint = (hint: string | undefined): void => {
  for (const phrase of ['ctx.now', 'ctx.step', 'strictReplay: true'])
    expect(hint).toContain(phrase);
  expect(hint).not.toContain('accept-code-change');
};

it.each([false, true])(
  'advises against body-computed values when an unchanged source skips recorded steps (strictReplay: %s)',
  async (strictReplay) => {
    // A closure flag stands in for a value the body computes outside a durable effect.
    let early = true;
    let fail = true;
    const definition = workflow(async (ctx) => {
      if (early) await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
      await ctx.step('shared', { input: null, schema: z.string(), run: () => 's' });
      if (fail) throw new Error('pause');
      return ctx.step('late', { input: null, schema: z.string(), run: () => 'l' });
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
    early = false;
    fail = false;
    const error: unknown = await runWorkflow(definition, {
      ...options(),
      resume: true,
      strictReplay,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowRunError);
    expect((error as Error).message).toContain(
      strictReplay ? 'Replay divergence before live step late' : 'Replay skipped recorded steps',
    );
    nondeterministicHint((await readRun(options())).recoveryHint);
  },
);

it('names workflow resume for a divergence only when the run stored a launch', async () => {
  let early = true;
  let fail = true;
  const definition = workflow(async (ctx) => {
    if (early) await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
    await ctx.step('shared', { input: null, schema: z.string(), run: () => 's' });
    if (fail) throw new Error('pause');
    return ctx.step('late', { input: null, schema: z.string(), run: () => 'l' });
  });
  const launch = { entrypoint: '/project/workflow.ts', tsconfig: null };
  await expect(runWorkflow(definition, { ...options('launched'), launch })).rejects.toThrow(
    'pause',
  );
  await expect(runWorkflow(definition, options('embedded'))).rejects.toThrow('pause');
  early = false;
  fail = false;
  for (const runId of ['launched', 'embedded'])
    await expect(
      runWorkflow(definition, { ...options(runId), resume: true }),
    ).rejects.toBeInstanceOf(WorkflowRunError);
  const launched = (await readRun(options('launched'))).recoveryHint;
  expect(launched).toContain('workflow resume launched --strict-replay');
  expect(launched).not.toContain('strictReplay: true');
  const embedded = (await readRun(options('embedded'))).recoveryHint;
  expect(embedded).toContain('strictReplay: true');
  expect(embedded).not.toContain('workflow resume');
});

it('advises against body-computed values when strict replay stops after a healed step', async () => {
  let attempt = 0;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('flaky', {
        input: null,
        schema: z.string(),
        run: () => {
          attempt += 1;
          if (attempt === 1) throw new Error('flaky');
          return 'healed';
        },
      });
    } catch (error) {
      // Launched after the failure settled, so it may depend on it.
      await ctx.step('other', { input: null, schema: z.string(), run: () => 'o' });
      throw error;
    }
    return ctx.step('after', { input: null, schema: z.string(), run: () => 'a' });
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('flaky');
  expect((await readRun(options())).recoveryHint).toContain('Resume with --resume');
  const error: unknown = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay: true,
  }).catch((cause: unknown) => cause);
  expect((error as Error).message).toContain('Healed step flaky now succeeded');
  nondeterministicHint((await readRun(options())).recoveryHint);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function divergence(error: unknown): ReplayDivergenceError | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof ReplayDivergenceError) return cause;
  return undefined;
}

/** Rewrite a saved run without launch stamps, as a checkpoint written before they existed. */
async function stripStamps(runId: string): Promise<RunRecord> {
  const record = await readRun(options(runId));
  for (const step of Object.values(record.steps)) {
    delete step.launchStamp;
    delete step.settleStamp;
    delete step.failureStamp;
    delete step.failureHistory;
  }
  await writeFile(join(stateDir, runId, 'run.json'), JSON.stringify(record));
  await writeFile(join(stateDir, runId, 'journal.jsonl'), '');
  return record;
}

type FanInOrder = 'followups first' | 'impl first' | 'impl during followups preparation';

/**
 * `impl` (a local step) and `followups` (a Codex call whose image snapshot awaits before its
 * effect starts) launch in the same tick and fan in with Promise.all; impl fails only on the first
 * execution. 'impl first' completes followups while the failed body drains. In 'impl during
 * followups preparation', the snapshot waits until impl's failure is saved, so followups reaches
 * its record after the failure settled although the body requested it before; that body uses
 * Promise.allSettled, since a failed body launches no new effect. `ship` is the first live step
 * after the fan-in, where strict replay would stop.
 */
function fanIn(order: FanInOrder): {
  definition: ReturnType<typeof workflow>;
  harness: Harness;
  calls: string[];
  onEvent: (event: WorkflowEvent) => void;
  heal: () => void;
} {
  let broken = true;
  const calls: string[] = [];
  const implFailed = deferred();
  const followupsDone = deferred();
  const harness: Harness = {
    async invoke(request) {
      calls.push(request.options.prompt);
      if (broken && order === 'impl first') await implFailed.promise;
      return reply;
    },
  };
  const image = join(stateDir, 'shot.png');
  if (order === 'impl during followups preparation') preparation.gate = implFailed.promise;
  const definition = workflow(async (ctx) => {
    const launched = [
      ctx.step('impl', {
        input: null,
        schema: z.string(),
        run: async () => {
          if (!broken) return 'implemented';
          if (order === 'followups first') await followupsDone.promise;
          throw new Error('impl failed');
        },
      }),
      ctx.codex.text('followups', { prompt: 'followups', images: [image] }),
    ] as const;
    const [impl] =
      order === 'impl during followups preparation'
        ? await Promise.allSettled(launched).then((results) =>
            results.map((result) => {
              if (result.status === 'rejected') throw result.reason;
              return result.value;
            }),
          )
        : await Promise.all(launched);
    await ctx.step('ship', { input: null, schema: z.null(), run: () => null });
    return impl as string;
  });
  return {
    definition,
    harness,
    calls,
    onEvent: (event) => {
      if (event.type === 'step.failed' && event.stepId === 'impl') implFailed.resolve();
      if (event.type === 'step.completed' && event.stepId === 'followups') followupsDone.resolve();
    },
    heal: () => {
      broken = false;
    },
  };
}

it.each<FanInOrder>(['followups first', 'impl first', 'impl during followups preparation'])(
  'does not flag a Promise.all sibling launched with a healed step (%s)',
  async (order) => {
    const { definition, harness, calls, onEvent, heal } = fanIn(order);
    await writeFile(join(stateDir, 'shot.png'), 'png');
    await expect(runWorkflow(definition, { ...options(), harness, onEvent })).rejects.toThrow(
      'impl failed',
    );
    const failed = await readRun(options());
    const impl = failed.steps['impl'];
    const followups = failed.steps['followups'];
    expect(impl?.status).toBe('failed');
    expect(followups?.status).toBe('completed');
    expect(impl?.failureStamp).toBe(impl?.settleStamp);
    expect(followups?.launchStamp).toBeLessThan(impl?.failureStamp ?? 0);
    // Settle order shows in the stamps, launch order does not.
    if (order === 'followups first')
      expect(followups?.settleStamp).toBeLessThan(impl?.failureStamp ?? 0);
    else expect(followups?.settleStamp).toBeGreaterThan(impl?.failureStamp ?? 0);
    heal();
    calls.length = 0;
    const events: WorkflowEvent[] = [];
    const resumed = await runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      strictReplay: true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('implemented');
    expect(calls).toEqual([]);
    expect(events.filter((event) => event.type === 'replay.divergence')).toEqual([]);
    const saved = await readRun(options());
    expect(saved.replayWarnings).toEqual([]);
    expect(saved.steps['impl']?.failureStamp).toBeUndefined();
    expect(saved.steps['impl']?.settleStamp).toBeGreaterThan(impl?.failureStamp ?? 0);
  },
);

it.each([false, true])(
  'flags a step launched after the healed failure settled (strictReplay: %s)',
  async (strictReplay) => {
    let broken = true;
    const ran: string[] = [];
    const local = (id: string) => ({
      input: null,
      schema: z.string(),
      run: () => {
        ran.push(id);
        if (broken && id === 'primary') throw new Error('primary failed');
        return id;
      },
    });
    const definition = workflow(async (ctx) => {
      try {
        await ctx.step('primary', local('primary'));
      } catch {
        await ctx.step('fallback', local('fallback'));
      }
      if (broken) throw new Error('tail');
      return ctx.step('later', local('later'));
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    broken = false;
    ran.length = 0;
    const healed: WorkflowEvent[] = [];
    const outcome = await runWorkflow(definition, {
      ...options(),
      resume: true,
      strictReplay,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }).catch((error: unknown) => error);
    expect(healed.filter((event) => event.healedStepId)).toMatchObject([
      { healedStepId: 'primary', skippedStepIds: ['fallback'] },
    ]);
    expect((await readRun(options())).replayWarnings?.[0]).toContain(
      'Healed step primary now succeeded; later recorded steps (fallback)',
    );
    if (strictReplay) {
      expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
      expect(divergence(outcome)?.message).toContain('Healed step primary now succeeded');
      expect(ran).toEqual(['primary']);
    } else {
      // The plain resume runs on and then reports the skipped fallback with the healed step.
      expect(outcome).toBeInstanceOf(WorkflowRunError);
      const skipped = findAcceptedReplayDivergence(outcome);
      expect(skipped).toBeInstanceOf(ReplaySkippedError);
      expect(skipped).toMatchObject({ kind: 'steps', skipped: ['fallback'], healed: ['primary'] });
      expect(skipped?.message).toContain('Healed steps: primary');
      expect(ran).toEqual(['primary', 'later']);
    }
  },
);

it('keeps the earliest failure stamp across repeated failures until the step completes', async () => {
  let failures = 2;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('healer', {
        input: null,
        schema: z.string(),
        run: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('healer failed');
          }
          return 'h';
        },
      });
    } catch {
      await ctx.step('dependent', { input: null, schema: z.string(), run: () => 'd' });
      throw new Error('tail');
    }
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  const firstFailure = first.steps['healer']?.failureStamp;
  expect(firstFailure).toBeDefined();
  expect(first.steps['dependent']?.launchStamp).toBeGreaterThanOrEqual(firstFailure ?? 0);
  expect(first.steps['healer']?.failureHistory).toEqual([
    { launchStamp: first.steps['healer']?.launchStamp, failureStamp: firstFailure },
  ]);
  // The second failure settles after the dependent launched; only the first one explains it.
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow('tail');
  const second = await readRun(options());
  expect(second.steps['healer']?.failureStamp).toBe(firstFailure);
  // Both failures, each with the launch that failed; the dependent replayed in the second run.
  expect(second.steps['healer']?.failureHistory).toEqual([
    { launchStamp: first.steps['healer']?.launchStamp, failureStamp: firstFailure },
    {
      launchStamp: second.steps['healer']?.launchStamp,
      failureStamp: second.steps['healer']?.settleStamp,
    },
  ]);
  expect(second.steps['healer']?.launchStamp).toBeGreaterThan(
    first.steps['healer']?.launchStamp ?? 0,
  );
  expect(second.steps['healer']?.settleStamp).toBeGreaterThan(
    second.steps['dependent']?.launchStamp ?? 0,
  );
  expect(second.steps['dependent']?.launchStamp).toBe(first.steps['dependent']?.launchStamp);
  const healed: WorkflowEvent[] = [];
  await expect(
    runWorkflow(definition, {
      ...options(),
      resume: true,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }),
  ).rejects.toThrow('Healed steps: healer');
  expect(healed).toMatchObject([{ healedStepId: 'healer', skippedStepIds: ['dependent'] }]);
  const third = await readRun(options());
  expect(third.steps['healer']).toMatchObject({ status: 'completed' });
  expect(third.steps['healer']?.failureStamp).toBeUndefined();
  expect(third.steps['healer']?.failureHistory).toBeUndefined();
  expect(third.steps['healer']?.settleStamp).toBeGreaterThan(
    second.steps['healer']?.settleStamp ?? 0,
  );
});

it('does not flag a fan-in sibling that completed while the healed step failed again (#300)', async () => {
  let execution = 1;
  const ran: string[] = [];
  const followupsFailed = deferred();
  const followupsDone = deferred();
  const definition = workflow(async (ctx) => {
    const [impl] = await Promise.all([
      ctx.step('impl', {
        input: null,
        schema: z.string(),
        run: async () => {
          ran.push('impl');
          // Run 1 fails after followups; run 2 fails again after followups completed.
          if (execution === 1) {
            await followupsFailed.promise;
            throw new Error('impl failed');
          }
          if (execution === 2) {
            await followupsDone.promise;
            throw new Error('impl failed again');
          }
          return 'implemented';
        },
      }),
      ctx.step('followups', {
        input: null,
        schema: z.string(),
        run: () => {
          ran.push('followups');
          if (execution === 1) throw new Error('followups failed');
          return 'followups';
        },
      }),
    ]);
    await ctx.step('ship', {
      input: null,
      schema: z.null(),
      run: () => {
        ran.push('ship');
        return null;
      },
    });
    return impl;
  });
  const onEvent = (event: WorkflowEvent) => {
    if (event.type === 'step.failed' && event.stepId === 'followups') followupsFailed.resolve();
    if (event.type === 'step.completed' && event.stepId === 'followups') followupsDone.resolve();
  };
  await expect(runWorkflow(definition, { ...options(), onEvent })).rejects.toThrow(
    'followups failed',
  );
  const first = await readRun(options());
  expect(first.steps['impl']?.status).toBe('failed');
  expect(first.steps['followups']?.status).toBe('failed');
  const firstFailure = first.steps['impl']?.failureStamp ?? 0;
  expect(firstFailure).toBe(first.steps['impl']?.settleStamp);

  execution = 2;
  await expect(runWorkflow(definition, { ...options(), resume: true, onEvent })).rejects.toThrow(
    'impl failed again',
  );
  const second = await readRun(options());
  const impl = second.steps['impl'];
  const followups = second.steps['followups'];
  expect(followups?.status).toBe('completed');
  expect(impl?.status).toBe('failed');
  // The earliest failure is kept; the history adds the second failing launch.
  expect(impl?.failureStamp).toBe(firstFailure);
  expect(impl?.failureHistory).toEqual([
    { launchStamp: first.steps['impl']?.launchStamp, failureStamp: firstFailure },
    { launchStamp: impl?.launchStamp, failureStamp: impl?.settleStamp },
  ]);
  // The watermark alone would flag followups: it launched after the first failure (the counter
  // restarts one past the highest persisted stamp), but in the same tick as impl's second launch
  // and before its second failure.
  expect(followups?.launchStamp).toBeGreaterThanOrEqual(firstFailure);
  expect(followups?.launchStamp).toBe(impl?.launchStamp);
  expect(followups?.launchStamp).toBeLessThan(impl?.settleStamp ?? 0);

  execution = 3;
  ran.length = 0;
  const events: WorkflowEvent[] = [];
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(resumed.status).toBe('completed');
  expect(resumed.output).toBe('implemented');
  expect(ran).toEqual(['impl', 'ship']);
  expect(events.filter((event) => event.type === 'replay.divergence')).toEqual([]);
  const third = await readRun(options());
  expect(third.replayWarnings ?? []).toEqual([]);
  expect(third.steps['impl']).toMatchObject({ status: 'completed' });
  expect(third.steps['impl']?.failureStamp).toBeUndefined();
  expect(third.steps['impl']?.failureHistory).toBeUndefined();
});

it('flags a completed wait that observed the first failure once a later run relaunched the healed step (#300)', async () => {
  let execution = 1;
  const ran: string[] = [];
  const definition = workflow(async (ctx) => {
    let failed = false;
    try {
      await ctx.step('healer', {
        input: null,
        schema: z.string(),
        run: () => {
          ran.push('healer');
          if (execution < 3) throw new Error('healer failed');
          return 'h';
        },
      });
    } catch {
      failed = true;
    }
    // Launched after the failure settled; a completed wait adds no settlement of its own.
    const checked = await ctx.poll('ci', {
      input: null,
      schema: z.string(),
      every: 1,
      timeoutMs: 60_000,
      observe: () => Promise.resolve({ done: true as const, value: 'green' }),
    });
    const ci = checked.by === 'poll' ? checked.value : 'timed out';
    if (failed) throw new Error('tail');
    return ctx.step('ship', {
      input: null,
      schema: z.string(),
      run: () => {
        ran.push('ship');
        return ci;
      },
    });
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  const firstFailure = first.steps['healer']?.failureStamp;
  expect(first.steps['ci']?.status).toBe('completed');
  expect(first.steps['ci']?.launchStamp).toBe(firstFailure);

  execution = 2;
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow('tail');
  const second = await readRun(options());
  // The relaunch is stamped past every persisted stamp, the wait's launch included, so it cannot
  // hide the first failure that the replayed wait observed.
  expect(second.steps['healer']?.launchStamp).toBeGreaterThan(first.steps['ci']?.launchStamp ?? 0);
  expect(second.steps['ci']?.launchStamp).toBe(first.steps['ci']?.launchStamp);
  expect(second.steps['healer']?.failureHistory).toHaveLength(2);

  execution = 3;
  ran.length = 0;
  const healed: WorkflowEvent[] = [];
  const outcome = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay: true,
    onEvent: (event) => {
      if (event.type === 'replay.divergence') healed.push(event);
    },
  }).catch((error: unknown) => error);
  expect(healed).toMatchObject([{ healedStepId: 'healer', skippedStepIds: ['ci'] }]);
  expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
  expect(ran).toEqual(['healer']);
  expect((await readRun(options())).steps['ship']).toBeUndefined();
});

it('falls back to the first-failure watermark once the failure history is truncated', async () => {
  let failures = 9;
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('healer', {
        input: null,
        schema: z.string(),
        run: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('healer failed');
          }
          return 'h';
        },
      });
    } catch {
      await ctx.step('dependent', { input: null, schema: z.string(), run: () => 'd' });
      throw new Error('tail');
    }
    return 'done';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const first = await readRun(options());
  const firstFailure = first.steps['healer']?.failureStamp;
  expect(firstFailure).toBeDefined();
  for (let resume = 1; resume < 9; resume++)
    await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow('tail');
  const failed = await readRun(options());
  const history = failed.steps['healer']?.failureHistory ?? [];
  expect(history).toHaveLength(8);
  expect(failed.steps['healer']?.failureStamp).toBe(firstFailure);
  // The first failure was dropped, so the history no longer starts at failureStamp.
  expect(history[0]?.failureStamp).toBeGreaterThan(firstFailure ?? 0);
  expect(history.at(-1)?.failureStamp).toBe(failed.steps['healer']?.settleStamp);
  // Every kept launch came after the dependent launched; only the watermark still sees it.
  expect(failed.steps['dependent']?.launchStamp).toBe(first.steps['dependent']?.launchStamp);
  expect(history[0]?.launchStamp).toBeGreaterThan(failed.steps['dependent']?.launchStamp ?? 0);
  const healed: WorkflowEvent[] = [];
  await expect(
    runWorkflow(definition, {
      ...options(),
      resume: true,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }),
  ).rejects.toThrow('Healed steps: healer');
  expect(healed).toMatchObject([{ healedStepId: 'healer', skippedStepIds: ['dependent'] }]);
  const saved = await readRun(options());
  expect(saved.steps['healer']?.failureHistory).toBeUndefined();
  expect(saved.steps['healer']?.failureStamp).toBeUndefined();
});

/** Settles with the abort reason once `signal` aborts, as a cancellable effect would. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * `healer` fails in run 1 (the catch then launches `dependent` and throws `tail`), aborts the run
 * from inside its effect in run 2, and succeeds in run 3. The catch rethrows an aborted run's error
 * so run 2 launches nothing else.
 */
function healerAcrossRuns(abort: () => Error): {
  definition: ReturnType<typeof workflow>;
  controller: AbortController;
  next: (mode: 'abort' | 'ok') => void;
  ran: string[];
} {
  let mode: 'fail' | 'abort' | 'ok' = 'fail';
  const controller = new AbortController();
  const ran: string[] = [];
  const definition = workflow(async (ctx) => {
    try {
      await ctx.step('healer', {
        input: null,
        schema: z.string(),
        run: async ({ signal }) => {
          ran.push('healer');
          if (mode === 'fail') throw new Error('healer failed');
          if (mode === 'abort') {
            controller.abort(abort());
            await untilAborted(signal);
          }
          return 'h';
        },
      });
    } catch (error) {
      if (mode !== 'fail') throw error;
      await ctx.step('dependent', {
        input: null,
        schema: z.string(),
        run: () => {
          ran.push('dependent');
          return 'd';
        },
      });
      throw new Error('tail', { cause: error });
    }
    return ctx.step('later', {
      input: null,
      schema: z.string(),
      run: () => {
        ran.push('later');
        return 'done';
      },
    });
  });
  return {
    definition,
    controller,
    ran,
    next: (next) => {
      mode = next;
    },
  };
}

async function expectHealedResume(
  definition: ReturnType<typeof workflow>,
  ran: string[],
  strictReplay: boolean,
): Promise<void> {
  ran.length = 0;
  const events: WorkflowEvent[] = [];
  const outcome = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay,
    onEvent: (event) => {
      if (event.type === 'replay.divergence') events.push(event);
    },
  }).catch((error: unknown) => error);
  expect(events.filter((event) => event.healedStepId)).toMatchObject([
    { healedStepId: 'healer', skippedStepIds: ['dependent'] },
  ]);
  const saved = await readRun(options());
  expect(saved.replayWarnings?.[0]).toContain(
    'Healed step healer now succeeded; later recorded steps (dependent)',
  );
  expect(saved.steps['healer']).toMatchObject({ status: 'completed' });
  expect(saved.steps['healer']?.failureStamp).toBeUndefined();
  // The recorded dependent never runs again. Strict replay stops before the next live step.
  if (strictReplay) {
    expect(ran).toEqual(['healer']);
    expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
  } else {
    expect(ran).toEqual(['healer', 'later']);
    expect(findAcceptedReplayDivergence(outcome)).toMatchObject({
      kind: 'steps',
      skipped: ['dependent'],
      healed: ['healer'],
    });
  }
}

it.each(
  [false, true].flatMap((strictReplay) => [
    { abort: 'a cancel', reason: () => new Error('stop'), status: 'cancelled', strictReplay },
    {
      abort: 'a marked interruption',
      reason: () => new RunInterruptedError('Workflow interrupted by SIGINT.'),
      status: 'suspended',
      strictReplay,
    },
  ]),
)(
  'flags a step that failed, then ended $abort in a later run, once it succeeds (strictReplay: $strictReplay)',
  async ({ reason, status, strictReplay }) => {
    {
      const { definition, controller, next, ran } = healerAcrossRuns(reason);
      await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
      const first = await readRun(options());
      const failureStamp = first.steps['healer']?.failureStamp;
      expect(first.steps['healer']?.status).toBe('failed');
      expect(failureStamp).toBeDefined();
      expect(first.steps['dependent']?.launchStamp).toBeGreaterThanOrEqual(failureStamp ?? 0);

      next('abort');
      const aborted = await runWorkflow(definition, {
        ...options(),
        resume: true,
        signal: controller.signal,
      }).catch((error: unknown) => error);
      expect(aborted).toBeInstanceOf(WorkflowRunError);
      const second = await readRun(options());
      expect(second.status).toBe(status);
      expect(['failed', 'completed']).not.toContain(second.steps['healer']?.status);
      expect(second.steps['healer']?.failureStamp).toBe(failureStamp);
      expect(second.steps['dependent']).toEqual(first.steps['dependent']);

      next('ok');
      await expectHealedResume(definition, ran, strictReplay);
    }
  },
);

it.each([false, true])(
  'flags a step that failed and was left running by a crashed owner once it succeeds (strictReplay: %s)',
  async (strictReplay) => {
    const { definition, next, ran } = healerAcrossRuns(() => new Error('stop'));
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    const record = await readRun(options());
    const failureStamp = record.steps['healer']?.failureStamp;
    expect(failureStamp).toBeDefined();
    // The relaunch started and its owner died: the step is left running, with its failure stamp.
    const healer = record.steps['healer'];
    if (healer) healer.status = 'running';
    await writeFile(join(stateDir, 'source', 'run.json'), JSON.stringify(record));
    await writeFile(join(stateDir, 'source', 'journal.jsonl'), '');
    expect((await readRun(options())).steps['healer']).toMatchObject({
      status: 'running',
      failureStamp,
    });
    next('ok');
    await expectHealedResume(definition, ran, strictReplay);
  },
);

it('does not flag a step that was only cancelled, whatever settled after it', async () => {
  let cancelled = true;
  const controller = new AbortController();
  const definition = workflow(async (ctx) => {
    await Promise.all([
      ctx.step('slow', {
        input: null,
        schema: z.string(),
        run: async ({ signal }) => {
          if (!cancelled) return 'slow';
          await untilAborted(signal);
          return 'slow';
        },
      }),
      ctx.step('sibling', {
        input: null,
        schema: z.string(),
        run: () => {
          if (cancelled)
            setImmediate(() => {
              controller.abort(new Error('stop'));
            });
          return 'sibling';
        },
      }),
    ]);
    return 'done';
  });
  await expect(
    runWorkflow(definition, { ...options(), signal: controller.signal }),
  ).rejects.toBeInstanceOf(WorkflowRunError);
  const first = await readRun(options());
  expect(first.steps['slow']?.status).toBe('cancelled');
  expect(first.steps['slow']?.failureStamp).toBeUndefined();
  expect(first.steps['sibling']).toMatchObject({ status: 'completed' });
  // A seq fallback would flag the sibling, which was launched after the slow step.
  expect(first.steps['sibling']?.seq).toBeGreaterThan(first.steps['slow']?.seq ?? 0);
  cancelled = false;
  const events: WorkflowEvent[] = [];
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    strictReplay: true,
    onEvent: (event) => {
      if (event.type === 'replay.divergence') events.push(event);
    },
  });
  expect(resumed.status).toBe('completed');
  expect(events.filter((event) => event.healedStepId)).toEqual([]);
  expect((await readRun(options())).replayWarnings ?? []).toEqual([]);
});

it.each([false, true])(
  'falls back to launch order for a checkpoint without launch stamps (strictReplay: %s)',
  async (strictReplay) => {
    const { definition, harness, calls, onEvent, heal } = fanIn('followups first');
    await writeFile(join(stateDir, 'shot.png'), 'png');
    await expect(runWorkflow(definition, { ...options(), harness, onEvent })).rejects.toThrow(
      'impl failed',
    );
    const stripped = await stripStamps('source');
    expect(stripped.steps['followups']?.seq).toBeGreaterThan(stripped.steps['impl']?.seq ?? 0);
    const loaded = await readRun(options());
    expect(loaded.steps['followups']?.launchStamp).toBeUndefined();
    expect(loaded.steps['impl']?.failureStamp).toBeUndefined();
    heal();
    calls.length = 0;
    const healed: WorkflowEvent[] = [];
    const outcome = await runWorkflow(definition, {
      ...options(),
      harness,
      resume: true,
      strictReplay,
      onEvent: (event) => {
        if (event.type === 'replay.divergence') healed.push(event);
      },
    }).catch((error: unknown) => error);
    expect(calls).toEqual([]);
    expect(healed).toMatchObject([{ healedStepId: 'impl', skippedStepIds: ['followups'] }]);
    if (strictReplay) {
      expect(divergence(outcome)).toMatchObject({ reason: 'healed' });
      expect((await readRun(options())).steps['ship']).toBeUndefined();
    } else expect(outcome).toMatchObject({ status: 'completed', output: 'implemented' });
    expect((await readRun(options())).replayWarnings?.[0]).toContain(
      'later recorded steps (followups)',
    );
  },
);

it('stamps live launches, settlements and fork-reused copies in the target run', async () => {
  const definition = workflow(async (ctx) => {
    const a = await ctx.step('a', { input: null, schema: z.string(), run: () => 'a' });
    const b = await ctx.step('b', { input: null, schema: z.string(), run: () => 'b' });
    return a + b;
  });
  await runWorkflow(definition, options());
  const source = await readRun(options());
  expect(source.steps['a']).toMatchObject({ launchStamp: 0, settleStamp: 1 });
  expect(source.steps['b']).toMatchObject({ launchStamp: 1, settleStamp: 2 });
  const fork = await runWorkflow(definition, {
    ...options('fork'),
    forkFrom: { runId: 'source', invalidate: ['b'] },
  });
  expect(fork.steps['a']?.reusedFrom).toBeDefined();
  expect(fork.steps['a']).toMatchObject({ launchStamp: 0, settleStamp: 1 });
  expect(fork.steps['b']?.reusedFrom).toBeUndefined();
  expect(fork.steps['b']).toMatchObject({ launchStamp: 1, settleStamp: 2 });
  const asked = await runWorkflow(
    workflow(async (ctx) => {
      await ctx.step('a', { input: null, schema: z.string(), run: () => 'a' });
      return ctx.ask('q', { prompt: 'Text?', schema: z.string() });
    }),
    options('asks'),
  );
  expect(asked.status).toBe('suspended');
  expect(asked.steps['q']).toMatchObject({ status: 'waiting', launchStamp: 1 });
  expect(asked.steps['q']?.settleStamp).toBeUndefined();
});

it('advises against body-computed values when a completed step identity changes', async () => {
  let stamp = 'monday';
  let fail = true;
  const definition = workflow(async (ctx) => {
    await ctx.step('stamped', { input: stamp, schema: z.string(), run: () => 'done' });
    if (fail) throw new Error('pause');
    return 'ok';
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('pause');
  stamp = 'tuesday';
  fail = false;
  const error: unknown = await runWorkflow(definition, { ...options(), resume: true }).catch(
    (cause: unknown) => cause,
  );
  expect(findStepIdentityChange(error)?.stepId).toBe('stamped');
  nondeterministicHint((await readRun(options())).recoveryHint);
});

it('saves no resume advice for a run that fails before recording anything', async () => {
  const definition = workflow(() => Promise.reject(new Error('body bug')));
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect((error as Error).message).not.toContain('--resume');
  const saved = await readRun(options());
  expect(saved.recoveryHint).toBeUndefined();
  expect(hasTerminalOutcomes(saved)).toBe(false);
  expect((await checkResume(definition, options())).refinalizable).toBe(false);
});

it('suggests a plain resume for an effect failure and re-finalizing for a later configuration failure', async () => {
  let broken = true;
  const failing = workflow(async (ctx) => {
    await ctx.step('ok', { input: null, schema: z.string(), run: () => 'ok' });
    return ctx.step('effect', {
      input: null,
      schema: z.string(),
      run: () => {
        if (broken) throw new Error('remote down');
        return 'done';
      },
    });
  });
  await expect(runWorkflow(failing, options())).rejects.toThrow('remote down');
  const hint = (await readRun(options())).recoveryHint;
  expect(hint).toBe(
    'Resume with --resume once the cause is fixed or has passed; completed steps are reused and the failed step runs again.',
  );
  expect(hint).not.toContain('accept-code-change');
  broken = false;
  expect((await runWorkflow(failing, { ...options(), resume: true })).output).toBe('done');

  const configured = workflow(async (ctx) => {
    await ctx.step('ok', { input: null, schema: z.string(), run: () => 'ok' });
    throw new ConfigurationError('missing deploy target');
  });
  await expect(runWorkflow(configured, options('configured'))).rejects.toThrow(
    'missing deploy target',
  );
  const refinalize = (await readRun(options('configured'))).recoveryHint;
  expect(refinalize).toContain('All recorded work has terminal outcomes');
  expect(refinalize).toContain('re-finalize');
  expect(refinalize).toContain('--resume --accept-code-change');
});

it('names the call-site effect kind for a failure before the step has a record', async () => {
  const definition = workflow(async (ctx) => {
    await ctx.readFile('notes', 'notes.txt', { bogus: true } as never);
    return 'never';
  });
  const error: unknown = await runWorkflow(definition, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect((error as Error).message).toMatch(/^Step notes \(read-file\) failed:/u);
  expect((error as Error).message).not.toContain('(unknown)');
  const saved = await readRun(options());
  expect(saved.steps['notes']).toBeUndefined();
  expect(saved.rootCause).toMatchObject({ stepId: 'notes', effect: 'read-file' });
});

it('counts only recorded work as terminal outcomes', () => {
  const empty = { steps: {}, maps: {} } as unknown as Parameters<typeof hasTerminalOutcomes>[0];
  expect(hasTerminalOutcomes(empty)).toBe(false);
  const completed = {
    steps: { done: { status: 'completed' } },
    maps: {},
  } as unknown as Parameters<typeof hasTerminalOutcomes>[0];
  expect(hasTerminalOutcomes(completed)).toBe(true);
});

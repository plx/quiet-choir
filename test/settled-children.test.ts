// Settled child frames (#170): ctx.workflow(..., { onError: 'return' }) saves the frame's outcome,
// and resume replays it without running the child body or its effects again.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  defineWorkflow,
  FileRunStore,
  readRun,
  runWorkflow,
  z,
  type OwnedRunStore,
  type RunRecord,
  type RunStore,
  type WorkflowEvent,
} from '../src/index.js';
import { hasTerminalOutcomes, validateRecordChange } from '../src/workflow/runtime/record.js';

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-settled-children-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const types = (events: readonly WorkflowEvent[]) => events.map((event) => event.type);

/** A child whose one local step fails while `state.broken` is set, counting bodies and effects. */
function failingChild(
  state: { broken: boolean; bodies: number; effects: number },
  version = '1',
  input: z.ZodType = z.null(),
) {
  return defineWorkflow({
    name: 'worker',
    version,
    input,
    output: z.string(),
    async run(ctx) {
      state.bodies++;
      return ctx.step('work', {
        input: null,
        schema: z.string(),
        run: () => {
          state.effects++;
          if (state.broken) throw new Error('work failed');
          return 'worked';
        },
      });
    },
  });
}

it('settles a child failure, branches on it, and replays it on resume without the body', async () => {
  const state = { broken: true, bodies: 0, effects: 0 };
  const child = failingChild(state);
  let tail = true;
  const root = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.workflow('child', child, null, { onError: 'return' });
      const branch = result.ok ? `ok:${result.value}` : `fallback:${String(result.error.stepId)}`;
      if (tail) throw new Error('tail');
      return branch;
    },
  });
  const events: WorkflowEvent[] = [];
  const options = {
    stateDir,
    runId: 'settled',
    onEvent: (event: WorkflowEvent) => {
      events.push(event);
    },
  };
  await expect(runWorkflow(root, { ...options, input: null })).rejects.toThrow('tail');
  const first = await readRun({ stateDir, runId: 'settled' });
  expect(first.children?.['child']).toMatchObject({
    status: 'failed',
    onError: 'return',
    error: 'work failed',
    settled: {
      outcome: {
        ok: false,
        error: { message: 'work failed', kind: 'unknown', attempts: 1, stepId: 'child/work' },
      },
      steps: ['child/work'],
      maps: [],
      children: [],
    },
  });
  expect(first.steps['child/work']?.status).toBe('failed');
  expect(types(events)).toContain('child.settled');
  expect(types(events)).not.toContain('child.failed');
  // The only unfinished step is owned by the settled frame, so every outcome can replay.
  expect(hasTerminalOutcomes(first)).toBe(true);
  expect(hasTerminalOutcomes({ ...first, children: {} })).toBe(false);
  expect(state).toEqual({ broken: true, bodies: 1, effects: 1 });

  // The failure would now heal, but the settled branch decision must replay.
  state.broken = false;
  tail = false;
  events.length = 0;
  const resumed = await runWorkflow(root, { ...options, resume: true });
  expect(resumed.output).toBe('fallback:child/work');
  expect(state).toEqual({ broken: false, bodies: 1, effects: 1 });
  expect(types(events)).not.toContain('child.started');
  expect(types(events)).not.toContain('step.started');
  expect(events.filter((event) => event.type === 'step.replayed').map((e) => e.stepId)).toEqual([
    'child/work',
  ]);
  expect(resumed.children?.['child']).toEqual(first.children?.['child']);
  expect(resumed.steps['child/work']?.status).toBe('failed');
});

it.each(['typed', 'named'] as const)(
  'replays a settled %s success without the body and claims its owned steps',
  async (call) => {
    const state = { broken: false, bodies: 0, effects: 0 };
    const child = failingChild(state);
    let tail = true;
    const root = defineWorkflow({
      name: 'root',
      version: '1',
      input: z.null(),
      output: z.string(),
      children: [child],
      async run(ctx) {
        const result =
          call === 'typed'
            ? await ctx.workflow('child', child, null, { onError: 'return' })
            : await ctx.workflow('child', 'worker', null, { onError: 'return' });
        if (tail) throw new Error('tail');
        return result.ok ? result.value : 'failed';
      },
    });
    const events: WorkflowEvent[] = [];
    const options = {
      stateDir,
      runId: call,
      onEvent: (event: WorkflowEvent) => {
        events.push(event);
      },
    };
    await expect(runWorkflow(root, { ...options, input: null })).rejects.toThrow('tail');
    const first = await readRun({ stateDir, runId: call });
    expect(first.children?.['child']).toMatchObject({
      status: 'completed',
      onError: 'return',
      error: null,
      settled: { outcome: { ok: true, value: 'worked' }, steps: ['child/work'] },
    });
    tail = false;
    events.length = 0;
    const resumed = await runWorkflow(root, { ...options, resume: true });
    expect(resumed.output).toBe('worked');
    expect(state.bodies).toBe(1);
    expect(state.effects).toBe(1);
    expect(types(events)).not.toContain('child.started');
    expect(types(events)).not.toContain('step.superseded');
    expect(events.filter((event) => event.type === 'step.replayed').map((e) => e.stepId)).toEqual([
      'child/work',
    ]);
    expect(resumed.steps['child/work']?.status).toBe('completed');
  },
);

it('rejects cancellation, budget stops, invalid input and depth violations without settling', async () => {
  // External cancellation during the child body.
  const controller = new AbortController();
  const waiting = defineWorkflow({
    name: 'waiting',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      return ctx.step('block', {
        input: null,
        schema: z.null(),
        run: ({ signal }) =>
          new Promise<null>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(signal.reason as Error);
            });
            controller.abort(new Error('stop'));
          }),
      });
    },
  });
  const cancelled = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('child', waiting, null, { onError: 'return' })).ok;
    },
  });
  await expect(
    runWorkflow(cancelled, { stateDir, runId: 'cancel', input: null, signal: controller.signal }),
  ).rejects.toThrow();
  const cancelRun = await readRun({ stateDir, runId: 'cancel' });
  expect(cancelRun.children?.['child']?.status).toBe('cancelled');
  expect(cancelRun.children?.['child']).not.toHaveProperty('settled');

  // A latched run budget stop inside the child.
  let calls = 0;
  const agent = defineWorkflow({
    name: 'agent',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.claude.text('call', { prompt: 'x' });
      return null;
    },
  });
  const budgeted = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('child', agent, null, { onError: 'return' })).ok;
    },
  });
  await expect(
    runWorkflow(budgeted, {
      stateDir,
      runId: 'budget',
      input: null,
      maxRunAgentAttempts: 0,
      harness: {
        invoke: () => {
          calls++;
          return Promise.resolve({ text: 'ok', sessionId: null });
        },
      },
    }),
  ).rejects.toThrow('maxRunAgentAttempts');
  expect(calls).toBe(0);
  const budgetRun = await readRun({ stateDir, runId: 'budget' });
  expect(budgetRun.budgetStop).toMatchObject({ metric: 'maxRunAgentAttempts' });
  expect(budgetRun.children?.['child']?.status).toBe('failed');
  expect(budgetRun.children?.['child']).not.toHaveProperty('settled');

  // Input validation and depth fail before any frame starts.
  const typed = defineWorkflow({
    name: 'typed',
    version: '1',
    input: z.string(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  const invalid = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('child', typed, 4 as unknown as string, { onError: 'return' })).ok;
    },
  });
  await expect(runWorkflow(invalid, { stateDir, runId: 'input', input: null })).rejects.toThrow(
    'input validation failed',
  );
  expect((await readRun({ stateDir, runId: 'input' })).children?.['child']).toBeUndefined();
  const deep = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('child', typed, 'x', { onError: 'return' })).ok;
    },
  });
  await expect(
    runWorkflow(deep, { stateDir, runId: 'depth', input: null, maxChildDepth: 0 }),
  ).rejects.toThrow('exceeds maxChildDepth 0');
  expect((await readRun({ stateDir, runId: 'depth' })).children?.['child']).toBeUndefined();
});

it('refuses a changed settled frame and lets an unsettled failed frame start settling', async () => {
  const state = { broken: true, bodies: 0, effects: 0 };
  const root = (version: string, input: string, mode: 'return' | 'throw' | undefined) =>
    defineWorkflow({
      name: 'root',
      version: '1',
      input: z.null(),
      output: z.boolean(),
      async run(ctx) {
        const child = failingChild(state, version, z.string());
        const result = await ctx.workflow(
          'child',
          child,
          input,
          mode === undefined ? {} : { onError: mode },
        );
        if (mode === 'return' && version === '1' && input === 'a') throw new Error('tail');
        return typeof result === 'string' || result.ok;
      },
    });
  await expect(
    runWorkflow(root('1', 'a', 'return'), { stateDir, runId: 'changes', input: null }),
  ).rejects.toThrow('tail');
  for (const [changed, expected] of [
    [root('2', 'a', 'return'), 'worker@1 -> worker@2'],
    [root('1', 'b', 'return'), 'worker@1 -> worker@1'],
    [root('1', 'a', undefined), 'worker@1 -> worker@1 (onError return -> throw)'],
    [root('1', 'a', 'throw'), 'worker@1 -> worker@1 (onError return -> throw)'],
  ] as const) {
    const refusal = runWorkflow(changed, { stateDir, runId: 'changes', resume: true });
    await expect(refusal).rejects.toThrow(`Child frame child changed: ${expected}`);
    await expect(refusal).rejects.not.toThrow('--accept-code-change');
  }
  expect(state.bodies).toBe(1);

  // An unsettled failed frame reruns its body, so adding onError: 'return' settles it.
  await expect(
    runWorkflow(root('1', 'x', undefined), { stateDir, runId: 'switch', input: null }),
  ).rejects.toThrow('work failed');
  expect((await readRun({ stateDir, runId: 'switch' })).children?.['child']).toMatchObject({
    status: 'failed',
  });
  const switched = await runWorkflow(root('1', 'x', 'return'), {
    stateDir,
    runId: 'switch',
    resume: true,
  });
  expect(switched.output).toBe(false);
  expect(switched.children?.['child']).toMatchObject({
    status: 'failed',
    onError: 'return',
    settled: { outcome: { ok: false, error: { stepId: 'child/work', attempts: 2 } } },
  });
});

it('treats settled frames as terminal for visits, settled maps and declared descendants', async () => {
  const state = { broken: true, bodies: 0, effects: 0 };
  const child = failingChild(state);
  let skip = false;
  const root = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      if (!skip) await ctx.workflow('child', child, null, { onError: 'return' });
      if (!skip) throw new Error('tail');
      return null;
    },
  });
  await expect(runWorkflow(root, { stateDir, runId: 'skip', input: null })).rejects.toThrow('tail');
  skip = true;
  await expect(runWorkflow(root, { stateDir, runId: 'skip', resume: true })).rejects.toThrow(
    'Replay skipped completed or settled child frames (child)',
  );
  expect((await readRun({ stateDir, runId: 'skip' })).children?.['child']).toMatchObject({
    status: 'failed',
    settled: { outcome: { ok: false } },
  });

  // A settled frame inside a committed settled map item is claimed when the item replays.
  const mapState = { broken: false, bodies: 0, effects: 0 };
  const worker = failingChild(mapState);
  let tail = true;
  const mapped = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.array(z.boolean()),
    children: [worker],
    async run(ctx) {
      const items = await ctx.map(
        'items',
        [1, 2],
        { concurrency: 2, onError: 'return' },
        async () => (await ctx.workflow('inner', 'worker', null, { onError: 'return' })).ok,
      );
      if (tail) throw new Error('tail');
      return items.map((item) => item.ok && item.value);
    },
  });
  await expect(runWorkflow(mapped, { stateDir, runId: 'map', input: null })).rejects.toThrow(
    'tail',
  );
  const before = await readRun({ stateDir, runId: 'map' });
  expect(Object.values(before.children ?? {}).map((frame) => frame.settled?.outcome.ok)).toEqual([
    true,
    true,
  ]);
  tail = false;
  const replayed = await runWorkflow(mapped, { stateDir, runId: 'map', resume: true });
  expect(replayed.output).toEqual([true, true]);
  expect(mapState.bodies).toBe(2);

  // A settled frame's descendants must be declared, as inside a settled map.
  const dynamic = defineWorkflow({
    name: 'dynamic',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  const parent = defineWorkflow({
    name: 'parent',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      return ctx.workflow('dynamic', dynamic, null);
    },
  });
  const outer = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('parent', parent, null, { onError: 'return' })).ok;
    },
  });
  await expect(runWorkflow(outer, { stateDir, runId: 'dynamic', input: null })).rejects.toThrow(
    'inside a settled map or settled child frame',
  );
  expect((await readRun({ stateDir, runId: 'dynamic' })).children?.['parent']).not.toHaveProperty(
    'settled',
  );
});

it('does not keep a settled outcome whose checkpoint failed', async () => {
  const state = { broken: true, bodies: 0, effects: 0 };
  const child = failingChild(state);
  const root = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      return (await ctx.workflow('child', child, null, { onError: 'return' })).ok;
    },
  });
  const file = new FileRunStore(stateDir);
  let refused = 0;
  const store: RunStore = {
    stateDir: file.stateDir,
    read: (id) => file.read(id),
    list: () => file.list(),
    open: async (id, openOptions): Promise<OwnedRunStore> => {
      const owned = await file.open(id, openOptions);
      return {
        read: () => owned.read(),
        append: (record: RunRecord, appendOptions) => {
          if (Object.values(record.children ?? {}).some((frame) => frame.settled)) {
            refused++;
            return Promise.reject(new Error('disk full'));
          }
          return owned.append(record, appendOptions);
        },
        compact: () => owned.compact(),
        artifacts: (stepId, attempt) => owned.artifacts(stepId, attempt),
        trackProcess: (invocation, process) => owned.trackProcess(invocation, process),
        release: () => owned.release(),
      };
    },
  };
  await expect(runWorkflow(root, { stateDir, runId: 'disk', input: null, store })).rejects.toThrow(
    'work failed',
  );
  expect(refused).toBe(1);
  const saved = await readRun({ stateDir, runId: 'disk' });
  expect(saved.children?.['child']).toMatchObject({ status: 'failed', error: 'work failed' });
  expect(saved.children?.['child']).not.toHaveProperty('settled');
});

it('reruns a settled frame body in a fork, reusing owned steps unless invalidated', async () => {
  let effects = 0;
  let value = 'first';
  let broken = false;
  let bodies = 0;
  const child = defineWorkflow({
    name: 'worker',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      bodies++;
      return ctx.step('work', {
        input: null,
        schema: z.string(),
        run: () => {
          effects++;
          if (broken) throw new Error('work failed');
          return value;
        },
      });
    },
  });
  let tail = true;
  const root = defineWorkflow({
    name: 'root',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.workflow('child', child, null, { onError: 'return' });
      if (tail) throw new Error('tail');
      return result.ok ? result.value : `failed:${result.error.message}`;
    },
  });
  await expect(runWorkflow(root, { stateDir, runId: 'source', input: null })).rejects.toThrow(
    'tail',
  );
  tail = false;
  value = 'second';
  const fork = await runWorkflow(root, {
    stateDir,
    runId: 'fork',
    forkFrom: { runId: 'source' },
  });
  expect(fork.output).toBe('first');
  expect(bodies).toBe(2);
  expect(effects).toBe(1);
  expect(fork.steps['child/work']?.reusedFrom).toMatchObject({ runId: 'source' });
  expect(fork.children?.['child']?.settled).toEqual({
    outcome: { ok: true, value: 'first' },
    steps: ['child/work'],
    maps: [],
    children: [],
  });
  const invalidated = await runWorkflow(root, {
    stateDir,
    runId: 'invalidated',
    forkFrom: { runId: 'source', invalidate: ['child/work'] },
  });
  expect(invalidated.output).toBe('second');
  expect(effects).toBe(2);
  expect(invalidated.steps['child/work']?.reusedFrom).toBeUndefined();
  expect(invalidated.children?.['child']?.settled?.outcome).toEqual({ ok: true, value: 'second' });

  // A plain failed step owned by a settled-failed frame is not terminal, so a fork re-executes it.
  broken = true;
  tail = true;
  await expect(runWorkflow(root, { stateDir, runId: 'failed', input: null })).rejects.toThrow(
    'tail',
  );
  expect(effects).toBe(3);
  broken = false;
  tail = false;
  const healed = await runWorkflow(root, {
    stateDir,
    runId: 'healed',
    forkFrom: { runId: 'failed' },
  });
  expect(effects).toBe(4);
  expect(healed.output).toBe('second');
  expect(healed.children?.['child']).toMatchObject({
    status: 'completed',
    settled: { outcome: { ok: true } },
  });
});

it('rejects malformed settled frames in the record schema', () => {
  const frame = {
    declared: false,
    label: 'child',
    workflow: { name: 'worker', version: '1' },
    parent: null,
    depth: 1,
    inputDigest: 'a',
    schemaDigest: 'b',
    status: 'failed',
    startedAt: '2026-10-04T00:00:00.000Z',
    finishedAt: '2026-10-04T00:00:01.000Z',
    error: 'work failed',
    onError: 'return',
    settled: {
      outcome: {
        ok: false,
        error: { message: 'work failed', kind: 'unknown', attempts: 1, stepId: 'child/work' },
      },
      steps: ['child/work'],
      maps: [],
      children: [],
    },
  };
  expect(() => {
    validateRecordChange('children', 'child', frame);
  }).not.toThrow();
  for (const malformed of [
    { ...frame, onError: undefined },
    { ...frame, status: 'completed' },
    { ...frame, finishedAt: null },
    {
      ...frame,
      settled: {
        ...frame.settled,
        outcome: { ok: false, error: { ...frame.settled.outcome.error, kind: 'cancelled' } },
      },
    },
    {
      ...frame,
      settled: {
        ...frame.settled,
        outcome: { ok: false, error: { ...frame.settled.outcome.error, attempts: 0 } },
      },
    },
    { ...frame, status: 'failed', settled: { ...frame.settled, outcome: { ok: true, value: 1 } } },
  ])
    expect(() => {
      validateRecordChange('children', 'child', malformed);
    }).toThrow();
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  assertCompleted,
  defineWorkflow,
  listPending,
  readRun,
  runWorkflow,
  writeAnswer,
  z,
  type WorkflowContext,
} from '../src/index.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { selectPendingRows, type PendingGroup } from '../src/workflow/loader/pending-listing.js';
import type { PendingListing, PendingRunState } from '../src/workflow/runtime/wait-model.js';
import { writeRun, type RunRecord } from '../src/workflow/runtime/store.js';

const launcher = ['/x/node', '/y/run.js'];
const stateDir = '/state/runs';
const entrypoint = '/project/gate.workflow.ts';
const queuedDelivery = { state: 'queued', at: '2026-01-01T00:00:00.000Z', by: 'agent:t' } as const;
const noDelivery = { state: 'none', at: null, by: null } as const;

function row(
  runStatus: RunRecord['status'],
  delivery: PendingListing['delivery'],
  stepId = 'gate',
): PendingListing {
  return {
    runId: 'r1',
    stepId,
    runStatus,
    delivery,
    answerCommand: delivery ? ['answer'] : null,
  } as unknown as PendingListing;
}

function group(
  status: RunRecord['status'],
  delivery: PendingListing['delivery'],
  launch: unknown = { entrypoint, tsconfig: null },
): PendingGroup {
  return {
    run: { id: 'r1', status, formatVersion: 7, launch, steps: {} } as unknown as RunRecord,
    pending: [row(status, delivery)],
  };
}

const resumeArgv = [...launcher, 'workflow', 'resume', 'r1', '--state-dir', stateDir];

it('spells runStatus the way the checkpoint does', () => {
  expectTypeOf<PendingRunState['runStatus']>().toEqualTypeOf<RunRecord['status']>();
});

describe('selectPendingRows', () => {
  it.each<
    [
      string,
      RunRecord['status'],
      PendingListing['delivery'],
      { shown: boolean; hiddenByDefault: boolean; next: boolean },
    ]
  >([
    [
      'suspended, unanswered',
      'suspended',
      noDelivery,
      { shown: true, hiddenByDefault: false, next: false },
    ],
    [
      'running, unanswered (a live block-mode question)',
      'running',
      noDelivery,
      { shown: true, hiddenByDefault: false, next: false },
    ],
    [
      'suspended, answer queued',
      'suspended',
      queuedDelivery,
      { shown: false, hiddenByDefault: true, next: true },
    ],
    [
      'failed, unanswered',
      'failed',
      noDelivery,
      { shown: false, hiddenByDefault: true, next: false },
    ],
    [
      'failed, answer queued',
      'failed',
      queuedDelivery,
      { shown: false, hiddenByDefault: true, next: true },
    ],
    [
      'running, answer queued (the owner ingests it)',
      'running',
      queuedDelivery,
      { shown: false, hiddenByDefault: true, next: false },
    ],
    [
      'cancelled, unanswered',
      'cancelled',
      noDelivery,
      { shown: false, hiddenByDefault: true, next: false },
    ],
    [
      'cancelled, answer queued',
      'cancelled',
      queuedDelivery,
      { shown: false, hiddenByDefault: true, next: false },
    ],
    [
      'completed leftover',
      'completed',
      noDelivery,
      { shown: false, hiddenByDefault: true, next: false },
    ],
    [
      'suspended poll or deadline wait',
      'suspended',
      null,
      { shown: true, hiddenByDefault: false, next: false },
    ],
    [
      'failed poll or deadline wait',
      'failed',
      null,
      { shown: false, hiddenByDefault: true, next: false },
    ],
  ])('%s', (_label, status, delivery, expected) => {
    const groups = [group(status, delivery)];
    const defaults = selectPendingRows(groups, { all: false, stateDir, launcher });
    expect(defaults.pending).toHaveLength(expected.shown ? 1 : 0);
    expect(defaults.hidden).toBe(expected.hiddenByDefault ? 1 : 0);
    const all = selectPendingRows(groups, { all: true, stateDir, launcher });
    expect(all.hidden).toBe(0);
    expect(all.pending).toHaveLength(1);
    expect(all.pending[0]).toMatchObject({ runStatus: status, delivery });
    // `next` is the same whether or not the row is filtered.
    const next = all.pending[0]?.next;
    expect(next?.length ?? 0).toBe(expected.next ? 1 : 0);
    if (expected.shown) expect(defaults.pending[0]?.next).toEqual(next);
  });

  it('gives a queued suspended row one resume entry with the recorded launch policy', () => {
    const policy = {
      harness: { kind: 'fixture', fixtures: [{ path: '/p/f.json', sha256: 'a'.repeat(64) }] },
      waitMode: 'block',
    };
    const { pending } = selectPendingRows(
      [group('suspended', queuedDelivery, { entrypoint, tsconfig: null, policy })],
      { all: true, stateDir, launcher },
    );
    expect(pending[0]?.next).toEqual([
      {
        why: 'An answer is queued; resume the run so its owner ingests it.',
        argv: [...resumeArgv, '--harness', 'fixture:/p/f.json', '--wait-mode', 'block'],
      },
    ]);
  });

  it('gives a queued row of an embedded run (no launch metadata) no next entry', () => {
    const { pending } = selectPendingRows([group('suspended', queuedDelivery, null)], {
      all: true,
      stateDir,
      launcher,
    });
    expect(pending[0]?.next).toEqual([]);
  });

  it('counts hidden rows across runs and keeps the group order', () => {
    const groups = [
      group('suspended', noDelivery),
      group('failed', noDelivery),
      {
        run: group('suspended', queuedDelivery).run,
        pending: [row('suspended', queuedDelivery, 'a'), row('suspended', noDelivery, 'b')],
      },
    ];
    const selection = selectPendingRows(groups, { all: false, stateDir, launcher });
    expect(selection.pending.map((r) => r.stepId)).toEqual(['gate', 'b']);
    expect(selection.hidden).toBe(2);
    expect(selectPendingRows([], { all: false, stateDir, launcher })).toEqual({
      pending: [],
      hidden: 0,
    });
  });
});

describe('workflow.pending through the executor', () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), 'choir-pending-listing-'));
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });
  const ask = (name: string) =>
    defineWorkflow({
      name,
      version: '1',
      input: z.null(),
      output: z.string(),
      run: (ctx: WorkflowContext) => ctx.ask('gate', { prompt: 'Ship?', schema: z.string() }),
    });
  const pending = (all?: boolean) =>
    new WorkflowExecutor({ logger: { log: () => undefined }, commandLauncher: launcher }).execute({
      kind: 'workflow.pending',
      stateDir: runs,
      ...(all === undefined ? {} : { all }),
    });

  it('hides failed, cancelled and completed runs by default and shows them under all', async () => {
    const launch = { entrypoint, tsconfig: null };
    for (const id of ['live', 'failed', 'cancelled', 'completed', 'queued'])
      await runWorkflow(ask(id), { stateDir: runs, runId: id, input: null, launch });
    for (const status of ['failed', 'cancelled', 'completed'] as const) {
      const record = await readRun({ stateDir: runs, runId: status });
      await writeRun(runs, { ...record, status });
    }
    await writeAnswer({
      stateDir: runs,
      runId: 'queued',
      stepId: 'gate',
      value: 'ship',
      by: 'agent:t',
    });

    const defaults = await pending();
    if (defaults.kind !== 'workflow.pending.result') throw new Error('Expected a pending result.');
    expect(defaults.pending.map((r) => [r.runId, r.runStatus])).toEqual([['live', 'suspended']]);
    expect(defaults.hidden).toBe(4);

    const all = await pending(true);
    if (all.kind !== 'workflow.pending.result') throw new Error('Expected a pending result.');
    expect(all.hidden).toBe(0);
    expect(new Map(all.pending.map((r) => [r.runId, r.runStatus]))).toEqual(
      new Map([
        ['live', 'suspended'],
        ['failed', 'failed'],
        ['cancelled', 'cancelled'],
        ['completed', 'completed'],
        ['queued', 'suspended'],
      ]),
    );
    const queued = all.pending.find((r) => r.runId === 'queued');
    expect(queued?.delivery).toMatchObject({ state: 'queued', by: 'agent:t' });
    expect(queued?.next[0]?.argv).toEqual([
      ...launcher,
      'workflow',
      'resume',
      'queued',
      '--state-dir',
      runs,
    ]);
    // A failed run's queued row would be resumable; an unanswered one has no next entry.
    expect(all.pending.find((r) => r.runId === 'failed')?.next).toEqual([]);
  });

  it('lists a block-mode running run with an unanswered question by default', async () => {
    const options = { stateDir: runs, runId: 'blocked', input: null, waitMode: 'block' as const };
    const running = runWorkflow(ask('blocked'), options);
    try {
      let rows = await listPending({ stateDir: runs });
      for (let tries = 0; !rows.length && tries < 400; tries++) {
        await delay(25);
        rows = await listPending({ stateDir: runs });
      }
      expect(rows).toHaveLength(1);
      const listed = await pending();
      if (listed.kind !== 'workflow.pending.result') throw new Error('Expected a pending result.');
      expect(listed.hidden).toBe(0);
      expect(listed.pending).toHaveLength(1);
      expect(listed.pending[0]).toMatchObject({
        runId: 'blocked',
        stepId: 'gate',
        runStatus: 'running',
        delivery: { state: 'none', at: null, by: null },
        next: [],
      });
    } finally {
      await writeAnswer({ ...options, stepId: 'gate', value: 'ship' }).catch(() => undefined);
    }
    const result = await running;
    assertCompleted(result);
    expect(result.output).toBe('ship');
  });
});

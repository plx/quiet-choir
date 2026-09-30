import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineWorkflow, runWorkflow, z, type RunRecord, type RunOwnership } from '../src/index.js';
import { inspectRun, listRuns, summarizeRun, watchRun } from '../src/workflow/loader/inspection.js';
import {
  formatRunList,
  formatRunSummary,
  parseWatchInterval,
  watchExitCodes,
} from '../src/cli/inspection-view.js';
import * as store from '../src/workflow/runtime/store.js';

vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, inspectRunOwnership: vi.fn(actual.inspectRunOwnership) };
});
const actualStore = await vi.importActual<typeof store>('../src/workflow/runtime/store.js');

let stateDir: string;
const unlocked: RunOwnership = { locked: false, owner: null, processes: [], locks: [] };
const time = '2026-01-01T00:00:00.000Z';
const record = (id = 'run'): RunRecord => ({
  formatVersion: 1,
  id,
  workflow: { name: 'example', version: '1', fingerprint: null },
  status: 'running',
  cwd: '/',
  input: null,
  output: null,
  error: null,
  steps: {},
  createdAt: time,
  updatedAt: time,
});
async function save(run: RunRecord) {
  // Replace atomically like the runtime, so a concurrent watch poll never reads a partial file.
  const path = join(stateDir, `${run.id}.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(run));
  await rename(`${path}.tmp`, path);
}
async function lock(runId: string, pid = process.pid, host = hostname()) {
  const path = join(stateDir, `${runId}.json.lock`);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'owner.json'), JSON.stringify({ pid, host, token: 'test' }));
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-inspection-'));
  vi.mocked(store.inspectRunOwnership).mockImplementation(actualStore.inspectRunOwnership);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('shows all status counts, first-use order, phase progress, limits, root cause, and reported usage', async () => {
  const definition = defineWorkflow({
    name: 'inspect',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      ctx.phase('verify', { total: 3 });
      ctx.log('starting', { count: 3 });
      await ctx.claude.text('z-first', { prompt: 'first' });
      await ctx.codex.text('b-settled', { prompt: 'failure', onError: 'return' });
      await ctx.step('a-root', {
        input: null,
        schema: z.null(),
        run() {
          throw new Error('root issue');
        },
      });
      return null;
    },
  });
  await expect(
    runWorkflow(definition, {
      stateDir,
      runId: 'run',
      input: null,
      harness: {
        invoke: (request) => {
          if (request.harness === 'codex') throw new Error('handled');
          return Promise.resolve({
            text: 'done',
            sessionId: null,
            usage: { inputTokens: 12, outputTokens: 2, costUsd: null },
          });
        },
      },
    }),
  ).rejects.toThrow('root issue');
  const { summary } = await inspectRun({ stateDir, runId: 'run' });
  expect(summary.counts).toEqual({
    total: 3,
    completed: 1,
    'settled-failed': 1,
    failed: 1,
    cancelled: 0,
    running: 0,
    superseded: 0,
    waiting: 0,
    withdrawn: 0,
  });
  expect(summary.phase).toEqual({ title: 'verify', total: 3, completed: 1, running: 0 });
  expect(summary.steps.map((step) => step.id)).toEqual(['b-settled', 'a-root']);
  expect(summary.steps[1]?.rootCause).toBe(true);
  expect(summary.usage).toMatchObject({
    attempts: 2,
    incompleteAttempts: 2,
    inputTokens: 12,
    outputTokens: 2,
    costUsd: null,
  });
  const text = formatRunSummary(summary, true);
  expect(text).toContain('Phase: verify 1/3 (0 running)');
  expect(text).toContain('Root cause (a-root): root issue');
  expect(text).toContain('per-call timeout 5m00s');
  expect(text).toContain('partial; 2/2 attempts missing usage');
  expect(text).toContain('inspection.test.ts');
  expect(text).not.toMatch(/^null$/m);
  expect(formatRunList([summary])).toContain('inspect@1  failed');
});

it('shows an interrupted suspension as resumable and watches it as suspended', () => {
  const run: RunRecord = {
    ...record(),
    status: 'suspended',
    nextWakeAt: Date.parse(time),
    interruptedBy: { reason: 'Tick timeout reached.', at: time },
  };
  const summary = summarizeRun(run, unlocked);
  expect(summary).toMatchObject({
    status: 'suspended',
    interruptedBy: { reason: 'Tick timeout reached.', at: time },
  });
  expect(formatRunSummary(summary)).toContain(
    `Interrupted at ${time}: Tick timeout reached. (resumable)`,
  );
  expect(watchExitCodes[summary.status]).toBe(75);
  expect(summarizeRun(record(), unlocked).interruptedBy).toBeNull();
  expect(formatRunSummary(summarizeRun(record(), unlocked))).not.toContain('Interrupted at');
});

it('derives stale only from proven owner loss, preserving unknown and remote owners', () => {
  const run = record();
  expect(summarizeRun(run, unlocked).status).toBe('stale');
  for (const state of ['alive', 'dead', 'unknown', 'remote', 'released'] as const) {
    expect(
      summarizeRun(run, {
        locked: true,
        owner: { pid: 10, host: 'h', state },
        processes: [],
        locks: [],
      }).status,
    ).toBe(['dead', 'released'].includes(state) ? 'stale' : 'running');
  }
  expect(
    summarizeRun(run, {
      locked: true,
      owner: null,
      processes: [],
      warning: 'incomplete',
      locks: [],
    }).status,
  ).toBe('running');
  run.status = 'completed';
  expect(summarizeRun(run, unlocked).status).toBe('completed');
});

it('prints one line per lock with its owner, recovery marker and warning', () => {
  const ownership: RunOwnership = {
    locked: true,
    owner: { pid: 10, host: 'h', state: 'dead' },
    processes: [],
    locks: [
      {
        kind: 'primary',
        path: '/state/run/lock',
        owner: { pid: 10, host: 'h', state: 'dead' },
        recovery: { pid: 11, host: 'h', state: 'alive' },
      },
      {
        kind: 'guard',
        path: '/state/run.json.lock',
        owner: null,
        recovery: null,
        warning: 'owner.json: bad JSON',
      },
    ],
  };
  const summary = summarizeRun(record(), ownership);
  // A live recoverer holds the run, so it is not stale.
  expect(summary.status).toBe('running');
  const text = formatRunSummary(summary);
  expect(text).toContain('Owner: pid 10 (dead) on h');
  expect(text).toContain(
    'Lock primary /state/run/lock: owner pid 10 (dead) on h; recovery pid 11 (alive) on h',
  );
  expect(text).toContain(
    'Lock guard /state/run.json.lock: owner unreadable; warning: owner.json: bad JSON',
  );
  expect(formatRunSummary(summarizeRun(record(), unlocked))).not.toContain('Lock ');
});

it('adopts a checkpoint that completed between the record read and the ownership read, instead of reporting stale', async () => {
  // Simulates the race from the review thread: the owner commits its terminal checkpoint and
  // releases the lock while inspectRun is between reading the checkpoint and reading ownership.
  // The first ownership read still observes "no lock" (that part of the race already happened),
  // but by the time it returns, the checkpoint on disk is already the terminal one; inspectRun
  // must re-read and adopt it rather than trust the now-stale in-memory snapshot.
  const completeCheckpoint = async (id: string) => {
    const run = record(id);
    run.status = 'completed';
    run.updatedAt = '2026-01-01T00:00:05.000Z';
    await save(run);
  };

  await save(record('race'));
  vi.mocked(store.inspectRunOwnership).mockImplementationOnce(async () => {
    await completeCheckpoint('race');
    return { locked: false, owner: null, processes: [], locks: [] };
  });
  const inspection = await inspectRun({ stateDir, runId: 'race' });
  expect(inspection.summary.status).toBe('completed');
  expect(inspection.summary.recordedStatus).toBe('completed');
  expect(store.inspectRunOwnership).toHaveBeenCalledTimes(2);

  await save(record('race-watch'));
  vi.mocked(store.inspectRunOwnership).mockImplementationOnce(async () => {
    await completeCheckpoint('race-watch');
    return { locked: false, owner: null, processes: [], locks: [] };
  });
  const changes: string[] = [];
  const final = await watchRun({ stateDir, runId: 'race-watch', intervalMs: 5 }, (snapshot) => {
    changes.push(snapshot.summary.status);
  });
  expect(final.summary.status).toBe('completed');
  expect(changes).toEqual(['completed']);
  expect(watchExitCodes.completed).toBe(0);
});

it('lists newest first, filters stale/cancelled, skips unreadable files, and never changes records', async () => {
  const old = record('old');
  old.status = 'completed';
  const fresh = record('fresh');
  fresh.updatedAt = '2026-02-01T00:00:00.000Z';
  const cancelled = record('cancelled');
  cancelled.status = 'cancelled';
  await Promise.all([
    save(old),
    save(fresh),
    save(cancelled),
    writeFile(join(stateDir, 'bad.json'), '{bad'),
    writeFile(join(stateDir, 'ignored.tmp'), 'ignored'),
  ]);
  const before = await readFile(join(stateDir, 'fresh.json'), 'utf8');
  const all = await listRuns({ stateDir });
  expect(all.runs.map((run) => run.id)).toEqual(['fresh', 'cancelled', 'old']);
  expect(all.warnings).toHaveLength(1);
  expect(all.warnings[0]).toContain('Skipped bad');
  expect((await listRuns({ stateDir, status: 'stale' })).runs.map((run) => run.id)).toEqual([
    'fresh',
  ]);
  expect((await listRuns({ stateDir, status: 'cancelled' })).runs.map((run) => run.id)).toEqual([
    'cancelled',
  ]);
  expect((await listRuns({ stateDir: join(stateDir, 'missing') })).runs).toEqual([]);
  expect(await readFile(join(stateDir, 'fresh.json'), 'utf8')).toBe(before);
  expect(formatRunList([])).toBe('No runs found.');
});

it('watches only actual changes and stops after completion with one final snapshot', async () => {
  const run = record();
  await save(run);
  await lock('run');
  const changes: string[] = [];
  const watching = watchRun({ stateDir, runId: 'run', intervalMs: 5 }, (snapshot) => {
    changes.push(snapshot.summary.status);
  });
  // Wait for the first snapshot, then let several polls pass: none may report an unchanged run.
  await vi.waitFor(() => {
    expect(changes).toEqual(['running']);
  });
  await delay(35);
  expect(changes).toEqual(['running']);
  run.status = 'completed';
  run.updatedAt = '2026-02-01T00:00:00.000Z';
  await save(run);
  const final = await watching;
  expect(final.summary.status).toBe('completed');
  expect(changes).toEqual(['running', 'completed']);
});

it('stops on owner loss even when checkpoint bytes do not change, but interruption never mutates the run', async () => {
  const run = record();
  await save(run);
  await lock('run');
  const changed: string[] = [];
  const watching = watchRun({ stateDir, runId: 'run', intervalMs: 5 }, (snapshot) => {
    changed.push(snapshot.summary.status);
  });
  await vi.waitFor(() => {
    expect(changed).toEqual(['running']);
  });
  await delay(20);
  // Lose the owner atomically: a recursive rm briefly exposes an owner-less lock, a real change.
  await rename(join(stateDir, 'run.json.lock'), join(stateDir, 'released.lock'));
  expect((await watching).summary.status).toBe('stale');
  expect(changed).toEqual(['running', 'stale']);
  await lock('run', process.pid, 'remote-host');
  const bytes = await readFile(join(stateDir, 'run.json'), 'utf8');
  const signal = new AbortController();
  const remote = watchRun(
    { stateDir, runId: 'run', intervalMs: 5 },
    () => {
      signal.abort(new Error('stop observing'));
    },
    signal.signal,
  );
  await expect(remote).rejects.toThrow();
  expect(await readFile(join(stateDir, 'run.json'), 'utf8')).toBe(bytes);
});

it('sums legacy usage without double counting failed attempts or imported fork results', () => {
  const run = record();
  const step = {
    kind: 'claude' as const,
    fingerprint: 'f',
    status: 'completed' as const,
    attempts: 2,
    error: null,
    wakeAt: null,
    failedAttempts: [
      { attempt: 1, sessionId: null, usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.1 } },
    ],
    output: { usage: { inputTokens: 4, outputTokens: 3, costUsd: 0.2 } },
  };
  run.steps = {
    legacy: step,
    reused: {
      ...step,
      reusedFrom: { runId: 'source', stateDir: '/', stepId: 'legacy', fingerprint: 'f', at: time },
    },
  };
  expect(summarizeRun(run, unlocked).usage).toMatchObject({
    attempts: 2,
    incompleteAttempts: 0,
    undercounted: true,
    legacyAttempts: 2,
    inputTokens: 6,
    outputTokens: 4,
  });
  expect(summarizeRun(run, unlocked).usage.costUsd).toBeCloseTo(0.3);
  expect(summarizeRun(record(), unlocked).usage).toMatchObject({
    attempts: 0,
    incompleteAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
});

it.each(['0s', '-1s', '1', 'NaNs', '1.1ms', '9999999999m'])(
  'rejects invalid interval %s',
  (value) => {
    expect(() => parseWatchInterval(value)).toThrow('Watch interval');
  },
);
it('supports bounded intervals and stable terminal watch exits', async () => {
  expect(parseWatchInterval('250ms')).toBe(250);
  expect(parseWatchInterval('0.5s')).toBe(500);
  expect(parseWatchInterval('2m')).toBe(120000);
  expect(watchExitCodes).toMatchObject({ completed: 0, failed: 1, cancelled: 130, stale: 3 });
  await expect(watchRun({ stateDir, runId: 'run', intervalMs: 0 }, vi.fn())).rejects.toThrow(
    'Watch interval',
  );
});

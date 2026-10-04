import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CliHarness,
  defineWorkflow,
  runWorkflow,
  z,
  type AttemptRecord,
  type ExecSummary,
  type RunRecord,
  type RunOwnership,
  type StepRecord,
} from '../src/index.js';
import {
  inspectRun,
  listRuns,
  maxAgentRowWarningChars,
  maxAgentRowWarnings,
  summarizeRun,
  toRunListRow,
  WatchBoundError,
  watchRun,
} from '../src/workflow/loader/inspection.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { fileURLToPath } from 'node:url';
import { maxRateLimitText, maxRateLimitWindows } from '../src/workflow/runtime/rate-limit.js';
import {
  formatBytes,
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
  expect(summary.steps.map((step) => step.errorKind)).toEqual(['unknown', 'unknown']);
  expect(summary.rootCause).toEqual({
    stepId: 'a-root',
    error: 'root issue',
    errorKind: 'unknown',
  });
  expect(summary.usage).toMatchObject({
    attempts: 2,
    incompleteAttempts: 2,
    inputTokens: 12,
    outputTokens: 2,
    costUsd: null,
  });
  const text = formatRunSummary(summary, true);
  expect(text).toContain('Phase: verify 1/3 (0 running)');
  expect(text).toContain('Root cause (a-root, unknown): root issue');
  expect(text).toMatch(/^failed a-root .* \[unknown\] \[root cause\]/mu);
  expect(text).toContain('per-call timeout 5m00s');
  expect(text).toContain('partial; 1/2 attempts without token usage; cost unreported for 2/2');
  expect(text).toContain('inspection.test.ts');
  expect(text).not.toMatch(/^null$/m);
  expect(formatRunList([summary])).toContain('inspect@1  failed');
});

it('carries the last attempt kind on failed, settled-failed and cancelled step rows only', () => {
  const failed = (
    status: StepRecord['status'],
    kinds: NonNullable<AttemptRecord['errorKind']>[],
  ): StepRecord => ({
    kind: 'agent',
    harness: 'claude',
    fingerprint: 'f',
    status,
    attempts: kinds.length || 1,
    output: null,
    error: status === 'completed' || status === 'running' ? null : 'failed',
    wakeAt: null,
    ...(kinds.length
      ? {
          attemptHistory: kinds.map((errorKind, index) => ({
            attempt: index + 1,
            status: 'failed',
            errorKind,
          })) as unknown as AttemptRecord[],
        }
      : {}),
  });
  const run: RunRecord = {
    ...record(),
    status: 'failed',
    steps: {
      done: failed('completed', []),
      busy: failed('failed', ['unknown', 'overloaded']),
      handled: failed('settled-failed', ['rate-limit']),
      sibling: failed('cancelled', ['cancelled']),
      active: failed('running', ['timeout']),
      fresh: failed('running', []),
    },
    rootCause: { stepId: 'busy', error: 'failed', errorKind: 'overloaded' },
  };
  const summary = summarizeRun(run, unlocked);
  expect(Object.fromEntries(summary.steps.map((step) => [step.id, step.errorKind]))).toEqual({
    busy: 'overloaded',
    handled: 'rate-limit',
    sibling: 'cancelled',
    // A running retry has the previous attempt's kind; a step with no attempt has none.
    active: 'timeout',
    fresh: null,
  });
  const text = formatRunSummary(summary, true);
  expect(text).toContain('[overloaded] [root cause]');
  expect(text).toContain('Root cause (busy, overloaded): failed');
});

it('normalizes the root cause of a record without a stored kind from the root step', () => {
  const run: RunRecord = {
    ...record(),
    status: 'failed',
    steps: {
      ask: {
        kind: 'agent',
        harness: 'claude',
        fingerprint: 'f',
        status: 'failed',
        attempts: 1,
        output: null,
        error: 'denied',
        wakeAt: null,
        attemptHistory: [
          { attempt: 1, status: 'failed', errorKind: 'authentication' },
        ] as unknown as AttemptRecord[],
      },
    },
    rootCause: { stepId: 'ask', error: 'denied' },
  };
  expect(summarizeRun(run, unlocked).rootCause).toEqual({
    stepId: 'ask',
    error: 'denied',
    errorKind: 'authentication',
  });
  expect(
    summarizeRun({ ...run, rootCause: { stepId: null, error: 'bug' } }, unlocked).rootCause,
  ).toEqual({ stepId: null, error: 'bug', errorKind: null });
  expect(summarizeRun(record(), unlocked).rootCause).toBeNull();
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

it('summarizes the latest accepted code changes and names map entries', () => {
  const change = (n: number) => ({
    at: time,
    from: `old-${String(n)}`,
    to: `new-${String(n)}`,
    files: ['workflow.ts', 'helper.ts'],
    components: ['code'],
  });
  const map = {
    at: time,
    from: 'map-old',
    to: 'map-new',
    files: [],
    components: ['mapper'],
    map: 'tickets',
  };
  const run: RunRecord = {
    ...record(),
    codeChanges: [change(1), change(2), change(3), change(4), change(5), map],
  };
  const summary = summarizeRun(run, unlocked);
  expect(summary.codeChanges).toEqual([change(2), change(3), change(4), change(5), map]);
  const text = formatRunSummary(summary);
  expect(text).toContain(`Code change accepted at ${time}: mapper in map tickets`);
  expect(text).toContain(`Code change accepted at ${time}: code (2 files)`);
  expect(text.split('Code change accepted').length - 1).toBe(5);
  expect(summarizeRun(record(), unlocked).codeChanges).toEqual([]);
  expect(formatRunSummary(summarizeRun(record(), unlocked))).not.toContain('Code change');
});

it('shows a superseded child frame as its own status in the workflow tree and JSON summary', () => {
  const run: RunRecord = {
    ...record(),
    status: 'completed',
    children: {
      kid: {
        declared: false,
        label: 'kid',
        workflow: { name: 'kid', version: '1' },
        parent: null,
        depth: 1,
        inputDigest: 'input',
        schemaDigest: 'schema',
        status: 'superseded',
        startedAt: time,
        finishedAt: time,
        error: 'kid broke',
      },
    },
  };
  const summary = summarizeRun(run, unlocked);
  expect(
    (JSON.parse(JSON.stringify(summary)) as { children: { id: string; status: string }[] })
      .children,
  ).toMatchObject([{ id: 'kid', status: 'superseded', error: 'kid broke' }]);
  const tree = formatRunSummary(summary)
    .split('\n')
    .find((line) => line.includes('[kid]'));
  expect(tree).toContain('kid: kid@1 superseded;');
  expect(tree).not.toMatch(/failed|cancelled/u);
});

it('derives stale only from proven owner loss, preserving unknown and remote owners', () => {
  const run = record();
  expect(summarizeRun(run, unlocked).status).toBe('stale');
  for (const state of ['alive', 'dead', 'unknown', 'remote', 'released'] as const) {
    expect(
      summarizeRun(run, {
        locked: true,
        owner: { pid: 10, host: 'h', state, osStartTime: null },
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
    owner: { pid: 10, host: 'h', state: 'dead', osStartTime: null },
    processes: [],
    locks: [
      {
        kind: 'primary',
        path: '/state/run/lock',
        owner: { pid: 10, host: 'h', state: 'dead', osStartTime: null },
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
  expect(watchExitCodes).toStrictEqual({
    completed: 0,
    suspended: 75,
    failed: 1,
    cancelled: 130,
    stale: 3,
    running: 0,
  });
  await expect(watchRun({ stateDir, runId: 'run', intervalMs: 0 }, vi.fn())).rejects.toThrow(
    'Watch interval',
  );
  await expect(
    watchRun({ stateDir, runId: 'run', intervalMs: 5, timeoutMs: 0 }, vi.fn()),
  ).rejects.toThrow('Watch timeout');
  await expect(
    watchRun({ stateDir, runId: 'run', intervalMs: 5, waitCreatedMs: 1.5 }, vi.fn()),
  ).rejects.toThrow('Watch wait-created');
});

it('waits for a record created after the watch starts, only while waitCreatedMs is set', async () => {
  const changes: string[] = [];
  const watching = watchRun(
    { stateDir, runId: 'late', intervalMs: 5, waitCreatedMs: 5000 },
    (snapshot) => {
      changes.push(snapshot.summary.status);
    },
  );
  await delay(30);
  await save({ ...record('late'), status: 'completed' });
  expect((await watching).summary.status).toBe('completed');
  expect(changes).toEqual(['completed']);

  const missing: unknown = await watchRun(
    { stateDir, runId: 'never', intervalMs: 5, waitCreatedMs: 30 },
    vi.fn(),
  ).catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(WatchBoundError);
  expect(missing).toMatchObject({
    code: 'watch.record_not_created',
    runId: 'never',
    run: null,
    details: { waitCreatedMs: 30 },
    cause: { code: 'run.not_found' },
  });
  expect((missing as Error).message).toMatch(
    /^Run never was not created within 30ms\. Run never not found in /,
  );

  await expect(
    watchRun({ stateDir, runId: 'never', intervalMs: 5 }, vi.fn()),
  ).rejects.toMatchObject({ code: 'run.not_found' });

  // A record that disappears after it was seen is not "not created yet".
  await save(record('vanishing'));
  await lock('vanishing');
  const seen: string[] = [];
  const vanishing = watchRun(
    { stateDir, runId: 'vanishing', intervalMs: 5, waitCreatedMs: 5000 },
    (snapshot) => {
      seen.push(snapshot.summary.status);
    },
  );
  await vi.waitFor(() => {
    expect(seen).toEqual(['running']);
  });
  await rm(join(stateDir, 'vanishing.json'));
  await expect(vanishing).rejects.toMatchObject({ code: 'run.not_found' });
});

it('stops a still-running watch at timeoutMs with the last observed record, and never touches it', async () => {
  await save(record('slow'));
  await lock('slow');
  const bytes = await readFile(join(stateDir, 'slow.json'), 'utf8');
  const changes: string[] = [];
  const timedOut: unknown = await watchRun(
    { stateDir, runId: 'slow', intervalMs: 5, timeoutMs: 40 },
    (snapshot) => {
      changes.push(snapshot.summary.status);
    },
  ).catch((error: unknown) => error);
  expect(timedOut).toBeInstanceOf(WatchBoundError);
  expect(timedOut).toMatchObject({
    code: 'watch.timeout',
    runId: 'slow',
    details: { timeoutMs: 40 },
    run: { id: 'slow', status: 'running' },
  });
  expect(changes).toEqual(['running']);
  expect(await readFile(join(stateDir, 'slow.json'), 'utf8')).toBe(bytes);

  const run = record('quick');
  await save(run);
  await lock('quick');
  const seen: string[] = [];
  const watching = watchRun(
    { stateDir, runId: 'quick', intervalMs: 5, timeoutMs: 5000 },
    (snapshot) => {
      seen.push(snapshot.summary.status);
    },
  );
  await vi.waitFor(() => {
    expect(seen).toEqual(['running']);
  });
  await save({ ...run, status: 'completed', updatedAt: '2026-02-01T00:00:00.000Z' });
  expect((await watching).summary.status).toBe('completed');
  expect(seen).toEqual(['running', 'completed']);
});

it('measures timeoutMs from the first successful read, not from the start of the watch', async () => {
  await lock('created');
  let firstRead: number | undefined;
  const changes: string[] = [];
  const watching = watchRun(
    { stateDir, runId: 'created', intervalMs: 5, waitCreatedMs: 5000, timeoutMs: 50 },
    (snapshot) => {
      firstRead ??= performance.now();
      changes.push(snapshot.summary.status);
    },
  ).catch((error: unknown) => error);
  await delay(100);
  await save(record('created'));
  const failure = await watching;
  const stoppedAt = performance.now();
  expect(failure).toMatchObject({ code: 'watch.timeout', details: { timeoutMs: 50 } });
  expect(changes).toEqual(['running']);
  expect(stoppedAt - (firstRead ?? stoppedAt)).toBeGreaterThanOrEqual(45);
});

it('maps watch bounds to executor failures with the observed run and no re-read', async () => {
  const executor = new WorkflowExecutor({ logger: { log: vi.fn() } });
  const missing = await executor.execute({
    kind: 'workflow.watch',
    runId: 'absent',
    stateDir,
    intervalMs: 5,
    waitCreatedMs: 20,
  });
  expect(missing).toMatchObject({
    ok: false,
    code: 'watch.record_not_created',
    runId: 'absent',
    details: { waitCreatedMs: 20 },
    run: null,
  });
  expect(missing).not.toHaveProperty('next');

  await save(record('busy'));
  await lock('busy');
  const timedOut = await executor.execute({
    kind: 'workflow.watch',
    runId: 'busy',
    stateDir,
    intervalMs: 5,
    timeoutMs: 20,
  });
  expect(timedOut).toMatchObject({
    ok: false,
    code: 'watch.timeout',
    details: { timeoutMs: 20 },
    run: { id: 'busy', status: 'running' },
  });

  // An interrupt still wins over a bound in flight.
  const controller = new AbortController();
  const interrupted = new WorkflowExecutor({
    logger: { log: vi.fn() },
    signal: controller.signal,
  }).execute({
    kind: 'workflow.watch',
    runId: 'absent',
    stateDir,
    intervalMs: 5,
    waitCreatedMs: 5000,
  });
  await delay(20);
  controller.abort(new Error('stop'));
  expect(await interrupted).toMatchObject({ ok: false, code: 'workflow.interrupted', run: null });
});

const iso = (seconds: number): string => new Date(Date.parse(time) + seconds * 1000).toISOString();

function baseStep(overrides: Partial<StepRecord>): StepRecord {
  return {
    kind: 'step',
    fingerprint: 'f',
    status: 'completed',
    attempts: 1,
    output: null,
    error: null,
    wakeAt: null,
    ...overrides,
  };
}

function execStep(
  seq: number,
  command: ExecSummary['command'],
  overrides: Partial<StepRecord> = {},
): StepRecord {
  return baseStep({
    kind: 'exec',
    seq,
    startedAt: iso(seq),
    finishedAt: iso(seq + 2),
    durationMs: 2000,
    exec: {
      command,
      cwd: '/Users/someone/work/a-long-project-directory/packages/service',
      envSha256: '0'.repeat(64),
      inheritEnv: true,
      inputSha256: '1'.repeat(64),
      okExitCodes: [0],
      structured: false,
    },
    ...overrides,
  });
}

interface AgentFixture {
  readonly harness: 'claude' | 'codex';
  readonly model: string | null;
  readonly effort?: string;
  readonly profile?: string;
  readonly costUsd?: number | null;
  readonly status?: StepRecord['status'];
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  /** Native diagnostics of the attempt, such as a `rateLimit` report. */
  readonly diagnostics?: Record<string, unknown>;
}

function agentStep(seq: number, fixture: AgentFixture): StepRecord {
  const { harness, model, effort, profile, status = 'completed' } = fixture;
  return baseStep({
    kind: harness,
    seq,
    status,
    startedAt: iso(seq),
    finishedAt: status === 'running' ? null : iso(seq + 12),
    durationMs: status === 'running' ? null : 12_000,
    request: {
      harness,
      model,
      profile: profile ?? null,
      limits: {
        timeoutMs: null,
        maxTurns: null,
        maxBudgetUsd: null,
        sandbox: null,
        killGraceMs: null,
      },
      tools: null,
      cwd: '/',
      structured: false,
      promptSha256: '2'.repeat(64),
      promptPreview: 'prompt',
    },
    attemptHistory: [
      {
        attempt: 1,
        fingerprint: 'f',
        startedAt: iso(seq),
        finishedAt: iso(seq + 12),
        status: status === 'running' ? 'running' : 'completed',
        error: null,
        requestedModel: model,
        effort: null,
        ...(fixture.diagnostics === undefined ? {} : { diagnostics: fixture.diagnostics }),
        ...(effort === undefined ? {} : { requested: { model: model ?? 'inherited', effort } }),
        policy: { retry: { maxAttempts: 1, delayMs: 0 } },
        sources: {},
        usage: {
          inputTokens: fixture.inputTokens === undefined ? 1000 : fixture.inputTokens,
          outputTokens: fixture.outputTokens === undefined ? 200 : fixture.outputTokens,
          costUsd: fixture.costUsd === undefined ? 0.0123 : fixture.costUsd,
          tokens: {
            uncachedInput: 100,
            cacheRead: 800,
            cacheWrite: 100,
            output: 200,
            reasoning: 50,
          },
          model: { requested: model, effective: model === null ? null : [model] },
        },
      },
    ] as unknown as AttemptRecord[],
  });
}

function withSteps(
  steps: Record<string, StepRecord>,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return { ...record(), status: 'completed', output: { done: true }, steps, ...overrides };
}

it('puts the workflow output in the summary only for a completed run', () => {
  const output = { files: ['a.ts'], nested: { ok: true } };
  expect(summarizeRun(withSteps({}, { output }), unlocked).output).toEqual(output);
  for (const status of ['running', 'failed', 'suspended', 'cancelled'] as const)
    expect(
      summarizeRun(withSteps({}, { status, output: { stale: 1 } }), unlocked).output,
    ).toBeNull();
});

it('prints a completed command on one line and keeps full detail for failures and -v', () => {
  const run = withSteps({
    'check/git': execStep(1, ['/usr/bin/git', 'status', '--porcelain']),
    'check/node': execStep(2, ['/usr/local/bin/node', '-e', 'process.exit(0)']),
    'check/path': execStep(3, ['/usr/bin/env', '/opt/tool/bin/run', 'x']),
    'check/shell': execStep(4, {
      shell: `npm test -- --reporter=dot ${'x'.repeat(80)}\nsecond line`,
    }),
    'check/fail': execStep(5, ['/usr/bin/false'], {
      status: 'failed',
      execError: {
        code: 1,
        signal: null,
        stdoutTail: '',
        stderrTail: 'diagnostic',
        truncated: false,
        durationMs: 5,
      },
    }),
  });
  const summary = summarizeRun(run, unlocked);
  const text = formatRunSummary(summary);
  expect(text).toMatch(/^completed check\/git {2}git status {2}2s$/m);
  expect(text).toMatch(/^completed check\/node {2}node {2}2s$/m);
  expect(text).toMatch(/^completed check\/path {2}env {2}2s$/m);
  expect(text).toMatch(/^completed check\/shell {2}\[SHELL\] npm test .{40,}… {2}2s$/m);
  expect(text).not.toContain('second line');
  expect(text).not.toContain('/usr/bin/git');
  expect(text).not.toContain('a-long-project-directory/packages/service) completed');
  // A failed command keeps argv, cwd, and the stderr tail.
  expect(text).toContain('Command check/fail [argv]: ["/usr/bin/false"]');
  expect(text).toContain('stderr tail: "diagnostic"');
  expect(text).toMatch(/^failed check\/fail /m);
  const verbose = formatRunSummary(summary, true);
  expect(verbose).toContain(
    'Command check/git [argv]: ["/usr/bin/git","status","--porcelain"] (cwd /Users/someone/work/a-long-project-directory/packages/service)',
  );
  expect(verbose).toMatch(/^completed check\/git {2}exec {2}2s elapsed/m);
});

function reviewRun(): RunRecord {
  const steps: Record<string, StepRecord> = {};
  let seq = 0;
  for (let i = 0; i < 20; i++)
    steps[`build/command-${String(i)}`] = execStep(++seq, [
      '/usr/local/bin/npm',
      'run',
      'lint',
    ] as const);
  for (let i = 0; i < 8; i++)
    steps[`review/scan-${String(i)}`] = agentStep(++seq, {
      harness: 'claude',
      model: 'sonnet',
      effort: 'high',
      profile: 'reviewer',
    });
  for (let i = 0; i < 9; i++)
    steps[`review/verify-${String(i)}`] = agentStep(++seq, {
      harness: 'codex',
      model: null,
      effort: 'inherited',
    });
  steps['review/escalated'] = agentStep(seq + 1, {
    harness: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    costUsd: 0.2,
  });
  return withSteps(steps);
}

it('lists every agent tier compactly on a 38-step review-style run, under 3 KB', () => {
  const summary = summarizeRun(reviewRun(), unlocked);
  expect(summary.counts.total).toBe(38);
  const text = formatRunSummary(summary);
  expect(text).toContain('Agents: 18 steps');
  expect(text).toMatch(/^ {2}claude sonnet effort high profile reviewer: 8 steps, \$0\.0984$/m);
  expect(text).toMatch(/^review\/escalated {2}codex gpt-5\.4 effort high {2}12s {2}\$0\.2000$/m);
  expect(Buffer.byteLength(text)).toBeLessThan(3072);
});

it('keeps agent summaries bounded: 40 calls under 10 KB of JSON, recent capped at 50', () => {
  const forty: Record<string, StepRecord> = {};
  for (let i = 0; i < 40; i++)
    forty[`agent/${String(i).padStart(2, '0')}`] = agentStep(i + 1, {
      harness: i % 2 ? 'codex' : 'claude',
      model: i % 2 ? 'gpt-5.4' : 'sonnet',
      effort: 'high',
    });
  expect(Buffer.byteLength(JSON.stringify(summarizeRun(withSteps(forty), unlocked)))).toBeLessThan(
    10_240,
  );

  const sixty: Record<string, StepRecord> = {};
  for (let i = 0; i < 60; i++)
    sixty[`agent/${String(i).padStart(2, '0')}`] = agentStep(i + 1, {
      harness: i % 3 === 0 ? 'codex' : 'claude',
      model: i % 3 === 0 ? 'gpt-5.4' : 'sonnet',
      effort: i % 3 === 0 ? 'high' : 'low',
    });
  const summary = summarizeRun(withSteps(sixty), unlocked);
  expect(summary.agents.total).toBe(60);
  expect(summary.agents.recent).toHaveLength(50);
  expect(summary.agents.recent.map((row) => row.id)).toEqual(
    Array.from({ length: 50 }, (_, i) => `agent/${String(i + 10).padStart(2, '0')}`),
  );
  expect(summary.agents.byRequest.reduce((sum, group) => sum + group.steps, 0)).toBe(60);
  expect(summary.agents.byRequest.map((group) => [group.harness, group.steps])).toEqual([
    ['codex', 20],
    ['claude', 40],
  ]);
  // Text stays bounded for any run size unless -v asks for all recent rows.
  const lines = (text: string) => text.split('\n').filter((line) => line.startsWith('agent/'));
  expect(lines(formatRunSummary(summary))).toHaveLength(20);
  expect(lines(formatRunSummary(summary, true))).toHaveLength(50);
});

it('reports requested model, effort and profile from older and partial records without inventing them', () => {
  const legacy = baseStep({ kind: 'agent', harness: 'custom', seq: 1, attempts: 1 });
  const fork = agentStep(2, { harness: 'claude', model: 'sonnet' });
  const summary = summarizeRun(
    withSteps({
      legacy,
      fork: {
        ...fork,
        reusedFrom: { runId: 'other' } as unknown as NonNullable<StepRecord['reusedFrom']>,
      },
      codex: agentStep(3, { harness: 'codex', model: 'gpt-5.4' }),
    }),
    unlocked,
  );
  expect(summary.agents.total).toBe(2);
  expect(summary.agents.recent).toMatchObject([
    { id: 'legacy', harness: 'custom', model: null, effort: null, profile: null, costUsd: null },
    { id: 'codex', harness: 'codex', model: 'gpt-5.4', effort: null },
  ]);
});

it('says tokens are complete when only cost is missing, and partial when tokens are missing', () => {
  const steps = (specs: AgentFixture[]) =>
    withSteps(
      Object.fromEntries(specs.map((spec, i) => [`agent-${String(i)}`, agentStep(i + 1, spec)])),
    );
  const costOnly = summarizeRun(
    steps([
      { harness: 'claude', model: 'sonnet' },
      { harness: 'claude', model: 'sonnet' },
      { harness: 'claude', model: 'sonnet', costUsd: null },
      { harness: 'claude', model: 'sonnet', costUsd: null },
      { harness: 'claude', model: 'sonnet', costUsd: null },
    ]),
    unlocked,
  );
  const text = formatRunSummary(costOnly);
  expect(text).toContain('tokens complete; cost unreported for 3/5 attempts');
  expect(text).not.toContain('missing usage');
  expect(costOnly.usage).toMatchObject({ incompleteAttempts: 3, unknownTokenAttempts: 0 });

  const noTokens = summarizeRun(
    steps([
      { harness: 'claude', model: 'sonnet' },
      { harness: 'claude', model: 'sonnet', inputTokens: null, costUsd: null },
      { harness: 'claude', model: 'sonnet', outputTokens: null },
    ]),
    unlocked,
  );
  expect(noTokens.usage).toMatchObject({ unknownTokenAttempts: 2, unknownCostAttempts: 1 });
  expect(formatRunSummary(noTokens)).toContain(
    'partial; 2/3 attempts without token usage; cost unreported for 1/3',
  );
  expect(formatRunList([noTokens])).toContain('partial; 2/3 attempts without token usage');
  const complete = formatRunSummary(
    summarizeRun(steps([{ harness: 'claude', model: 'sonnet' }]), unlocked),
  );
  expect(complete).not.toMatch(/partial|unreported/u);
});

it('projects list rows to a bounded, exact key set while the human table keeps its summaries', () => {
  const summaries = Array.from({ length: 10 }, (_, i) =>
    summarizeRun(
      { ...reviewRun(), id: `run-${String(i).padStart(2, '0')}-0123456789abcdef` },
      unlocked,
    ),
  ).map((summary) => ({ ...summary, stateDir: '/Users/someone/.local/state/quiet-choir/proj' }));
  const rows = summaries.map(toRunListRow);
  expect(Buffer.byteLength(JSON.stringify({ runs: rows }))).toBeLessThan(10_240);
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
    [
      'cwd',
      'counts',
      'id',
      'nextWakeAt',
      'ownership',
      'recordedStatus',
      'stateDir',
      'status',
      'updatedAt',
      'usage',
      'warnings',
      'workflow',
    ].sort(),
  );
  expect(Object.keys(rows[0]?.usage ?? {}).sort()).toEqual([
    'attempts',
    'costUsd',
    'inputTokens',
    'outputTokens',
    'unknownCostAttempts',
    'unknownTokenAttempts',
  ]);
  expect(formatRunList(summaries)).toContain('run-00-0123456789abcdef  example@1  completed');
});

it('gives a stale or failed summary a resume next entry and prints it as Next:', async () => {
  const launch = { entrypoint: '/project/example.workflow.ts', tsconfig: null };
  await save({ ...record('stale'), launch });
  const launcher = ['/x/node', '/y/run.js'];
  const resume = (runId: string) => [
    ...launcher,
    'workflow',
    'resume',
    runId,
    '--state-dir',
    stateDir,
  ];
  const stale = await inspectRun({ stateDir, runId: 'stale', commandLauncher: launcher });
  expect(stale.summary.status).toBe('stale');
  expect(stale.summary.next?.map((entry) => entry.argv)).toEqual([resume('stale')]);
  expect(toRunListRow(stale.summary)).not.toHaveProperty('next');
  await save({ ...record('failed'), status: 'failed', error: 'Effect failed.', launch });
  const failed = await inspectRun({ stateDir, runId: 'failed' });
  expect(failed.summary.next?.[0]?.argv).toEqual([
    'quiet-choir',
    'workflow',
    'resume',
    'failed',
    '--state-dir',
    stateDir,
  ]);
  expect(formatRunSummary(failed.summary)).toMatch(
    /^Error: Effect failed\.\nNext: quiet-choir workflow resume failed --state-dir \S+ {2}\(Resume the failed run/mu,
  );
  await save({ ...record('done'), status: 'completed', launch });
  const done = await inspectRun({ stateDir, runId: 'done' });
  expect(done.summary.next).toEqual([]);
  expect(formatRunSummary(done.summary)).not.toContain('Next:');
  const listed = await listRuns({ stateDir, status: 'stale', commandLauncher: launcher });
  expect(listed.runs[0]?.next?.[0]?.argv).toEqual(resume('stale'));
});

it('shows the tool-use count, step warnings and idle deadline of agent calls', () => {
  const warning =
    'no-tool-use: Profile readonly expects tool use, but the claude attempt completed without a tool call.';
  const counted = agentStep(1, { harness: 'claude', model: 'sonnet', effort: 'high' });
  const [attempt] = counted.attemptHistory ?? [];
  if (!attempt) throw new Error('fixture attempt missing');
  const quiet: StepRecord = {
    ...counted,
    warnings: [warning],
    attemptHistory: [{ ...attempt, diagnostics: { toolUses: 0 } }],
  };
  const busy: StepRecord = {
    ...counted,
    seq: 2,
    attemptHistory: [{ ...attempt, diagnostics: { toolUses: 3 } }],
  };
  const legacy = agentStep(3, { harness: 'codex', model: null, effort: 'high' });
  const failed = agentStep(4, { harness: 'codex', model: null, effort: 'high', status: 'failed' });
  if (!failed.request) throw new Error('fixture request missing');
  const stalled: StepRecord = {
    ...failed,
    request: { ...failed.request, limits: { ...failed.request.limits, idleTimeoutMs: 120_000 } },
  };
  const noisy: StepRecord = {
    ...counted,
    seq: 5,
    warnings: [
      ...Array.from({ length: 40 }, (_, index) => `denied-${String(index)}: ${'x'.repeat(5000)}`),
      warning,
    ],
  };
  const summary = summarizeRun(withSteps({ quiet, busy, legacy, stalled, noisy }), unlocked);
  const rows = Object.fromEntries(summary.agents.recent.map((row) => [row.id, row]));
  expect(rows['quiet']).toMatchObject({ toolUses: 0, warnings: [warning] });
  // Verbose warnings are bounded: the count, length and overflow are visible, no-tool-use kept.
  const bounded = rows['noisy']?.warnings ?? [];
  expect(bounded).toHaveLength(maxAgentRowWarnings + 1);
  expect(bounded.slice(0, -1).every((entry) => entry.length <= maxAgentRowWarningChars)).toBe(true);
  expect(bounded.at(-1)).toBe(`+${String(41 - maxAgentRowWarnings)} more warnings`);
  expect(bounded).toContain(warning);
  expect(bounded[0]).toMatch(/^denied-0: /);
  expect(JSON.stringify(rows['noisy']).length).toBeLessThan(1500);
  expect(rows['busy']).toMatchObject({ toolUses: 3 });
  expect(rows['busy']).not.toHaveProperty('warnings');
  // A record from before tool counting renders exactly as before.
  expect(rows['legacy']).not.toHaveProperty('toolUses');
  expect(rows['legacy']).not.toHaveProperty('warnings');
  const text = formatRunSummary(summary, true);
  expect(text.length).toBeLessThan(5000);
  expect(text).toMatch(
    /^quiet {2}claude sonnet effort high {2}12s {2}\$0\.0123 {2}tools 0 {2}warnings: no-tool-use: /m,
  );
  expect(text).toMatch(/^busy {2}claude sonnet effort high {2}12s {2}\$0\.0123 {2}tools 3$/m);
  expect(text).toMatch(/^legacy {2}codex \(native model\) effort high {2}12s {2}\$0\.0123$/m);
  expect(text).toMatch(/^failed stalled .*idle timeout 2m00s/m);
});

const rateReport = (utilization: number, extra: Record<string, unknown> = {}) => ({
  rateLimit: {
    status: 'allowed',
    type: 'five_hour',
    resetsAt: 1791014400,
    windows: { five_hour: { utilization }, seven_day: { utilization: 0.5 } },
    ...extra,
  },
});

it('shows the live capture per harness in text and JSON summaries', async () => {
  vi.stubEnv('QUIET_CHOIR_FAKE_SCENARIO', 'claude-rate-limit-success');
  const run = await runWorkflow(
    defineWorkflow({
      name: 'rate-windows',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        return (await ctx.claude.text('task', { prompt: 'answer' })).output;
      },
    }),
    {
      stateDir,
      runId: 'rate-windows',
      cwd: stateDir,
      input: null,
      harness: new CliHarness({
        claudeBinary: fileURLToPath(new URL('./bin/fake-claude.mjs', import.meta.url)),
        killGraceMs: 20,
      }),
    },
  );
  vi.unstubAllEnvs();
  const summary = summarizeRun(run, unlocked);
  expect(summary.rateLimits).toEqual({
    claude: {
      stepId: 'task',
      attempt: 1,
      finishedAt: run.steps['task']?.attemptHistory?.[0]?.finishedAt,
      status: 'allowed_warning',
      type: 'seven_day',
      resetsAt: 1791360000,
      windows: {
        five_hour: { utilization: 0.01, resetsAt: 1791014400 },
        seven_day: { utilization: 0.84, resetsAt: 1791360000 },
      },
    },
  });
  expect((JSON.parse(JSON.stringify(summary)) as typeof summary).rateLimits).toEqual(
    summary.rateLimits,
  );
  expect(formatRunSummary(summary)).toContain(
    '\n  Rate windows claude: 5h window 1%, 7d 84% (allowed_warning; seven_day resets 2026-10-07T08:00:00.000Z)',
  );
  // The line follows the per-harness usage lines.
  const text = formatRunSummary(summary);
  expect(text.indexOf('  Harness claude:')).toBeLessThan(text.indexOf('  Rate windows claude:'));
});

it('omits the key and the line when no attempt reported windows', () => {
  const run = withSteps({
    a: agentStep(1, { harness: 'claude', model: 'sonnet' }),
    b: agentStep(2, { harness: 'codex', model: 'gpt-5.4', diagnostics: { toolUses: 1 } }),
    // Loose or invalid diagnostics are not displayed.
    c: agentStep(3, {
      harness: 'claude',
      model: 'sonnet',
      diagnostics: { rateLimit: { windows: { five_hour: { utilization: 'high' } } } },
    }),
  });
  const summary = summarizeRun(run, unlocked);
  expect(Object.keys(summary)).not.toContain('rateLimits');
  expect(JSON.stringify(summary)).not.toContain('rateLimit');
  expect(formatRunSummary(summary)).not.toContain('Rate windows');
  expect(Object.keys(summarizeRun(withSteps({}), unlocked))).toEqual(Object.keys(summary));
});

it('adds the saved budget stop as an optional key and one text line', () => {
  const run = withSteps({ a: agentStep(1, { harness: 'claude', model: 'sonnet' }) });
  expect(Object.keys(summarizeRun(run, unlocked))).not.toContain('budgetStop');
  expect(formatRunSummary(summarizeRun(run, unlocked))).not.toContain('Budget stop');
  const window = {
    stepId: 'b',
    metric: 'maxWindowUtilization',
    limit: 0.5,
    observed: 0.84,
    at: '2026-10-04T00:00:00.000Z',
    harness: 'claude',
    window: 'seven_day',
    resetsAt: 1_791_360_000,
  } as const;
  const gated = summarizeRun({ ...run, budgetStop: window }, unlocked);
  expect(gated.budgetStop).toEqual(window);
  expect(formatRunSummary(gated)).toContain(
    '\n  Budget stop: claude seven_day window at 84% reached --max-window-utilization 0.5; the window resets at 2026-10-07T08:00:00.000Z; refused step b',
  );
  const capped = summarizeRun(
    {
      ...run,
      budgetStop: {
        stepId: 'b',
        metric: 'maxRunAgentAttempts',
        limit: 3,
        observed: 3,
        at: window.at,
      },
    },
    unlocked,
  );
  expect(formatRunSummary(capped)).toContain(
    '\n  Budget stop: maxRunAgentAttempts limit 3 reached (3 recorded); refused step b',
  );
});

it('takes the latest settled report per harness, failed attempts included, and skips reused steps', () => {
  const step = agentStep(1, { harness: 'claude', model: 'sonnet', diagnostics: rateReport(0.2) });
  const earlier = step.attemptHistory?.[0];
  if (!earlier) throw new Error('Expected an attempt.');
  const failed = {
    ...earlier,
    attempt: 2,
    startedAt: iso(20),
    finishedAt: iso(30),
    status: 'failed',
    diagnostics: rateReport(0.97, { status: 'rejected', resetsAt: 1791360000 }),
  } as unknown as AttemptRecord;
  const reused = {
    ...agentStep(2, { harness: 'claude', model: 'sonnet', diagnostics: rateReport(0.99) }),
    reusedFrom: { runId: 'other' } as unknown as NonNullable<StepRecord['reusedFrom']>,
  };
  const summary = summarizeRun(
    withSteps({
      first: { ...step, attempts: 2, attemptHistory: [earlier, failed] },
      reused,
      codex: agentStep(3, { harness: 'codex', model: 'gpt-5.4' }),
    }),
    unlocked,
  );
  expect(Object.keys(summary.rateLimits ?? {})).toEqual(['claude']);
  expect(summary.rateLimits?.['claude']).toMatchObject({
    stepId: 'first',
    attempt: 2,
    finishedAt: iso(30),
    status: 'rejected',
    windows: { five_hour: { utilization: 0.97 } },
  });
  const text = formatRunSummary(summary);
  expect(text).toContain(
    '  Rate windows claude: 5h window 97%, 7d 50% (rejected; five_hour resets 2026-10-',
  );
  expect(text).not.toContain('Rate windows codex');
});

it('bounds the rate-limit projection independently of the run size', () => {
  const name = (index: number) =>
    `${String(index)}${'w'.repeat(maxRateLimitText)}`.slice(0, maxRateLimitText);
  const windows = Object.fromEntries(
    Array.from({ length: maxRateLimitWindows * 3 }, (_, index) => [
      name(index),
      { utilization: 0.123456789, resetsAt: 1791360000 + index },
    ]),
  );
  const maximal = {
    rateLimit: {
      status: 's'.repeat(maxRateLimitText * 3),
      type: 't'.repeat(maxRateLimitText * 3),
      resetsAt: 1791360000,
      windows,
    },
  };
  const realistic = rateReport(0.01, { status: 'allowed_warning', type: 'seven_day' });
  const calls = (count: number, diagnostics: Record<string, unknown>) => {
    const steps: Record<string, StepRecord> = {};
    for (let i = 0; i < count; i++)
      steps[`agent/${String(i).padStart(2, '0')}`] = agentStep(i + 1, {
        harness: i % 2 ? 'codex' : 'claude',
        model: i % 2 ? 'gpt-5.4' : 'sonnet',
        effort: 'high',
        ...(i >= count - 2 ? { diagnostics } : {}),
      });
    return summarizeRun(withSteps(steps), unlocked);
  };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  // An oversized report is cut to 8 windows of 64 characters, whatever the run size.
  for (const count of [4, 40]) {
    const summary = calls(count, maximal);
    expect(Object.keys(summary.rateLimits ?? {}).sort()).toEqual(['claude', 'codex']);
    expect(Object.keys(summary.rateLimits?.['claude']?.windows ?? {})).toHaveLength(8);
    expect(size(summary.rateLimits)).toBeLessThan(2560);
  }
  // Both harnesses at the maximum fit the 10 KB bound with a 20-call run, and a realistic report
  // (Claude's two windows) fits it beside the 40-call run that the agent bound test uses.
  expect(size(calls(20, maximal))).toBeLessThan(10_240);
  expect(size(calls(40, realistic))).toBeLessThan(10_240);
});

it('lists on-disk bytes that grow with a transcript, shows SIZE, and leaves inspect without them', async () => {
  const definition = defineWorkflow({
    name: 'sized',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: (ctx) => ctx.step('one', { input: null, schema: z.number(), run: () => 1 }),
  });
  await runWorkflow(definition, { stateDir, runId: 'sized', input: null });
  const before = (await listRuns({ stateDir })).runs[0];
  expect(before?.bytes).toEqual(expect.any(Number));
  const transcript = 'x'.repeat(4096);
  await mkdir(join(stateDir, 'sized', 'attempts', 'one'), { recursive: true });
  await writeFile(join(stateDir, 'sized', 'attempts', 'one', '1.jsonl'), transcript);
  const listed = await listRuns({ stateDir });
  const after = listed.runs[0];
  expect(listed.warnings).toEqual([]);
  assert(before && after && typeof before.bytes === 'number' && typeof after.bytes === 'number');
  expect(after.bytes - before.bytes).toBeGreaterThanOrEqual(transcript.length);
  expect(toRunListRow(after).bytes).toBe(after.bytes);
  expect(formatRunList([after])).toMatch(/ USAGE {2}SIZE {2}UPDATED /u);
  expect(formatRunList([after])).toContain(`  ${(after.bytes / 1024).toFixed(1)} KiB  `);
  expect((await inspectRun({ stateDir, runId: 'sized' })).summary).not.toHaveProperty('bytes');
});

it('formats sizes in binary units', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1536)).toBe('1.5 KiB');
  expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MiB');
  expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GiB');
  expect(formatBytes(2048 * 1024 ** 3)).toBe('2048.0 GiB');
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'keeps a run whose size cannot be measured, with null bytes and a warning',
  async () => {
    const definition = defineWorkflow({
      name: 'sealed',
      version: '1',
      input: z.null(),
      output: z.number(),
      run: (ctx) => ctx.step('one', { input: null, schema: z.number(), run: () => 1 }),
    });
    await runWorkflow(definition, { stateDir, runId: 'sealed', input: null });
    const sealed = join(stateDir, 'sealed', 'attempts');
    await mkdir(join(sealed, 'one'), { recursive: true });
    await chmod(sealed, 0o000);
    try {
      const listed = await listRuns({ stateDir });
      expect(listed.runs.map((run) => [run.id, run.bytes])).toEqual([['sealed', null]]);
      const [row] = listed.runs;
      assert(row);
      expect(toRunListRow(row).bytes).toBeNull();
      expect(listed.warnings).toEqual([expect.stringMatching(/^Could not measure sealed in /u)]);
      expect(formatRunList(listed.runs)).toContain('  unknown  ');
    } finally {
      await chmod(sealed, 0o700);
    }
  },
);

it('shows a compact settled outcome on child rows and marks settled frames in the tree', () => {
  const frame = {
    declared: false,
    label: 'kid',
    workflow: { name: 'kid', version: '1' },
    parent: null,
    depth: 1,
    inputDigest: 'input',
    schemaDigest: 'schema',
    startedAt: time,
    finishedAt: time,
    onError: 'return' as const,
  };
  const error = { message: 'kid broke', kind: 'unknown' as const, attempts: 1, stepId: 'kid/work' };
  const run: RunRecord = {
    ...record(),
    children: {
      kid: {
        ...frame,
        status: 'failed',
        error: 'kid broke',
        settled: {
          outcome: { ok: false, error },
          steps: ['kid/work'],
          maps: [],
          children: [],
        },
      },
      ok: {
        ...frame,
        label: 'ok',
        status: 'completed',
        error: null,
        settled: {
          outcome: { ok: true, value: 'x'.repeat(10_000) },
          steps: [],
          maps: [],
          children: [],
        },
      },
    },
  };
  const summary = summarizeRun(run, unlocked);
  const rows = JSON.parse(JSON.stringify(summary)) as { children: Record<string, unknown>[] };
  expect(rows.children).toEqual([
    expect.objectContaining({ id: 'kid', status: 'failed', settled: { ok: false, error } }),
    expect.objectContaining({ id: 'ok', status: 'completed', settled: { ok: true } }),
  ]);
  // The output value and owned-ID lists stay out of the bounded summary.
  expect(JSON.stringify(summary)).not.toContain('xxxxxxxxxx');
  expect(JSON.stringify(summary.children)).not.toContain('kid/work"]');
  const lines = formatRunSummary(summary).split('\n');
  expect(lines.find((line) => line.includes('[kid]'))).toContain('kid: kid@1 failed (settled);');
  expect(lines.find((line) => line.includes('[ok]'))).toContain('ok: kid@1 completed (settled);');
});

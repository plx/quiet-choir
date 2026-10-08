import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { workflowErrorDocument, workflowExitCodes } from '../src/cli/workflow-errors.js';
import { processIdentity } from '../src/processes/identity.js';
import { cancelRun } from '../src/workflow/loader/cancel.js';
import { cancellableRunSignal } from '../src/workflow/loader/cancel-signal.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import type { WorkflowFailure } from '../src/workflow/loader/failure.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { formatArgv } from '../src/workflow/runtime/commands.js';
import * as lock from '../src/workflow/runtime/lock.js';
import { cancelRecord, cancelUnownedRun } from '../src/workflow/runtime/run-cancellation.js';
import { FileRunStore } from '../src/workflow/runtime/run-store.js';
import { lockRun, writeRun } from '../src/workflow/runtime/store.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  RunInterruptedError,
  RunRefusedError,
  z,
} from '../src/index.js';

// Issue #288 / ADR 0039: workflow cancel ends a live local run as `cancelled`, signalling only a
// live, identity-verified owner, through a request bound to that owner's lock token. Issue #292 /
// ADR 0057: a run no process owns is ended under its lock instead, without a signal.

// Spy through to the real lock read, so a test can hold cancel's observations of the lock while a
// tick reclaims it; lock.ts calls its own copy, and every other caller sees the actual behaviour.
vi.mock('../src/workflow/runtime/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof lock>();
  return { ...actual, readContended: vi.fn(actual.readContended) };
});
const actualLock = await vi.importActual<typeof lock>('../src/workflow/runtime/lock.js');
const readContendedSpy = vi.mocked(lock.readContended);

// One program cache for the file, so each compile of the engine source after the first reuses its
// parse and checks (see CONTRIBUTING.md, "Test timeouts and storage sync").
const typecheckCache = new TypecheckProgramCache();

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const logger = new ThresholdLogger('silent', () => undefined);
const DEAD = 2_000_000_000;
const roots: string[] = [];
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-cancel-'));
  roots.push(stateDir);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const requestPath = (runId = 'run-1') => join(stateDir, runId, 'cancel.json');
const ownStart = (): string => {
  const start = processIdentity(process.pid)?.start;
  if (!start) throw new Error('This platform reports no process birth identity.');
  return start;
};

function cancel(
  sendSignal: (pid: number, signal: NodeJS.Signals) => void,
  options: {
    readonly runId?: string;
    readonly force?: boolean;
    readonly timeoutMs?: number;
    readonly launcher?: readonly string[];
  } = {},
): Promise<WorkflowCommandResult> {
  return new WorkflowExecutor({
    typecheckCache,
    logger,
    sendSignal,
    ...(options.launcher === undefined ? {} : { commandLauncher: options.launcher }),
  }).execute({
    kind: 'workflow.cancel',
    runId: options.runId ?? 'run-1',
    stateDir,
    force: options.force ?? false,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

function failed(result: { readonly ok: boolean; readonly kind: string }): WorkflowFailure {
  if (result.ok) throw new Error(`Expected a failure, got ${result.kind}.`);
  return result as WorkflowFailure;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

/** A run left `suspended` and unlocked by a long sleep. */
async function suspendedRun(runId = 'run-1'): Promise<void> {
  const definition = defineWorkflow({
    name: 'nap',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.sleep('nap', 3_600_000);
      return null;
    },
  });
  const result = await runWorkflow(definition, { stateDir, runId, input: null });
  expect(result.status).toBe('suspended');
}

/**
 * Run a workflow in this process whose `slow` step blocks (honouring its signal) until released,
 * so this process is the run's live lock owner. `stop` aborts it with an unmarked reason.
 */
async function liveRun(runId = 'run-1') {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const definition = defineWorkflow({
    name: 'live',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.step('slow', {
        input: null,
        schema: z.null(),
        run: async ({ signal }) => {
          entered();
          await delay(60_000, undefined, { signal });
          return null;
        },
      });
      return null;
    },
  });
  const pending = runWorkflow(definition, {
    stateDir,
    runId,
    input: null,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await started;
  return {
    controller,
    async stop() {
      controller.abort(new Error('test cleanup'));
      await pending;
    },
  };
}

/** Rewrite a saved run as `running` with no lock, as a crashed owner whose lock was cleared leaves it. */
async function crashedWhileRunning(runId = 'run-1'): Promise<void> {
  const owned = await new FileRunStore(stateDir).open(runId);
  try {
    const run = await owned.read();
    if (!run) throw new Error('missing run');
    run.status = 'running';
    await owned.append(run, { durable: true });
  } finally {
    await owned.release();
  }
}

/** The saved bytes of a run directory's snapshot and journal, to show a refusal wrote nothing. */
async function savedBytes(runId = 'run-1'): Promise<string[]> {
  return Promise.all(
    ['run.json', 'journal.jsonl'].map((name) =>
      readFile(join(stateDir, runId, name), 'utf8').catch(() => ''),
    ),
  );
}

/**
 * A workflow whose `slow` step blocks (honouring its signal) while `block` is set. `start` runs or
 * resumes it in this process and resolves once the step is entered (or the run has ended).
 */
function blockingWorkflow(runId = 'run-1') {
  const state = { block: true };
  let entered: () => void = () => undefined;
  const definition = defineWorkflow({
    name: 'blocking',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.step('slow', {
        input: null,
        schema: z.null(),
        run: async ({ signal }) => {
          entered();
          if (state.block) await delay(60_000, undefined, { signal });
          return null;
        },
      });
      return null;
    },
  });
  const start = async (resume: boolean) => {
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const controller = new AbortController();
    const pending = runWorkflow(definition, {
      stateDir,
      runId,
      input: null,
      resume,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await Promise.race([started, pending]);
    return { controller, pending };
  };
  return { state, start };
}

describe('workflow cancel refusals', () => {
  async function plantOwner(owner: object): Promise<void> {
    const lock = join(stateDir, 'run-1', 'lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
  }

  it.each([
    ['a foreign-host owner', () => ({ host: 'elsewhere' }), 'foreign-host'],
    ['a dead owner', () => ({ pid: DEAD }), 'dead'],
    [
      'a live owner without osStartTime',
      () => ({ osStartTime: undefined }),
      'os-start-time-missing',
    ],
    [
      'a live owner with a mismatched osStartTime',
      () => ({ osStartTime: 'bogus' }),
      'os-start-time-mismatch',
    ],
  ] as const)('refuses %s with run.locked and never signals', async (_name, change, reason) => {
    await suspendedRun();
    const owner = {
      pid: process.pid,
      host: hostname(),
      token: 'held',
      osStartTime: ownStart(),
      ...change(),
    };
    await plantOwner(owner);
    const before = await savedBytes();
    const sendSignal = vi.fn();
    const failure = failed(await cancel(sendSignal));
    expect(failure.code).toBe('run.locked');
    expect(workflowExitCodes[failure.code]).toBe(3);
    expect(failure.details).toMatchObject({
      pid: owner.pid,
      host: owner.host,
      osStartTime: owner.osStartTime ?? null,
      reason,
    });
    expect(failure.run?.status).toBe('suspended');
    expect(sendSignal).not.toHaveBeenCalled();
    expect(existsSync(requestPath())).toBe(false);
    // ADR 0057: a held lock is never taken over, so the record and the planted lock are untouched.
    expect(await savedBytes()).toEqual(before);
    expect(
      JSON.parse(await readFile(join(stateDir, 'run-1', 'lock', 'owner.json'), 'utf8')),
    ).toEqual(owner);
  });

  it.each([
    ['a dead owner', () => ({ pid: DEAD }), 'dead'],
    ['a released owner', () => ({ released: true }), 'released'],
  ] as const)(
    'leaves %s and the suspended record untouched, and ends the run after workflow unlock',
    async (_name, change, reason) => {
      await suspendedRun();
      const owner = {
        pid: process.pid,
        host: hostname(),
        token: 'held',
        osStartTime: ownStart(),
        ...change(),
      };
      await plantOwner(owner);
      const before = await savedBytes();
      const failure = failed(await cancel(vi.fn()));
      expect(failure.code).toBe('run.locked');
      expect(failure.details).toMatchObject({
        reason,
        next: [{ argv: expect.arrayContaining(['unlock']) as unknown }],
      });
      expect(await savedBytes()).toEqual(before);
      expect(
        JSON.parse(await readFile(join(stateDir, 'run-1', 'lock', 'owner.json'), 'utf8')),
      ).toEqual(owner);

      expect(
        await new WorkflowExecutor({ typecheckCache, logger }).execute({
          kind: 'workflow.unlock',
          runId: 'run-1',
          stateDir,
          forceRemote: false,
        }),
      ).toMatchObject({ ok: true, kind: 'workflow.unlock.result' });
      expect(await cancel(vi.fn())).toMatchObject({
        status: 'cancelled',
        signalsSent: 0,
        owner: null,
        previousStatus: 'suspended',
      });
      expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('cancelled');
    },
  );

  it.each([
    ['a dead owner', () => ({ pid: DEAD }), true],
    ['a released owner', () => ({ released: true }), true],
    ['a mismatched osStartTime', () => ({ osStartTime: 'bogus' }), true],
    ['a foreign-host owner', () => ({ host: 'elsewhere' }), false],
    ['a live owner without osStartTime', () => ({ osStartTime: undefined }), false],
  ] as const)(
    'lists the unlock command behind the launcher only where the message names it: %s',
    async (_name, change, namesUnlock) => {
      await suspendedRun();
      await plantOwner({
        pid: process.pid,
        host: hostname(),
        token: 'held',
        osStartTime: ownStart(),
        ...change(),
      });
      for (const launcher of [undefined, ['quiet-choir'], [process.execPath, '/abs/bin/run.js']]) {
        const failure = failed(await cancel(vi.fn(), launcher ? { launcher } : {}));
        expect(failure.code).toBe('run.locked');
        if (!namesUnlock) {
          expect(failure.details).not.toHaveProperty('next');
          expect(failure.next ?? []).toEqual([]);
          continue;
        }
        const argv = [
          ...(launcher ?? ['quiet-choir']),
          'workflow',
          'unlock',
          'run-1',
          '--state-dir',
          resolve(stateDir),
        ];
        expect(failure.details).toMatchObject({ next: [{ argv }] });
        expect(failure.message).toContain(formatArgv(argv));
        expect(failure.message).not.toContain('--force-remote');
        // The document's top-level next is the same list, so JSON callers need no parsing.
        expect(failure.next).toEqual([{ why: expect.any(String) as unknown, argv }]);
      }
    },
  );

  it('refuses a lock whose owner.json is unreadable with run.locked', async () => {
    await suspendedRun();
    await plantOwner({ pid: 'not a number' });
    const sendSignal = vi.fn();
    const failure = failed(await cancel(sendSignal));
    expect(failure.code).toBe('run.locked');
    expect(failure.details).toMatchObject({ pid: null, reason: 'unreadable-owner' });
    expect(sendSignal).not.toHaveBeenCalled();
    expect(existsSync(requestPath())).toBe(false);
  });

  it('refuses a format-1 unowned run with run.incompatible and leaves it unchanged', async () => {
    await mkdir(stateDir, { recursive: true });
    const time = '2026-01-01T00:00:00.000Z';
    const legacy = join(stateDir, 'run-1.json');
    await writeFile(
      legacy,
      JSON.stringify({
        formatVersion: 1,
        id: 'run-1',
        workflow: { name: 'flat', version: '1', fingerprint: null },
        status: 'running',
        cwd: project,
        input: null,
        output: null,
        error: null,
        steps: {},
        createdAt: time,
        updatedAt: time,
      }),
    );
    const before = await readFile(legacy, 'utf8');
    const failure = failed(await cancel(vi.fn()));
    expect(failure.code).toBe('run.incompatible');
    expect(workflowExitCodes[failure.code]).toBe(3);
    expect(failure.message).toMatch(/checkpoint format 1/u);
    expect(await readFile(legacy, 'utf8')).toBe(before);
    expect(existsSync(join(stateDir, 'run-1', 'lock'))).toBe(false);
    expect(existsSync(`${legacy}.lock`)).toBe(false);
  });

  it.each([5, 4])(
    'refuses an unowned running format-%i checkpoint with run.incompatible and leaves it unchanged',
    async (formatVersion) => {
      // Formats 2 to 5 are read-only history (and only format 6 or newer can be suspended): build
      // a running one from a completed run's valid record.
      const workflow = blockingWorkflow();
      workflow.state.block = false;
      expect(await (await workflow.start(false)).pending).toMatchObject({ status: 'completed' });
      const { seq, engine, ...current } = await readRun({ stateDir, runId: 'run-1' });
      expect([seq, engine]).not.toContain(undefined);
      await rm(join(stateDir, 'run-1'), { recursive: true });
      const legacy = join(stateDir, 'run-1.json');
      await writeFile(legacy, JSON.stringify({ ...current, formatVersion, status: 'running' }));
      const before = await readFile(legacy, 'utf8');
      const failure = failed(await cancel(vi.fn()));
      expect(failure.code).toBe('run.incompatible');
      expect(workflowExitCodes[failure.code]).toBe(3);
      expect(failure.message).toContain(`format version ${String(formatVersion)}`);
      expect(failure.details).toMatchObject({ formatVersion, status: 'running' });
      expect(await readFile(legacy, 'utf8')).toBe(before);
      // Taking the lock creates an empty run directory; nothing else, no `.vN` backup, remains.
      expect((await readdir(stateDir)).filter((name) => name !== '.gitignore')).toEqual([
        'run-1',
        'run-1.json',
      ]);
      expect(await readdir(join(stateDir, 'run-1'))).toEqual([]);
    },
  );

  it('refuses a missing run with run.not_found', async () => {
    expect(failed(await cancel(vi.fn())).code).toBe('run.not_found');
  });

  it('refuses a timeout outside the timer range as a usage error', async () => {
    for (const timeoutMs of [0, 1.5, 2_147_483_648])
      expect(failed(await cancel(vi.fn(), { timeoutMs })).code).toBe('usage.flag');
  });

  it('is a no-op for a completed or cancelled run', async () => {
    const done = defineWorkflow({
      name: 'done',
      version: '1',
      input: z.null(),
      output: z.null(),
      run: () => Promise.resolve(null),
    });
    await runWorkflow(done, { stateDir, runId: 'run-1', input: null });
    const live = await liveRun('run-2');
    await live.stop();
    expect((await readRun({ stateDir, runId: 'run-2' })).status).toBe('cancelled');
    const sendSignal = vi.fn();
    for (const [runId, status] of [
      ['run-1', 'completed'],
      ['run-2', 'cancelled'],
    ] as const)
      expect(await cancel(sendSignal, { runId })).toEqual({
        kind: 'workflow.cancel.result',
        ok: true,
        runId,
        stateDir,
        status,
        signalsSent: 0,
        owner: null,
        previousStatus: null,
      });
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('is a no-op for a failed run, which tick never resumes', async () => {
    const failing = defineWorkflow({
      name: 'failing',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.step('boom', {
          input: null,
          schema: z.null(),
          run: () => {
            throw new Error('boom');
          },
        });
        return null;
      },
    });
    await expect(runWorkflow(failing, { stateDir, runId: 'run-1', input: null })).rejects.toThrow(
      'boom',
    );
    const before = await savedBytes();
    expect(await cancel(vi.fn())).toMatchObject({
      status: 'failed',
      signalsSent: 0,
      owner: null,
      previousStatus: null,
    });
    expect(await savedBytes()).toEqual(before);
  });
});

describe('ending a run no process owns (ADR 0057)', () => {
  it('ends an unowned suspended run as cancelled under the run lock', async () => {
    await suspendedRun();
    const before = await readRun({ stateDir, runId: 'run-1' });
    const sendSignal = vi.fn();
    expect(await cancel(sendSignal)).toEqual({
      kind: 'workflow.cancel.result',
      ok: true,
      runId: 'run-1',
      stateDir,
      status: 'cancelled',
      signalsSent: 0,
      owner: null,
      previousStatus: 'suspended',
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.error).toMatch(
      /^Run run-1 cancelled by workflow cancel \(requested .+\) while it was suspended with no owner\.$/u,
    );
    expect(saved.rootCause).toEqual({
      stepId: null,
      error: saved.error,
      errorKind: null,
      effect: null,
    });
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.recoveryCause).toEqual({ kind: 'cancelled' });
    expect(saved.formatVersion).toBe(7);
    expect(saved.executions).toHaveLength((before.executions?.length ?? 0) + 1);
    expect(saved.executions?.at(-1)).toMatchObject({
      outcome: 'cancelled',
      error: saved.error,
      pid: process.pid,
    });
    expect(saved.events?.at(-1)).toMatchObject({ type: 'run.cancelled', message: saved.error });
    // Steps are left as they are: the parked sleep stays as it was saved.
    expect(saved.steps).toEqual(before.steps);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(existsSync(requestPath())).toBe(false);
    expect(existsSync(join(stateDir, 'run-1', 'lock'))).toBe(false);
    expect(existsSync(join(stateDir, 'run-1.json.lock'))).toBe(false);

    // Tick observes the cancelled run instead of resuming it.
    const ticked = await new TickWorkflowExecutor({ typecheckCache, logger }).execute({
      kind: 'workflow.tick',
      runId: 'run-1',
      stateDir,
    });
    expect(ticked).toMatchObject({ ok: true, resumed: [], skipped: [], observed: 1 });
    expect(await readRun({ stateDir, runId: 'run-1' })).toEqual(saved);

    // Idempotent once ended.
    expect(await cancel(sendSignal)).toMatchObject({
      status: 'cancelled',
      signalsSent: 0,
      owner: null,
      previousStatus: null,
    });
    expect(await readRun({ stateDir, runId: 'run-1' })).toEqual(saved);
  });

  it('ends a lockless running (stale) run as cancelled', async () => {
    await suspendedRun();
    await crashedWhileRunning();
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('running');
    expect(await cancel(vi.fn())).toMatchObject({
      status: 'cancelled',
      signalsSent: 0,
      owner: null,
      previousStatus: 'running',
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.error).toMatch(/while it was running with no owner\.$/u);
  });

  it('clears interruptedBy when cancelling an interrupted suspended run', async () => {
    const live = await liveRun();
    live.controller.abort(interrupt());
    await live.stop();
    const interrupted = await readRun({ stateDir, runId: 'run-1' });
    expect(interrupted.status).toBe('suspended');
    expect(interrupted.interruptedBy).toMatchObject({ reason: 'Workflow interrupted by SIGINT.' });
    expect(await cancel(vi.fn())).toMatchObject({
      status: 'cancelled',
      previousStatus: 'suspended',
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.interruptedBy).toBeUndefined();
    expect((await inspectRun({ stateDir, runId: 'run-1' })).summary.interruptedBy).toBeNull();
  });

  it('cancels suspended child frames', async () => {
    const child = defineWorkflow({
      name: 'napper',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.sleep('nap', 3_600_000);
        return null;
      },
    });
    const parent = defineWorkflow({
      name: 'parent',
      version: '1',
      input: z.null(),
      output: z.null(),
      children: [child],
      async run(ctx) {
        await ctx.workflow('child', child, null);
        return null;
      },
    });
    const suspended = await runWorkflow(parent, { stateDir, runId: 'run-1', input: null });
    expect(suspended.status).toBe('suspended');
    expect(suspended.children?.['child']).toMatchObject({ status: 'suspended', finishedAt: null });
    expect(await cancel(vi.fn())).toMatchObject({
      status: 'cancelled',
      previousStatus: 'suspended',
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.children?.['child']).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(String) as unknown,
      error: saved.error,
    });
  });

  it('restores a record exactly when its cancellation could not be saved', async () => {
    const live = await liveRun();
    live.controller.abort(interrupt());
    await live.stop();
    const record = await readRun({ stateDir, runId: 'run-1' });
    const original = structuredClone(record);
    const { event, restore } = cancelRecord(record, new Error('stop'), {
      cause: () => ({ kind: 'cancelled' }),
      sourceChanged: false,
    });
    expect(event).toMatchObject({ type: 'run.cancelled', message: 'stop' });
    expect(record).toMatchObject({ status: 'cancelled', recoveryCause: { kind: 'cancelled' } });
    expect(record.interruptedBy).toBeUndefined();
    restore();
    expect(record).toEqual(original);
  });

  it('refuses a run that vanished before the lock with run.not_found', async () => {
    await expect(cancelUnownedRun({ stateDir, runId: 'run-1' })).rejects.toMatchObject({
      code: 'run.not_found',
    });
  });

  it('migrates a flat format-6 record as it saves the cancellation', async () => {
    // A format-6 run left `running` by a crashed owner of an older build.
    const workflow = blockingWorkflow();
    workflow.state.block = false;
    expect(await (await workflow.start(false)).pending).toMatchObject({ status: 'completed' });
    const current = await readRun({ stateDir, runId: 'run-1' });
    const previous = { ...current, status: 'running' as const, formatVersion: 6 as const };
    delete previous.seq;
    delete previous.engine;
    await rm(join(stateDir, 'run-1'), { recursive: true });
    await writeRun(stateDir, previous);
    expect((await readRun({ stateDir, runId: 'run-1' })).formatVersion).toBe(6);
    expect(await cancel(vi.fn())).toMatchObject({
      status: 'cancelled',
      previousStatus: 'running',
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved).toMatchObject({ formatVersion: 7, status: 'cancelled' });
    expect(saved.steps).toEqual(current.steps);
  });
});

describe('a writer that takes the lock while cancel ends an unowned run', () => {
  const plan = () => ({
    kind: 'workflow.cancel' as const,
    runId: 'run-1',
    stateDir,
    force: false,
    timeoutMs: 10_000,
  });

  it('signals an owner that won the lock', async () => {
    const workflow = blockingWorkflow();
    const first = await workflow.start(false);
    first.controller.abort(interrupt());
    await first.pending;
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('suspended');

    let owner: Awaited<ReturnType<typeof workflow.start>> | undefined;
    const cancelUnowned = vi.fn(async (options: Parameters<typeof cancelUnownedRun>[0]) => {
      // A resume takes the lock between cancel's observation and its own attempt.
      owner ??= await workflow.start(true);
      return cancelUnownedRun(options);
    });
    const sendSignal = vi.fn(() => {
      // An embedder honouring SIGINT with an unmarked reason, which cancels the run.
      owner?.controller.abort(new Error('Stopped by workflow cancel.'));
    });
    try {
      const result = await cancelRun(plan(), { sendSignal, cancelUnowned, intervalMs: 10 });
      expect(result).toMatchObject({
        status: 'cancelled',
        signalsSent: 1,
        owner: { pid: process.pid, host: hostname(), osStartTime: ownStart() },
        previousStatus: null,
      });
    } finally {
      owner?.controller.abort(new Error('test cleanup'));
      await owner?.pending;
    }
    expect(cancelUnowned).toHaveBeenCalledOnce();
    expect(sendSignal).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGINT');
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('cancelled');
  });

  it('reports a run that completed first without writing', async () => {
    const workflow = blockingWorkflow();
    const first = await workflow.start(false);
    first.controller.abort(interrupt());
    await first.pending;
    let completed: string[] = [];
    const cancelUnowned = vi.fn(async (options: Parameters<typeof cancelUnownedRun>[0]) => {
      workflow.state.block = false;
      const resumed = await workflow.start(true);
      expect(await resumed.pending).toMatchObject({ status: 'completed' });
      completed = await savedBytes();
      return cancelUnownedRun(options);
    });
    const sendSignal = vi.fn();
    expect(await cancelRun(plan(), { sendSignal, cancelUnowned })).toMatchObject({
      status: 'completed',
      signalsSent: 0,
      owner: null,
      previousStatus: null,
    });
    expect(await savedBytes()).toEqual(completed);
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('refuses with run.locked after three contended attempts', async () => {
    await suspendedRun();
    const cancelUnowned = vi.fn(() =>
      Promise.reject(new RunRefusedError('run.locked', 'run-1', 'Run run-1 is locked.', null)),
    );
    await expect(cancelRun(plan(), { sendSignal: vi.fn(), cancelUnowned })).rejects.toMatchObject({
      code: 'run.locked',
    });
    expect(cancelUnowned).toHaveBeenCalledTimes(3);
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('suspended');
  });
});

describe('workflow cancel waits', () => {
  it('times out with the last saved status, escalating to a second signal only under --force', async () => {
    const live = await liveRun();
    try {
      const sendSignal = vi.fn();
      const plain = failed(await cancel(sendSignal, { timeoutMs: 50 }));
      expect(plain.code).toBe('watch.timeout');
      expect(workflowExitCodes[plain.code]).toBe(79);
      expect(plain.details).toEqual({
        timeoutMs: 50,
        signalsSent: 1,
        forced: false,
        pid: process.pid,
      });
      expect(workflowErrorDocument(plain)).toMatchObject({ ok: false, status: 'running' });
      expect(sendSignal).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGINT');
      // The request stays for the owner to honour late.
      expect(existsSync(requestPath())).toBe(true);

      sendSignal.mockClear();
      const forced = failed(await cancel(sendSignal, { timeoutMs: 50, force: true }));
      expect(forced.code).toBe('watch.timeout');
      expect(forced.details).toMatchObject({ signalsSent: 2, forced: true });
      expect(forced.run?.status).toBe('running');
      expect(sendSignal.mock.calls).toEqual([
        [process.pid, 'SIGINT'],
        [process.pid, 'SIGINT'],
      ]);
    } finally {
      await live.stop();
    }
  });

  it('reports no owner when the run completes before any signal lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const definition = defineWorkflow({
      name: 'finishing',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.step('gate', {
          input: null,
          schema: z.null(),
          run: async () => {
            entered();
            await gate;
            return null;
          },
        });
        return null;
      },
    });
    const pending = runWorkflow(definition, { stateDir, runId: 'run-1', input: null });
    await started;
    // The owner verifies, then the run finishes while the signal is being sent: the PID is gone.
    const sendSignal = vi.fn(() => {
      release();
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    const result = await cancel(sendSignal);
    expect((await pending).status).toBe('completed');
    expect(result).toEqual({
      kind: 'workflow.cancel.result',
      ok: true,
      runId: 'run-1',
      stateDir,
      status: 'completed',
      signalsSent: 0,
      owner: null,
      previousStatus: null,
    });
    expect(sendSignal).toHaveBeenCalledOnce();
    expect(existsSync(requestPath())).toBe(false);
  });

  it('reports run.unowned when the owner exits without saving a terminal status', async () => {
    await suspendedRun();
    // An embedder that honours its interruption by suspending: the lock goes, the record stays.
    const release = await lockRun(stateDir, 'run-1');
    let released: Promise<void> | undefined;
    const sendSignal = vi.fn(() => {
      released = release();
    });
    const failure = failed(await cancel(sendSignal));
    // Cancel sees the primary lock go; the guard release may still be finishing.
    await released;
    expect(failure.code).toBe('run.unowned');
    expect(failure.details).toEqual({
      reason: 'owner-exited',
      pid: process.pid,
      signalsSent: 1,
      forced: false,
      requestKept: true,
    });
    expect(failure.message).toMatch(
      /exited without saving cancelled; the run is suspended\. The cancel request stays bound to the exited owner, whose lock is gone or re-owned: a workflow tick that retires that owner's lock ends the run as cancelled; otherwise the next workflow tick may resume it\.$/u,
    );
    expect(failure.run?.status).toBe('suspended');
    expect(sendSignal).toHaveBeenCalledOnce();
    // Kept but inert: no acquisition retires the released owner's lock, so no tick honours it.
    expect(existsSync(requestPath())).toBe(true);
  });

  // Issue #293 / ADR 0058: the SIGINT was the owner's second signal, so it exited 130 at once and
  // left both locks behind with its token and the run still running.
  it('keeps the request when the owner is force-killed, and the next tick saves the run cancelled', async () => {
    await suspendedRun();
    await crashedWhileRunning();
    await lockRun(stateDir, 'run-1');
    const locks = [join(stateDir, 'run-1', 'lock'), join(stateDir, 'run-1.json.lock')];
    const sendSignal = vi.fn(() => {
      for (const lock of locks) {
        const path = join(lock, 'owner.json');
        const owner = JSON.parse(readFileSync(path, 'utf8')) as object;
        writeFileSync(path, JSON.stringify({ ...owner, pid: DEAD }));
      }
    });
    const failure = failed(await cancel(sendSignal));
    expect(failure.code).toBe('run.unowned');
    expect(workflowExitCodes[failure.code]).toBe(3);
    expect(failure.details).toEqual({
      reason: 'owner-exited',
      pid: process.pid,
      signalsSent: 1,
      forced: false,
      requestKept: true,
    });
    expect(failure.message).toMatch(
      /exited without saving cancelled; the run is running\. The cancel request stays bound to the exited owner's lock, so the next workflow tick ends the run as cancelled instead of recovering it\.$/u,
    );
    expect(failure.run?.status).toBe('running');
    expect(existsSync(requestPath())).toBe(true);
    const { requestedAt } = JSON.parse(await readFile(requestPath(), 'utf8')) as {
      readonly requestedAt: string;
    };

    const ticked = await new TickWorkflowExecutor({ typecheckCache, logger }).execute({
      kind: 'workflow.tick',
      runId: 'run-1',
      stateDir,
    });
    expect(ticked).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run-1',
          reason: 'cancelled',
          message: `Run run-1 cancelled by workflow cancel (requested ${requestedAt}); its owner PID ${String(process.pid)} exited before saving, so stale recovery ended it instead of resuming it.`,
        },
      ],
      observed: 0,
      exitCode: 1,
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.recoveryCause).toEqual({ kind: 'cancelled' });
    expect(existsSync(requestPath())).toBe(false);
    for (const lock of locks) expect(existsSync(lock)).toBe(false);
  });

  // A tick reclaims the force-killed owner's locks before cancel looks at them again: cancel sees
  // the tick's token, yet the tick still checks the request under its own lock, so it must stay.
  it('keeps the request when a tick re-owns the lock first, and that tick saves the run cancelled', async () => {
    await suspendedRun();
    await crashedWhileRunning();
    await lockRun(stateDir, 'run-1');
    const locks = [join(stateDir, 'run-1', 'lock'), join(stateDir, 'run-1.json.lock')];
    let reclaimed!: () => void;
    const tickOwns = new Promise<void>((resolve) => {
      reclaimed = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the instance below
    const realOpen = FileRunStore.prototype.open;
    vi.spyOn(FileRunStore.prototype, 'open').mockImplementation(async function (
      this: FileRunStore,
      ...args
    ) {
      const owned = await realOpen.apply(this, args);
      // The tick holds both locks, retired from the dead owner, before it reads the request.
      reclaimed();
      await gate;
      return owned;
    });
    let ticking: ReturnType<TickWorkflowExecutor['execute']> | undefined;
    const sendSignal = vi.fn(() => {
      for (const lock of locks) {
        const path = join(lock, 'owner.json');
        const owner = JSON.parse(readFileSync(path, 'utf8')) as object;
        writeFileSync(path, JSON.stringify({ ...owner, pid: DEAD }));
      }
      readContendedSpy.mockImplementation(async (path) => {
        await tickOwns;
        return actualLock.readContended(path);
      });
      ticking = new TickWorkflowExecutor({ typecheckCache, logger }).execute({
        kind: 'workflow.tick',
        runId: 'run-1',
        stateDir,
      });
    });
    let failure: WorkflowFailure;
    try {
      failure = failed(await cancel(sendSignal));
    } finally {
      readContendedSpy.mockImplementation(actualLock.readContended);
      proceed();
    }
    const ticked = await ticking;
    expect(failure.code).toBe('run.unowned');
    expect(failure.details).toEqual({
      reason: 'owner-exited',
      pid: process.pid,
      signalsSent: 1,
      forced: false,
      requestKept: true,
    });
    expect(failure.message).toMatch(
      /exited without saving cancelled; the run is running\. The cancel request stays bound to the exited owner, whose lock is gone or re-owned: a workflow tick that retires that owner's lock ends the run as cancelled; otherwise stale recovery by the next workflow tick may resume it\.$/u,
    );
    expect(failure.run?.status).toBe('running');

    expect(ticked).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'run-1', reason: 'cancelled' }],
      exitCode: 1,
    });
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.recoveryCause).toEqual({ kind: 'cancelled' });
    expect(existsSync(requestPath())).toBe(false);
    for (const lock of locks) expect(existsSync(lock)).toBe(false);
  });
});

describe('the owner-side run signal', () => {
  /** This process holding the run's primary lock with token `held`, and a request for `token`. */
  async function plant(token: string, request: string | null = null): Promise<void> {
    const lock = join(stateDir, 'run-1', 'lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: 'held',
        osStartTime: ownStart(),
      }),
    );
    await writeFile(
      requestPath(),
      request ??
        JSON.stringify({
          version: 1,
          requestId: 'r',
          token,
          pid: process.pid,
          host: hostname(),
          osStartTime: ownStart(),
          requestedAt: '2031-01-02T03:04:05.000Z',
        }),
    );
  }
  const target = () => ({ stateDir, runId: 'run-1' });

  it('turns a marked interruption into a cancellation only for a matching request', async () => {
    await plant('held');
    const outer = new AbortController();
    const onCancel = vi.fn();
    const wrapped = cancellableRunSignal(outer.signal, target(), onCancel);
    outer.abort(interrupt());
    expect(wrapped.cancelled).toBe(true);
    expect(wrapped.signal.reason).not.toBeInstanceOf(RunInterruptedError);
    expect((wrapped.signal.reason as Error).message).toBe(
      'Run run-1 cancelled by workflow cancel (requested 2031-01-02T03:04:05.000Z).',
    );
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(
      'Run run-1: cancel requested by workflow cancel; draining.',
    );
    wrapped.dispose();
  });

  it('forwards other reasons, unmatched or unreadable requests, and an earlier abort', async () => {
    await plant('held');
    const other = new AbortController();
    const reason = new Error('embedder stop');
    const forwarded = cancellableRunSignal(other.signal, target());
    other.abort(reason);
    expect(forwarded.signal.reason).toBe(reason);
    expect(forwarded.cancelled).toBe(false);

    for (const request of [null, '{not json'] as const) {
      await plant('another-execution', request);
      const outer = new AbortController();
      const marked = interrupt();
      const wrapped = cancellableRunSignal(outer.signal, target());
      outer.abort(marked);
      expect(wrapped.signal.reason).toBe(marked);
    }

    await plant('held');
    const early = new AbortController();
    early.abort(interrupt());
    const late = cancellableRunSignal(early.signal, target());
    expect(late.signal.aborted).toBe(true);
    expect(late.cancelled).toBe(true);
    late.dispose();
  });
});

/** A trusted workflow file whose `slow` step counts its calls and blocks until a gate file exists. */
async function workflowFixture(runId = 'run-1') {
  const root = await mkdtemp(join(tmpdir(), 'choir-cancel-fixture-'));
  roots.push(root);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'workflow.ts');
  const calls = join(root, 'calls.txt');
  const imports = join(root, 'imports.txt');
  const holdImport = join(root, 'hold-import');
  const releaseImport = join(root, 'release-import');
  await writeFile(
    file,
    `
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
appendFileSync(${JSON.stringify(imports)}, 'import\\n');
// Holds the module import, and so the tick claim window, while asked to.
if (existsSync(${JSON.stringify(holdImport)}))
  while (!existsSync(${JSON.stringify(releaseImport)})) await delay(10);
export default defineWorkflow({ name: 'cancellable', version: '1', input: z.null(), output: z.null(),
  run: async (ctx) => {
    await ctx.step('slow', { input: null, schema: z.null(), run: async ({ signal }) => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      await delay(60_000, undefined, { signal });
      return null;
    } });
    return null;
  }
});
`,
  );
  const analysis = analyzeTypecheckEntrypoint(file, root);
  if (!analysis.ok) throw new Error(analysis.error.message);
  const lines = async (path: string): Promise<number> =>
    existsSync(path) ? (await readFile(path, 'utf8')).split('\n').length - 1 : 0;
  return {
    calls: () => lines(calls),
    imports: () => lines(imports),
    holdImport,
    releaseImport,
    plan: {
      kind: 'workflow.execute' as const,
      typecheck: analysis.plan,
      runId,
      stateDir,
      cwd: root,
      resume: false,
      input: null,
    },
  };
}

/** The current lock token of the run, read from its primary lock. */
async function lockToken(runId = 'run-1'): Promise<string> {
  const owner = JSON.parse(await readFile(join(stateDir, runId, 'lock', 'owner.json'), 'utf8')) as {
    token: string;
  };
  return owner.token;
}

const interrupt = () => new RunInterruptedError('Workflow interrupted by SIGINT.');

/**
 * A workflow file that suspends on `ask`, the `plan` that executes it (resuming and accepting a
 * changed source when `resume`), and a body counter. Bodies whose 1-based count is in `held` wait
 * until the run is aborted.
 */
async function preflightFixture(held: readonly number[]) {
  const root = await mkdtemp(join(tmpdir(), 'choir-cancel-preflight-'));
  roots.push(root);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'workflow.ts');
  const bodies = join(root, 'bodies.txt');
  const plan = async (value: string, resume: boolean) => {
    await writeFile(
      file,
      `
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'accepted', version: '1', input: z.null(), output: z.string(),
run: async (ctx) => {
  appendFileSync(${JSON.stringify(bodies)}, 'body\\n');
  // Hold the listed bodies until the run is aborted.
  if (${JSON.stringify(held)}.includes(readFileSync(${JSON.stringify(bodies)}, 'utf8').split('\\n').length - 1))
    while (!ctx.signal.aborted) await delay(10);
  await ctx.step('effect', { input: null, schema: z.string(), run: () => ${JSON.stringify(value)} });
  return ctx.ask('q', { prompt: 'Text?', schema: z.string() });
}
});
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, root);
    if (!analysis.ok) throw new Error(analysis.error.message);
    return {
      kind: 'workflow.execute' as const,
      typecheck: analysis.plan,
      runId: 'run-1',
      stateDir,
      cwd: root,
      resume,
      input: null,
      ...(resume ? { acceptCodeChange: true } : {}),
    };
  };
  const count = async (): Promise<number> =>
    existsSync(bodies) ? (await readFile(bodies, 'utf8')).split('\n').length - 1 : 0;
  return { plan, count };
}

// measured: about 1 s per case alone; the whole file took 39 s in a full coverage run on a loaded
// machine, dominated by these cases' tsImport compiles (each type-checks and imports the workflow
// once or twice).
describe('cancelling a live execution', { timeout: 60_000 }, () => {
  it('ends the run cancelled, and the next tick observes it instead of resuming it', async () => {
    const f = await workflowFixture();
    const outer = new AbortController();
    const owner = new WorkflowExecutor({ typecheckCache, logger, signal: outer.signal }).execute(
      f.plan,
    );
    await waitFor(async () => (await f.calls()) === 1, 'the slow step');
    // Stands in for the owner's executionSignals: the first SIGINT is a marked interruption.
    const sendSignal = vi.fn(() => {
      outer.abort(interrupt());
    });
    const result = await cancel(sendSignal);
    expect(result).toEqual({
      kind: 'workflow.cancel.result',
      ok: true,
      runId: 'run-1',
      stateDir,
      status: 'cancelled',
      signalsSent: 1,
      owner: { pid: process.pid, host: hostname(), osStartTime: ownStart() },
      previousStatus: null,
    });
    expect(sendSignal).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGINT');
    expect(failed(await owner).code).toBe('workflow.interrupted');
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved).toMatchObject({ status: 'cancelled', steps: { slow: { status: 'cancelled' } } });
    expect(saved.error).toMatch(/^Run run-1 cancelled by workflow cancel \(requested .+\)\.$/u);
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.events?.at(-1)).toMatchObject({ type: 'run.cancelled' });
    expect(existsSync(requestPath())).toBe(false);

    const ticked = await new TickWorkflowExecutor({ typecheckCache, logger }).execute({
      kind: 'workflow.tick',
      runId: 'run-1',
      stateDir,
    });
    expect(ticked).toMatchObject({ ok: true, resumed: [], skipped: [], observed: 1 });
    expect(await f.calls()).toBe(1);
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('cancelled');
    // Idempotent once ended.
    expect(await cancel(vi.fn())).toMatchObject({ status: 'cancelled', signalsSent: 0 });
  });

  it('ignores a request bound to another execution, so a plain interruption still suspends', async () => {
    const f = await workflowFixture();
    const first = new AbortController();
    const execution = new WorkflowExecutor({
      typecheckCache,
      logger,
      signal: first.signal,
    }).execute(f.plan);
    await waitFor(async () => (await f.calls()) === 1, 'the first execution');
    const firstToken = await lockToken();
    const request = (token: string) =>
      writeFile(
        requestPath(),
        JSON.stringify({
          version: 1,
          requestId: `request-${token}`,
          token,
          pid: process.pid,
          host: hostname(),
          osStartTime: ownStart(),
          requestedAt: new Date().toISOString(),
        }),
      );
    // A request for a token this execution does not hold.
    await request('stale-token');
    first.abort(interrupt());
    expect(failed(await execution).code).toBe('workflow.interrupted');
    expect(await readRun({ stateDir, runId: 'run-1' })).toMatchObject({
      status: 'suspended',
      interruptedBy: { reason: 'Workflow interrupted by SIGINT.' },
    });

    // A request left for the first execution never cancels the next one in the same process.
    await request(firstToken);
    const second = new AbortController();
    const resumed = new WorkflowExecutor({ typecheckCache, logger, signal: second.signal }).execute(
      {
        ...f.plan,
        resume: true,
      },
    );
    await waitFor(async () => (await f.calls()) === 2, 'the second execution');
    expect(await lockToken()).not.toBe(firstToken);
    second.abort(interrupt());
    expect(failed(await resumed).code).toBe('workflow.interrupted');
    expect(await readRun({ stateDir, runId: 'run-1' })).toMatchObject({
      status: 'suspended',
      interruptedBy: { reason: 'Workflow interrupted by SIGINT.' },
    });
  });

  it("cancels a run inside tick's claim window before its body starts", async () => {
    const f = await workflowFixture();
    // A plain interruption leaves a suspension that is due now.
    const first = new AbortController();
    const execution = new WorkflowExecutor({
      typecheckCache,
      logger,
      signal: first.signal,
    }).execute(f.plan);
    await waitFor(async () => (await f.calls()) === 1, 'the first execution');
    first.abort(interrupt());
    await execution;
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('suspended');

    await writeFile(f.holdImport, '');
    const imported = await f.imports();
    const tickSignal = new AbortController();
    const ticking = new TickWorkflowExecutor({
      typecheckCache,
      logger,
      signal: tickSignal.signal,
    }).execute({
      kind: 'workflow.tick',
      runId: 'run-1',
      stateDir,
    });
    // Tick holds the lock while the module import is held.
    await waitFor(async () => (await f.imports()) > imported, 'the tick import');
    const sendSignal = vi.fn(() => {
      tickSignal.abort(interrupt());
      void writeFile(f.releaseImport, '');
    });
    expect(await cancel(sendSignal)).toMatchObject({ status: 'cancelled', signalsSent: 1 });
    expect(failed(await ticking).code).toBe('workflow.interrupted');
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.interruptedBy).toBeUndefined();
    // The body never ran again.
    expect(await f.calls()).toBe(1);
  });

  it("cancels an accepted resume during runWorkflow's preflight without recording the acceptance", async () => {
    const { plan, count } = await preflightFixture([2]);
    // A suspended run: workflow cancel leaves an ended one alone, even while it is being resumed.
    expect(
      await new WorkflowExecutor({ typecheckCache, logger }).execute(await plan('one', false)),
    ).toMatchObject({
      ok: true,
      run: { status: 'suspended' },
    });
    const before = await readRun({ stateDir, runId: 'run-1' });

    const outer = new AbortController();
    const owner = new WorkflowExecutor({ typecheckCache, logger, signal: outer.signal }).execute(
      await plan('two', true),
    );
    await waitFor(async () => (await count()) === 2, 'the preflight body');
    const sendSignal = vi.fn(() => {
      outer.abort(interrupt());
    });
    expect(await cancel(sendSignal)).toMatchObject({ status: 'cancelled', signalsSent: 1 });
    expect(failed(await owner).code).toBe('workflow.interrupted');
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.error).toMatch(/^Run run-1 cancelled by workflow cancel \(requested .+\)\.$/u);
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.recoveryCause).toEqual({ kind: 'cancelled' });
    // The execution ends with the lifecycle record a cancellation in the body would leave.
    expect(saved.executions).toHaveLength((before.executions?.length ?? 0) + 1);
    expect(saved.executions?.at(-1)).toMatchObject({ outcome: 'cancelled', error: saved.error });
    expect(saved.events?.at(-1)).toMatchObject({ type: 'run.cancelled', message: saved.error });
    // The acceptance was never recorded, and the real body never ran.
    expect(saved.workflow.fingerprint).toBe(before.workflow.fingerprint);
    expect(saved.codeChanges).toEqual(before.codeChanges);
    expect(saved.steps).toEqual(before.steps);
    expect(saved.steps['q']?.status).toBe('waiting');
    expect(await count()).toBe(2);
    expect(existsSync(requestPath())).toBe(false);
  });

  it("clears an earlier interruption when a cancellation ends runWorkflow's preflight", async () => {
    // Bodies 2 (the interrupted resume) and 3 (the accepted resume's preflight) wait for an abort.
    const { plan, count } = await preflightFixture([2, 3]);
    expect(
      await new WorkflowExecutor({ typecheckCache, logger }).execute(await plan('one', false)),
    ).toMatchObject({
      ok: true,
      run: { status: 'suspended' },
    });

    // A marked interruption saves the run suspended with interruptedBy.
    const interrupted = new AbortController();
    const first = new WorkflowExecutor({
      typecheckCache,
      logger,
      signal: interrupted.signal,
    }).execute(await plan('one', true));
    await waitFor(async () => (await count()) === 2, 'the interrupted body');
    interrupted.abort(interrupt());
    expect(failed(await first).code).toBe('workflow.interrupted');
    const before = await readRun({ stateDir, runId: 'run-1' });
    expect(before.status).toBe('suspended');
    expect(before.interruptedBy).toMatchObject({ reason: 'Workflow interrupted by SIGINT.' });

    // The source changes; an unmarked abort during the accepted resume's preflight cancels it.
    const cancelled = new AbortController();
    const second = new WorkflowExecutor({
      typecheckCache,
      logger,
      signal: cancelled.signal,
    }).execute(await plan('two', true));
    await waitFor(async () => (await count()) === 3, 'the preflight body');
    cancelled.abort(new Error('Stopped by the operator.'));
    await second;
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved.status).toBe('cancelled');
    expect(saved.error).toBe('Stopped by the operator.');
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.workflow.fingerprint).toBe(before.workflow.fingerprint);
    expect(saved.codeChanges).toEqual(before.codeChanges);
    expect((await inspectRun({ stateDir, runId: 'run-1' })).summary.interruptedBy).toBeNull();
    expect(await count()).toBe(3);
  });
});

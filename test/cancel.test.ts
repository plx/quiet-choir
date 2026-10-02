import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { workflowErrorDocument, workflowExitCodes } from '../src/cli/workflow-errors.js';
import { processIdentity } from '../src/processes/identity.js';
import { cancellableRunSignal } from '../src/workflow/loader/cancel-signal.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { WorkflowFailure } from '../src/workflow/loader/failure.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { lockRun } from '../src/workflow/runtime/store.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { defineWorkflow, readRun, runWorkflow, RunInterruptedError, z } from '../src/index.js';

// Issue #288 / ADR 0039: workflow cancel ends a live local run as `cancelled`, signalling only a
// live, identity-verified owner, through a request bound to that owner's lock token.
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
  options: { readonly runId?: string; readonly force?: boolean; readonly timeoutMs?: number } = {},
): Promise<WorkflowCommandResult> {
  return new WorkflowExecutor({ logger, sendSignal }).execute({
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
  });

  it('refuses an unfinished run no process owns with run.unowned', async () => {
    await suspendedRun();
    const sendSignal = vi.fn();
    const failure = failed(await cancel(sendSignal));
    expect(failure.code).toBe('run.unowned');
    expect(workflowExitCodes[failure.code]).toBe(3);
    expect(failure.details).toEqual({ reason: 'unlocked', signalsSent: 0, forced: false });
    expect(sendSignal).not.toHaveBeenCalled();
    expect(existsSync(requestPath())).toBe(false);
  });

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
      });
    expect(sendSignal).not.toHaveBeenCalled();
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

  it('reports run.unowned when the owner exits without saving a terminal status', async () => {
    await suspendedRun();
    // An embedder that honours its interruption by suspending: the lock goes, the record stays.
    const release = await lockRun(stateDir, 'run-1');
    const sendSignal = vi.fn(() => {
      void release();
    });
    const failure = failed(await cancel(sendSignal));
    expect(failure.code).toBe('run.unowned');
    expect(failure.details).toEqual({
      reason: 'owner-exited',
      pid: process.pid,
      signalsSent: 1,
      forced: false,
    });
    expect(failure.message).toMatch(
      /exited without saving cancelled; the run is suspended, and the next workflow tick may resume it\.$/u,
    );
    expect(failure.run?.status).toBe('suspended');
    expect(sendSignal).toHaveBeenCalledOnce();
    expect(existsSync(requestPath())).toBe(false);
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

// measured: pending; these cases type-check and import a workflow module several times.
describe('cancelling a live execution', { timeout: 60_000 }, () => {
  it('ends the run cancelled, and the next tick observes it instead of resuming it', async () => {
    const f = await workflowFixture();
    const outer = new AbortController();
    const owner = new WorkflowExecutor({ logger, signal: outer.signal }).execute(f.plan);
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
    });
    expect(sendSignal).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGINT');
    expect(failed(await owner).code).toBe('workflow.interrupted');
    const saved = await readRun({ stateDir, runId: 'run-1' });
    expect(saved).toMatchObject({ status: 'cancelled', steps: { slow: { status: 'cancelled' } } });
    expect(saved.error).toMatch(/^Run run-1 cancelled by workflow cancel \(requested .+\)\.$/u);
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.events?.at(-1)).toMatchObject({ type: 'run.cancelled' });
    expect(existsSync(requestPath())).toBe(false);

    const ticked = await new TickWorkflowExecutor({ logger }).execute({
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
    const execution = new WorkflowExecutor({ logger, signal: first.signal }).execute(f.plan);
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
    const resumed = new WorkflowExecutor({ logger, signal: second.signal }).execute({
      ...f.plan,
      resume: true,
    });
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
    const execution = new WorkflowExecutor({ logger, signal: first.signal }).execute(f.plan);
    await waitFor(async () => (await f.calls()) === 1, 'the first execution');
    first.abort(interrupt());
    await execution;
    expect((await readRun({ stateDir, runId: 'run-1' })).status).toBe('suspended');

    await writeFile(f.holdImport, '');
    const imported = await f.imports();
    const tickSignal = new AbortController();
    const ticking = new TickWorkflowExecutor({ logger, signal: tickSignal.signal }).execute({
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
});

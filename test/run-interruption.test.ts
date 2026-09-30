import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CancelledError,
  defineWorkflow,
  FileRunStore,
  readRun,
  runWorkflow,
  RunInterruptedError,
  WorkflowRunError,
  z,
  type WorkflowClock,
} from '../src/index.js';

// Issue #199: a marked external interruption saves a resumable suspension; other aborts do not.
let stateDir: string;
const options = () => ({ stateDir, runId: 'interrupted', input: null });
const NOW = Date.UTC(2031, 4, 6, 7, 8, 9);
const fixedClock: WorkflowClock = {
  now: () => NOW,
  sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A completed `before` step, then a `slow` step that honours its abort signal until released. */
function interruptible() {
  const before = vi.fn(() => 'before');
  const entered = deferred();
  const state = { blocked: true, fail: false };
  const definition = defineWorkflow({
    name: 'interruptible',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      await ctx.step('before', { input: null, schema: z.string(), run: before });
      return ctx.step('slow', {
        input: null,
        schema: z.string(),
        run: async ({ signal }) => {
          if (state.fail) throw new Error('explicit slow failure');
          if (state.blocked) {
            entered.resolve();
            await delay(60_000, undefined, { signal });
          }
          return 'slow';
        },
      });
    },
  });
  return { before, entered, state, definition };
}

/** Start the workflow, abort it with `reason` once `slow` runs, and return the rejection. */
async function interrupt(
  workflow: ReturnType<typeof interruptible>,
  reason: unknown,
  extra: { readonly clock?: WorkflowClock } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const pending = runWorkflow(workflow.definition, {
    ...options(),
    ...extra,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await workflow.entered.promise;
  controller.abort(reason);
  return pending;
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-interruption-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('marked run interruptions', () => {
  it('save a resumable suspension that is due now and still reject', async () => {
    const workflow = interruptible();
    const error = await interrupt(workflow, new RunInterruptedError('Worker shutting down.'), {
      clock: fixedClock,
    });
    expect(error).toBeInstanceOf(WorkflowRunError);
    if (!(error instanceof WorkflowRunError)) throw error;
    expect(error.message).toBe('Worker shutting down.');
    expect(error.stepId).toBeNull();
    expect(error.run.status).toBe('suspended');
    const saved = await readRun(options());
    expect(error.run).toEqual(saved);
    expect(saved).toMatchObject({
      status: 'suspended',
      nextWakeAt: NOW,
      interruptedBy: { reason: 'Worker shutting down.', at: expect.any(String) as unknown },
      error: null,
      rootCause: null,
      output: null,
      steps: {
        before: { status: 'completed', output: 'before' },
        slow: { status: 'cancelled' },
      },
    });
    expect(Number.isNaN(Date.parse(saved.interruptedBy?.at ?? ''))).toBe(false);
    expect(saved.recoveryHint).toBeUndefined();
    expect(saved.executions?.at(-1)).toMatchObject({ outcome: 'suspended', error: null });
    expect(saved.events?.at(-1)).toMatchObject({ type: 'run.suspended', message: null });
  });

  it('clear interruptedBy when the next execution starts and never repeat completed steps', async () => {
    const workflow = interruptible();
    await interrupt(workflow, new RunInterruptedError());
    expect((await readRun(options())).interruptedBy).toEqual({
      reason: 'Workflow interrupted.',
      at: expect.any(String) as unknown,
    });
    // A failing resume proves the clear happens at start, not only on completion.
    workflow.state.fail = true;
    await expect(runWorkflow(workflow.definition, { ...options(), resume: true })).rejects.toThrow(
      'explicit slow failure',
    );
    const failed = await readRun(options());
    expect(failed.status).toBe('failed');
    expect(failed.interruptedBy).toBeUndefined();
    workflow.state.fail = false;
    workflow.state.blocked = false;
    const result = await runWorkflow(workflow.definition, { ...options(), resume: true });
    expect(result).toMatchObject({ status: 'completed', output: 'slow' });
    expect((await readRun(options())).interruptedBy).toBeUndefined();
    expect(workflow.before).toHaveBeenCalledTimes(1);
  });

  it('keep the crash-loop counter, since an interruption shows no progress', async () => {
    const workflow = interruptible();
    workflow.state.blocked = false;
    workflow.state.fail = true;
    await expect(runWorkflow(workflow.definition, options())).rejects.toThrow(
      'explicit slow failure',
    );
    const staleRecovery = { count: 2, completedSteps: 1, at: new Date().toISOString() };
    const owned = await new FileRunStore(stateDir).open('interrupted');
    try {
      const run = await owned.read();
      if (!run) throw new Error('missing run');
      run.staleRecovery = staleRecovery;
      await owned.append(run, { durable: true });
    } finally {
      await owned.release();
    }
    workflow.state.fail = false;
    workflow.state.blocked = true;
    const controller = new AbortController();
    const pending = runWorkflow(workflow.definition, {
      ...options(),
      resume: true,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await workflow.entered.promise;
    controller.abort(new RunInterruptedError('Tick timeout reached.'));
    expect(await pending).toBeInstanceOf(WorkflowRunError);
    expect(await readRun(options())).toMatchObject({
      status: 'suspended',
      interruptedBy: { reason: 'Tick timeout reached.' },
      staleRecovery,
    });
  });
});

describe('unmarked aborts and explicit failures', () => {
  it('save cancelled for an abort whose reason is a plain Error', async () => {
    const error = await interrupt(interruptible(), new Error('Embedder stop.'));
    expect(error).toBeInstanceOf(WorkflowRunError);
    const saved = await readRun(options());
    expect(saved).toMatchObject({
      status: 'cancelled',
      error: 'Embedder stop.',
      rootCause: { stepId: null, error: 'Embedder stop.' },
    });
    expect(saved.interruptedBy).toBeUndefined();
    expect(saved.executions?.at(-1)?.outcome).toBe('cancelled');
  });

  it('save cancelled for a CancelledError thrown by the body without any signal', async () => {
    const definition = defineWorkflow({
      name: 'scoped-cancel',
      version: '1',
      input: z.null(),
      output: z.null(),
      run: (): Promise<null> => Promise.reject(new CancelledError(null, new Error('stop'))),
    });
    await expect(runWorkflow(definition, options())).rejects.toBeInstanceOf(WorkflowRunError);
    const saved = await readRun(options());
    expect(saved.status).toBe('cancelled');
    expect(saved.interruptedBy).toBeUndefined();
  });

  it('save failed for an explicit failure even when a marked signal also fired', async () => {
    const waiting = deferred();
    const definition = defineWorkflow({
      name: 'explicit-failure',
      version: '1',
      input: z.null(),
      output: z.null(),
      // Application code that turns the abort into its own ordinary error.
      run: (ctx) =>
        new Promise<null>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('application failure'));
            },
            { once: true },
          );
          waiting.resolve();
        }),
    });
    const controller = new AbortController();
    const pending = runWorkflow(definition, { ...options(), signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await waiting.promise;
    controller.abort(new RunInterruptedError());
    const error = await pending;
    expect(error).toBeInstanceOf(WorkflowRunError);
    const saved = await readRun(options());
    expect(saved).toMatchObject({ status: 'failed', error: 'application failure' });
    expect(saved.interruptedBy).toBeUndefined();
  });
});

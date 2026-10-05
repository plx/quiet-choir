import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { it as base } from 'vitest';

import { runWorkflow } from '../../src/index.js';

// A per-test state directory that outlives every run and child process the test started in it
// (#174). With a shared module-level directory, a timed-out test left its run writing while
// afterEach removed the directory, so rm failed with ENOTEMPTY and one timeout became several
// failures. See CONTRIBUTING.md, "Per-test state directories".

/**
 * How long `runs` teardown waits for tracked work to settle after aborting it. Cancelled local
 * runs settle within milliseconds and a SIGKILLed child exits at once, so this only bounds a stuck
 * drain (for example a test that blocks `FileHandle.sync`); Vitest gives fixture teardown no
 * timeout, so without it a stuck drain would hang the worker.
 */
export const SETTLE_TIMEOUT_MS = 10_000;

/** Work a test started in its state directory, cancelled and awaited before the directory is removed. */
export interface RunScope {
  /** Aborts when the test times out or is cancelled (`TestContext.signal`) and when teardown starts. */
  readonly signal: AbortSignal;
  /** {@link runWorkflow} with {@link RunScope.signal} combined into `options.signal`, tracked. */
  readonly run: typeof runWorkflow;
  /** Wait for `work` to settle before the state directory is removed. Returns `work` unchanged. */
  track<T>(work: Promise<T>): Promise<T>;
  /**
   * Wait for `child` to exit before the state directory is removed. Create it with
   * `{ signal: runs.signal, killSignal: 'SIGKILL' }` so a timeout or teardown kills it.
   */
  child<C extends ChildProcess>(child: C): C;
}

/** A {@link RunScope} plus the teardown half the fixture drives. */
interface ManagedRunScope {
  readonly scope: RunScope;
  /** Abort the scope, then wait up to `timeoutMs` for tracked work; resolves to the unsettled count. */
  settle(timeoutMs: number): Promise<number>;
}

/** Build a run scope whose signal follows `testSignal`. */
function createRunScope(testSignal: AbortSignal): ManagedRunScope {
  const teardown = new AbortController();
  const signal = AbortSignal.any([testSignal, teardown.signal]);
  const pending = new Set<Promise<void>>();
  const record = (settled: Promise<void>) => {
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };
  const noop = () => undefined;
  function track<T>(work: Promise<T>): Promise<T> {
    record(work.then(noop, noop));
    return work;
  }
  const run = ((
    definition: Parameters<typeof runWorkflow>[0],
    options: Parameters<typeof runWorkflow>[1],
  ) =>
    track(
      runWorkflow(definition, {
        ...options,
        signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
      }),
    )) as typeof runWorkflow;
  function child<C extends ChildProcess>(spawned: C): C {
    // Without a listener, the AbortError a signal-killed child emits would crash the worker.
    spawned.on('error', noop);
    record(
      spawned.exitCode !== null || spawned.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            spawned.once('exit', () => {
              resolve();
            });
            // A child that never spawned emits 'error' and no 'exit'.
            spawned.once('error', () => {
              if (spawned.pid === undefined) resolve();
            });
          }),
    );
    return spawned;
  }
  return {
    scope: { signal, run, track, child },
    async settle(timeoutMs) {
      teardown.abort(new Error('Test finished; cancelling its unsettled runs.'));
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([Promise.allSettled([...pending]), deadline]);
      } finally {
        clearTimeout(timer);
      }
      return pending.size;
    },
  };
}

const unsettledDirectories = new WeakSet<object>();

/**
 * `it` with a per-test `stateDir` and the `runs` scope that settles work in it. Tests must
 * destructure fixtures in their first parameter, and parameterised cases must use `it.for`, because
 * `it.each` does not pass fixtures.
 */
export const it = base.extend<{
  /** Bound for the `runs` teardown; override with `it.override({ settleTimeoutMs })` in a describe. */
  settleTimeoutMs: number;
  /** A fresh directory for this test, removed after `runs` has settled. */
  stateDir: string;
  /** Cancels and awaits this test's runs and children before `stateDir` is removed. */
  runs: RunScope;
}>({
  settleTimeoutMs: SETTLE_TIMEOUT_MS,
  stateDir: async ({ task }, use) => {
    const prefix = basename(task.file.name).replace(/\.test\.ts$/u, '');
    const directory = await fs.mkdtemp(join(tmpdir(), `choir-${prefix}-`));
    await use(directory);
    // `runs` depends on `stateDir`, so its teardown has already run. Without retries: settling is
    // the fix, and a retry would hide a regression.
    if (!unsettledDirectories.has(task)) await fs.rm(directory, { recursive: true, force: true });
  },
  runs: async ({ stateDir, signal, task, settleTimeoutMs }, use) => {
    const managed = createRunScope(signal);
    await use(managed.scope);
    const unsettled = await managed.settle(settleTimeoutMs);
    if (unsettled === 0) return;
    // Leave the directory: removing it under a live writer is what this fixture exists to prevent.
    unsettledDirectories.add(task);
    throw new Error(
      `${String(unsettled)} run(s) or child process(es) did not settle within ` +
        `${String(settleTimeoutMs)} ms of cancellation; leaving ${stateDir} in place.`,
    );
  },
});

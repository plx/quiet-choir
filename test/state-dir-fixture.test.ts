import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, type TestContext } from 'vitest';
import { defineWorkflow, WorkflowRunError, z } from '../src/index.js';
import { it } from './setup/state-dir.js';

// Regression for #174. Tests in one file run in order, so each `it.fails` case below records what
// it observed in module variables and the next case asserts on them. `it.fails` lets a case time
// out on purpose; `onTestFailed` runs after fixture teardown and before the `fails` flip, so it sees
// every error the case produced, including any teardown error such as ENOTEMPTY.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Collect the failed case's error messages into `into`. */
function captureErrors(onTestFailed: TestContext['onTestFailed'], into: string[]): void {
  onTestFailed(({ task }) => {
    into.push(...(task.result?.errors ?? []).map((error) => error.message));
  });
}

/** Appends to `input` every few milliseconds until the step is cancelled. */
function writer(entered = deferred()) {
  return defineWorkflow({
    name: 'writer',
    version: '1',
    input: z.string(),
    output: z.null(),
    run: (ctx, file) =>
      ctx.step('write', {
        input: file,
        schema: z.null(),
        run: async ({ signal }) => {
          entered.resolve();
          while (!signal.aborted) {
            appendFileSync(file, 'x\n');
            await delay(5, undefined, { signal }).catch(() => undefined);
          }
          signal.throwIfAborted();
          return null;
        },
      }),
  });
}

interface Settled {
  error: unknown;
  directoryExisted: boolean;
}

/** Record how `run` settled and whether `directory` still existed at that moment. */
function observe(run: Promise<unknown>, directory: string, into: (settled: Settled) => void) {
  run.then(
    () => {
      into({ error: undefined, directoryExisted: existsSync(directory) });
    },
    (error: unknown) => {
      into({ error, directoryExisted: existsSync(directory) });
    },
  );
}

function expectCancelled(settled: Settled | undefined, reason: RegExp): void {
  expect(settled?.directoryExisted).toBe(true);
  expect(settled?.error).toBeInstanceOf(WorkflowRunError);
  const error = settled?.error as WorkflowRunError;
  expect(error.run.status).toBe('cancelled');
  expect(error.message).toMatch(reason);
}

let first = '';
it('gives each test a fresh directory and a live run signal', ({ stateDir, runs }) => {
  first = stateDir;
  expect(existsSync(stateDir)).toBe(true);
  expect(basename(stateDir)).toMatch(/^choir-state-dir-fixture-/u);
  expect(runs.signal.aborted).toBe(false);
});

it('removes the previous directory and allocates a distinct one', ({ stateDir }) => {
  expect(stateDir).not.toBe(first);
  expect(existsSync(first)).toBe(false);
});

it('combines a caller signal with the test signal', async ({ stateDir, runs }) => {
  const controller = new AbortController(),
    entered = deferred();
  let settled: Settled | undefined;
  const run = runs.run(writer(entered), {
    stateDir,
    runId: 'caller',
    input: join(stateDir, 'out.txt'),
    signal: controller.signal,
  });
  observe(run, stateDir, (value) => (settled = value));
  await entered.promise;
  controller.abort(new Error('caller abort'));
  await expect(run).rejects.toThrow('caller abort');
  expectCancelled(settled, /caller abort/u);
  expect(runs.signal.aborted).toBe(false);
});

const runTimeout: { errors: string[]; directory: string; settled?: Settled } = {
  errors: [],
  directory: '',
};
it.fails(
  'times out while an in-process run is writing into stateDir',
  async ({ stateDir, runs, onTestFailed }) => {
    runTimeout.directory = stateDir;
    captureErrors(onTestFailed, runTimeout.errors);
    const run = runs.run(writer(), {
      stateDir,
      runId: 'timeout',
      input: join(stateDir, 'out.txt'),
    });
    observe(run, stateDir, (value) => (runTimeout.settled = value));
    await run;
  },
  500,
);

it('cancelled that run before removing its directory, without a teardown error', () => {
  expect(runTimeout.errors).toHaveLength(1);
  expect(runTimeout.errors[0]).toMatch(/^Test timed out in 500ms/u);
  expectCancelled(runTimeout.settled, /^Test timed out/u);
  expect(existsSync(runTimeout.directory)).toBe(false);
});

const childTimeout: {
  errors: string[];
  directory: string;
  signal?: NodeJS.Signals | null;
  directoryExisted?: boolean;
} = { errors: [], directory: '' };
it.fails(
  'times out while a child process is writing into stateDir',
  async ({ stateDir, runs, onTestFailed }) => {
    childTimeout.directory = stateDir;
    captureErrors(onTestFailed, childTimeout.errors);
    const child = runs.child(
      spawn(
        process.execPath,
        [
          '-e',
          "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x\\n'), 5);",
          join(stateDir, 'out.txt'),
        ],
        { signal: runs.signal, killSignal: 'SIGKILL', stdio: 'ignore' },
      ),
    );
    await new Promise<void>((resolve) => {
      child.once('exit', (_code, signal) => {
        childTimeout.signal = signal;
        childTimeout.directoryExisted = existsSync(stateDir);
        resolve();
      });
    });
  },
  500,
);

it('killed that child and waited for its exit before removing its directory', () => {
  expect(childTimeout.errors).toHaveLength(1);
  expect(childTimeout.errors[0]).toMatch(/^Test timed out in 500ms/u);
  expect(childTimeout.signal).toBe('SIGKILL');
  expect(childTimeout.directoryExisted).toBe(true);
  expect(existsSync(childTimeout.directory)).toBe(false);
});

const unawaited: { directory: string; settled?: Settled } = { directory: '' };
it('returns while a run it did not await is still writing', async ({ stateDir, runs }) => {
  unawaited.directory = stateDir;
  const entered = deferred();
  const run = runs.run(writer(entered), {
    stateDir,
    runId: 'unawaited',
    input: join(stateDir, 'out.txt'),
  });
  observe(run, stateDir, (value) => (unawaited.settled = value));
  await entered.promise;
});

it('cancelled that run at teardown before removing its directory', () => {
  expectCancelled(unawaited.settled, /^Test finished; cancelling its unsettled runs\./u);
  expect(existsSync(unawaited.directory)).toBe(false);
});

describe('when tracked work never settles', () => {
  it.override({ settleTimeoutMs: 50 });
  const stuck: { errors: string[]; directory: string } = { errors: [], directory: '' };

  it.fails('fails the test that owns the work', ({ stateDir, runs, onTestFailed }) => {
    stuck.directory = stateDir;
    captureErrors(onTestFailed, stuck.errors);
    void runs.track(new Promise<never>(() => undefined));
  });

  it('names the directory and leaves it in place', async () => {
    expect(stuck.errors).toHaveLength(1);
    expect(stuck.errors[0]).toContain('1 run(s) or child process(es) did not settle within 50 ms');
    expect(stuck.errors[0]).toContain(stuck.directory);
    expect(existsSync(stuck.directory)).toBe(true);
    await fs.rm(stuck.directory, { recursive: true, force: true });
  });
});

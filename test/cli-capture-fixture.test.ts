import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, type TestContext } from 'vitest';
import {
  it,
  type CapturedCommand,
  type CliCapture,
  type RunnableCommand,
} from './setup/cli-capture.js';

// Regression for #249. Tests in one file run in order, so the `it.fails` cases below record what
// they observed in module variables and the next case asserts on them. Before the fixture, a
// timed-out cli.test.ts body kept calling the shared capture helper during later tests: it
// re-pointed their console spies (so they saw empty stdout) and wrote process.exitCode. The fake
// commands here stand in for oclif command classes.

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

/** A command that logs `stdout`, errors `stderr` and sets `exitCode`, after `before` settles. */
function fake(
  options: {
    stdout?: unknown[];
    stderr?: unknown[];
    exitCode?: number;
    before?: () => Promise<unknown>;
    onStart?: (argv: string[]) => void;
    onEnd?: () => void;
  } = {},
): RunnableCommand {
  return {
    async run(argv) {
      options.onStart?.(argv);
      await options.before?.();
      for (const message of options.stdout ?? []) console.log(message);
      for (const message of options.stderr ?? []) console.error(message);
      if (options.exitCode !== undefined) process.exitCode = options.exitCode;
      options.onEnd?.();
    },
  };
}

it('captures the stdout, stderr and exit code of one call and resets process.exitCode around it', async ({
  cli,
}) => {
  process.exitCode = 9;
  let exitCodeAtStart: unknown = 'unobserved';
  let receivedArgv: string[] = [];
  const output = await cli.run(
    fake({
      stdout: ['out', { value: 1 }],
      stderr: ['err'],
      exitCode: 3,
      onStart: (argv) => {
        exitCodeAtStart = process.exitCode;
        receivedArgv = argv;
      },
    }),
    ['--flag'],
  );
  expect(exitCodeAtStart).toBeUndefined();
  expect(receivedArgv).toEqual(['--flag']);
  expect(output).toEqual({
    error: undefined,
    stdout: 'out\n{ value: 1 }',
    stderr: 'err',
    exitCode: 3,
  });
  expect(process.exitCode).toBeUndefined();
});

it('returns a thrown error and restores the console', async ({ cli }) => {
  const failure = new Error('boom');
  const originalLog = console.log;
  const output = await cli.run({
    run: () => Promise.reject(failure),
  });
  expect(output.error).toBe(failure);
  expect(output.stdout).toBe('');
  expect(console.log).toBe(originalLog);
});

it('refuses a second call while one is in flight', async ({ cli }) => {
  const release = deferred();
  const first = cli.run(fake({ stdout: ['first'], before: () => release.promise }));
  await expect(cli.run(fake({ stdout: ['second'] }))).rejects.toThrow(
    'cli.run called while another cli.run from this test is still running',
  );
  release.resolve();
  expect((await first).stdout).toBe('first');
  expect((await cli.run(fake({ stdout: ['third'] }))).stdout).toBe('third');
});

const stale: {
  errors: string[];
  cli?: CliCapture;
  settled: boolean;
  result?: CapturedCommand;
  refusal?: string;
  continued: Promise<void>;
} = { errors: [], settled: false, continued: Promise.resolve() };
it.fails(
  'times out while a command is running and keeps calling cli.run afterwards',
  async ({ cli, onTestFailed }) => {
    stale.cli = cli;
    captureErrors(onTestFailed, stale.errors);
    const continued = deferred();
    stale.continued = continued.promise;
    try {
      stale.result = await cli.run(
        fake({
          before: () => delay(200),
          stdout: ['stale-marker'],
          exitCode: 75,
          onEnd: () => {
            stale.settled = true;
          },
        }),
      );
      // This continuation runs after the test has timed out, as cli.test.ts bodies did.
      await cli.run(fake({ stdout: ['stale-follow-up'], exitCode: 76 }));
    } catch (error: unknown) {
      stale.refusal = error instanceof Error ? error.message : String(error);
    } finally {
      continued.resolve();
    }
  },
  50,
);

it('drained that command before this test and refuses the stale handle', async ({ cli }) => {
  expect(stale.settled).toBe(true);
  expect(process.exitCode).toBeUndefined();
  expect(stale.errors).toHaveLength(1);
  expect(stale.errors[0]).toMatch(/^Test timed out in 50ms/u);
  // The drained command still captured into its own result.
  expect(stale.result).toMatchObject({ stdout: 'stale-marker', exitCode: 75 });
  await stale.continued;
  expect(stale.refusal).toBe(
    'cli.run called after its test ended (a timed-out test body is still running)',
  );

  const output = await cli.run(fake({ stdout: ['fresh'] }));
  expect(output.stdout).toBe('fresh');
  expect(output.exitCode).toBeUndefined();
  await expect(stale.cli?.run(fake({ stdout: ['late'] }))).rejects.toThrow(
    'cli.run called after its test ended',
  );
});

describe('when a command does not settle within the teardown bound', () => {
  it.override({ settleTimeoutMs: 50 });
  const stuck: { errors: string[]; settled: Promise<void> } = {
    errors: [],
    settled: Promise.resolve(),
  };

  it.fails('fails the test that started it', ({ cli, onTestFailed }) => {
    captureErrors(onTestFailed, stuck.errors);
    const settled = deferred();
    stuck.settled = settled.promise;
    void cli.run(fake({ before: () => delay(300), onEnd: settled.resolve }));
  });

  it('names the test in the teardown error', async () => {
    expect(stuck.errors).toEqual([
      'A cli.run call from "fails the test that started it" did not settle within 50 ms of the ' +
        'test ending; it may still write to the console or process.exitCode.',
    ]);
    await stuck.settled;
  });
});

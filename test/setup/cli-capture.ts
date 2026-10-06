import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { vi } from 'vitest';

import { SETTLE_TIMEOUT_MS, it as stateDirIt } from './state-dir.js';

// A per-test handle for running oclif command classes in process and capturing their output and
// exit code (#249). Vitest does not cancel a timed-out test body, so a shared capture helper let
// the abandoned body keep running commands during later tests: its `vi.spyOn(console, …)` reused
// and re-pointed the current test's console spies (so the current test saw empty stdout), and its
// commands wrote `process.exitCode`. This handle refuses calls after its test ends, refuses
// overlapping calls, and its teardown drains the call in flight before the next test starts. See
// CONTRIBUTING.md, "CLI command capture".

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** An oclif command class, or any object with the same static `run`. */
export interface RunnableCommand {
  run(argv: string[], options: { root: string }): Promise<unknown>;
}

/** What one {@link CliCapture.run} call observed. */
export interface CapturedCommand {
  /** The error the command threw (for example an oclif `ExitError`), or `undefined`. */
  readonly error: unknown;
  /** Everything the command passed to `console.error`, joined with newlines. */
  readonly stderr: string;
  /** Everything the command passed to `console.log`, joined with newlines. */
  readonly stdout: string;
  /** `process.exitCode` as the command left it; it is reset to `undefined` before and after. */
  readonly exitCode: string | number | null | undefined;
}

/** Runs commands for one test, one at a time. */
export interface CliCapture {
  /**
   * Run `command` with `argv` from the project root and capture its console output and exit code.
   * Rejects after the test has ended and while another call from this handle is in flight.
   */
  run(command: RunnableCommand, argv?: string[]): Promise<CapturedCommand>;
}

/** A {@link CliCapture} plus the teardown half the fixture drives. */
interface ManagedCliCapture {
  readonly capture: CliCapture;
  /** Refuse further calls, then wait up to `timeoutMs` for the call in flight; true if it settled. */
  close(timeoutMs: number): Promise<boolean>;
}

function render(message: unknown): string {
  return typeof message === 'string' ? message : inspect(message);
}

function createCliCapture(): ManagedCliCapture {
  let closed = false;
  let busy = false;
  let inFlight: Promise<void> | undefined;

  async function invoke(command: RunnableCommand, argv: string[]): Promise<CapturedCommand> {
    const standardOutput: string[] = [];
    const standardError: string[] = [];
    process.exitCode = undefined;
    const log = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      standardOutput.push(render(message));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      standardError.push(render(message));
    });
    let caught: unknown;
    let exitCode: CapturedCommand['exitCode'];
    try {
      await command.run(argv, { root: projectRoot });
    } catch (thrown: unknown) {
      caught = thrown;
    } finally {
      log.mockRestore();
      error.mockRestore();
      exitCode = process.exitCode;
      process.exitCode = undefined;
      // Cleared before `run`'s promise settles, so an awaiting caller can run the next command.
      busy = false;
    }
    return {
      error: caught,
      exitCode,
      stderr: standardError.join('\n'),
      stdout: standardOutput.join('\n'),
    };
  }

  return {
    capture: {
      run(command, argv = []) {
        if (closed) {
          return Promise.reject(
            new Error(
              'cli.run called after its test ended (a timed-out test body is still running)',
            ),
          );
        }
        if (busy) {
          return Promise.reject(
            new Error('cli.run called while another cli.run from this test is still running'),
          );
        }
        busy = true;
        const call = invoke(command, argv);
        inFlight = call.then(
          () => undefined,
          () => undefined,
        );
        return call;
      },
    },
    async close(timeoutMs) {
      closed = true;
      const pending = inFlight;
      if (!busy || !pending) return true;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      try {
        return await Promise.race([pending.then(() => true), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * `it` from `./state-dir.js` with a per-test `cli` capture. Destructure fixtures in the handler's
 * first parameter (`async ({ cli }) => …`), and use `it.for` for parameterised cases, because
 * `it.each` does not pass fixtures.
 */
export const it = stateDirIt.extend<{
  /** Runs this test's CLI commands; drained at teardown so none overlaps a later test. */
  cli: CliCapture;
}>({
  cli: async ({ task }, use) => {
    const managed = createCliCapture();
    await use(managed.capture);
    // Vitest gives fixture teardown no timeout, so bound the drain like the `runs` fixture does.
    const settled = await managed.close(SETTLE_TIMEOUT_MS);
    process.exitCode = undefined;
    if (settled) return;
    throw new Error(
      `A cli.run call from "${task.name}" did not settle within ${String(SETTLE_TIMEOUT_MS)} ms ` +
        'of the test ending; it may still write to the console or process.exitCode.',
    );
  },
});

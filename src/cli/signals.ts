import { writeSync } from 'node:fs';
import type { ProcessSupervisor } from '../processes/supervisor.js';
import { RunInterruptedError } from '../workflow/runtime/run-errors.js';

/** A vanished terminal must not interrupt child cleanup. @internal */
export function terminalError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EPIPE' || error.code === 'EIO')
  );
}

/** Longest a forced exit waits for a stalled reader to accept the JSON document. @internal */
export const FORCED_OUTPUT_TIMEOUT_MS = 5000;

const RETRY_SLEEP_MS = 5;

/** Block this thread without spinning. The forced path cannot yield to the event loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Injectable collaborators for {@link writeAllSync}. @internal */
export interface WriteAllOptions {
  /** Defaults to `fs.writeSync`. */
  readonly write?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  /** Defaults to a synchronous `Atomics.wait` sleep. */
  readonly sleep?: (ms: number) => void;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Total time allowed for the whole write. Defaults to {@link FORCED_OUTPUT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Write all of `text` to `fd` synchronously, for a process that is about to `process.exit`.
 *
 * A single `writeSync` is not enough on a pipe. Touching `process.stdout` makes libuv put a piped
 * fd 1 into non-blocking mode, so once the pipe buffer (64 KiB or less) is full `writeSync` writes
 * part of the text, returns a short count, or throws `EAGAIN`. This loop advances by the returned
 * count and retries `EAGAIN`, or a zero-byte write, after a short sleep until the total deadline.
 * It stays synchronous because the forced path runs inside a signal listener that ends in
 * `process.exit`, where the event loop and an asynchronous drain are unavailable.
 *
 * Returns `closed` when the reader is gone (`EPIPE`/`EIO`, the errors {@link terminalError}
 * accepts) and `timeout` when the reader stayed stalled past the deadline. Any other error is
 * rethrown. @internal
 */
export function writeAllSync(
  fd: number,
  text: string,
  options: WriteAllOptions = {},
): 'complete' | 'closed' | 'timeout' {
  const write = options.write ?? writeSync;
  const sleep = options.sleep ?? sleepSync;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? FORCED_OUTPUT_TIMEOUT_MS);
  // Slice bytes, not the string, so multibyte characters survive a short write.
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    let written = 0;
    try {
      written = write(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (terminalError(error)) return 'closed';
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error;
    }
    offset += written;
    if (offset >= bytes.length) break;
    if (now() >= deadline) return 'timeout';
    if (written === 0) sleep(RETRY_SLEEP_MS);
  }
  return 'complete';
}

let terminalHandlersInstalled = false;
/** Install once for the command process, including asynchronous stream failures after logging. @internal */
export function tolerateClosedTerminal(): void {
  if (terminalHandlersInstalled) return;
  terminalHandlersInstalled = true;
  for (const stream of [process.stdout, process.stderr])
    stream.on('error', (error: Error) => {
      if (!terminalError(error)) throw error;
    });
}

/**
 * First signal drains and marks the abort as an external interruption, so a run saves a resumable
 * suspension; any second signal synchronously kills all owned groups before exit. @internal
 */
export function executionSignals(
  supervisor: ProcessSupervisor,
  log: (message: string) => void,
  label = 'Workflow',
  onForce?: () => void,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const cancel = (name: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      supervisor.forceKill();
      try {
        onForce?.();
      } finally {
        process.exit(130);
      }
    }
    controller.abort(new RunInterruptedError(`${label} interrupted by ${name}.`));
    try {
      log(`${label} interrupted; draining active work. Send again to force.`);
    } catch (error) {
      if (!terminalError(error)) throw error;
    }
  };
  // Bind each name: the listener argument is absent when a signal is emitted programmatically.
  const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((name) => {
    const listener = (): void => {
      cancel(name);
    };
    return [name, listener] as const;
  });
  for (const [name, listener] of listeners) process.on(name, listener);
  return {
    signal: controller.signal,
    dispose() {
      for (const [name, listener] of listeners) process.removeListener(name, listener);
    },
  };
}

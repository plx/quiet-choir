import type { ProcessSupervisor } from '../processes/supervisor.js';
import { RunInterruptedError } from '../workflow/runtime/run-errors.js';

/** A vanished terminal must not interrupt child cleanup. @internal */
export function terminalError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EPIPE' || error.code === 'EIO')
  );
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

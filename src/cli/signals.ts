import type { ProcessSupervisor } from '../processes/supervisor.js';

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

/** First signal drains; any second signal synchronously kills all owned groups before exit. @internal */
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
  const cancel = (): void => {
    if (controller.signal.aborted) {
      supervisor.forceKill();
      try {
        onForce?.();
      } finally {
        process.exit(130);
      }
    }
    controller.abort(new Error(`${label} interrupted.`));
    try {
      log(`${label} interrupted; draining active work. Send again to force.`);
    } catch (error) {
      if (!terminalError(error)) throw error;
    }
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(name, cancel);
  return {
    signal: controller.signal,
    dispose() {
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
        process.removeListener(name, cancel);
    },
  };
}

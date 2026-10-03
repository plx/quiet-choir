import type { AgentRequest } from '../workflow/runtime/harness-model.js';
import type { HarnessInvocation } from '../workflow/runtime/model.js';
import type { AgentProgress } from '../workflow/runtime/agent-stream-model.js';

/** Minimum gap between delivered progress events, after the first `init` event. */
const progressIntervalMs = 100;

/** Inputs of {@link createInvocationStream}. */
export interface InvocationStreamOptions {
  /** The runtime's hooks for this call; without one, every method only forwards or does nothing. */
  readonly invocation?: HarnessInvocation | undefined;
  /**
   * Downstream stdout consumer, such as `lines.feed` of a {@link JsonLines}, awaited after the raw
   * chunk has been teed to `invocation.onOutput`.
   */
  readonly stdout?: ((chunk: Uint8Array) => void | Promise<void>) | undefined;
}

/**
 * The session, raw-output and progress plumbing of one adapter call. `stdout` and `stderr` can be
 * passed directly as {@link runProcess}'s `stream.stdout` and `stream.stderr`.
 */
export interface InvocationStream {
  /** Tee a stdout chunk to `onOutput`, then await the downstream consumer, in that order. */
  readonly stdout: (chunk: Uint8Array) => Promise<void>;
  /** Tee a stderr chunk to `onOutput`. */
  readonly stderr: (chunk: Uint8Array) => Promise<void>;
  /**
   * Report a native session ID. Only the first nonempty ID reaches `onSession`, which is awaited:
   * call this before consuming further output so the ID is durable first. The ID counts as
   * reported only once `onSession` resolves; a rejection propagates and a later call retries.
   */
  readonly session: (sessionId: string) => Promise<void>;
  /**
   * Deliver a lossy progress observation. The first `init` event is always delivered; otherwise at
   * most one event per 100 ms reaches `onProgress`, and observer exceptions are swallowed.
   */
  readonly progress: (event: AgentProgress) => void;
}

/**
 * Own the {@link HarnessInvocation} contracts an adapter must honor while it streams a native
 * process: the backpressured `onOutput` tee before parsing, `onSession` once and awaited, and
 * throttled, never-failing `onProgress`. Built-in adapters use the same implementation.
 */
export function createInvocationStream(options: InvocationStreamOptions = {}): InvocationStream {
  const { invocation, stdout: downstream } = options;
  let reportedSession = false;
  let pendingSession: Promise<void> | undefined;
  let reportedInit = false;
  let lastProgress = -Infinity;
  return {
    stdout: async (chunk) => {
      await invocation?.onOutput?.('stdout', chunk);
      await downstream?.(chunk);
    },
    stderr: async (chunk) => {
      await invocation?.onOutput?.('stderr', chunk);
    },
    session: async (sessionId) => {
      if (reportedSession || !sessionId) return;
      if (pendingSession === undefined) {
        const report = (async () => {
          await invocation?.onSession?.(sessionId);
          reportedSession = true;
        })();
        pendingSession = report;
        // A rejected report may be retried by a later call.
        report.catch(() => {
          if (pendingSession === report) pendingSession = undefined;
        });
      }
      await pendingSession;
    },
    progress: (event) => {
      const now = performance.now();
      if (!(event.kind === 'init' && !reportedInit) && now - lastProgress < progressIntervalMs)
        return;
      lastProgress = now;
      if (event.kind === 'init') reportedInit = true;
      try {
        invocation?.onProgress?.(event);
      } catch {
        // Observers are lossy diagnostics; they never invalidate native work.
      }
    },
  };
}

/**
 * A {@link HarnessInvocation} for a call made outside the runtime, such as a test or a script
 * calling `adapter.invoke(request, signal)` without one. It carries the request's identity and
 * `signal`, has no session, output or progress hooks, and its `trackProcess` registers nothing and
 * returns a release that resolves at once; the adapter still reaps its own processes.
 */
export function standaloneInvocation(
  request: Pick<AgentRequest, 'runId' | 'stepId' | 'attempt'>,
  signal: AbortSignal,
): HarnessInvocation {
  return {
    runId: request.runId,
    stepId: request.stepId,
    attempt: request.attempt,
    signal,
    trackProcess: () => Promise.resolve({ release: () => Promise.resolve() }),
  };
}

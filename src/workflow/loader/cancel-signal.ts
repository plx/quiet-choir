import { matchingCancelRequestSync } from '../runtime/cancel-request.js';
import { RunInterruptedError } from '../runtime/run-errors.js';

/** The run signal of one live execution, and its listener's removal. @internal */
export interface CancellableRunSignal {
  readonly signal: AbortSignal;
  /** Whether the signal aborted because a matching cancel request was honoured. */
  readonly cancelled: boolean;
  dispose(): void;
}

/**
 * Wrap an execution's signal so that a marked interruption (`RunInterruptedError`, such as the CLI's
 * first SIGINT) becomes an unmarked cancellation when `workflow cancel` left a request bound to this
 * process's current lock token. The runner then saves `cancelled` instead of a resumable
 * `suspended` run. Any other abort reason, and any interruption without a matching request, is
 * forwarded unchanged (ADR 0029, ADR 0039). @internal
 */
export function cancellableRunSignal(
  outer: AbortSignal,
  target: { readonly stateDir: string; readonly runId: string },
  onCancel?: (message: string) => void,
): CancellableRunSignal {
  const controller = new AbortController();
  let cancelled = false;
  const forward = (): void => {
    const reason: unknown = outer.reason;
    let request: { readonly requestedAt: string } | undefined;
    if (reason instanceof RunInterruptedError)
      try {
        request = matchingCancelRequestSync(target.stateDir, target.runId);
      } catch {
        request = undefined;
      }
    if (request === undefined) {
      controller.abort(reason);
      return;
    }
    cancelled = true;
    controller.abort(
      new Error(
        `Run ${target.runId} cancelled by workflow cancel (requested ${request.requestedAt}).`,
      ),
    );
    try {
      onCancel?.(`Run ${target.runId}: cancel requested by workflow cancel; draining.`);
    } catch {
      /* Logging must not change the cancellation. */
    }
  };
  if (outer.aborted) forward();
  else outer.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    get cancelled() {
      return cancelled;
    },
    dispose() {
      outer.removeEventListener('abort', forward);
    },
  };
}

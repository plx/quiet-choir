/**
 * The settle rules a settled map item and an `onError: 'return'` child frame share, so the two
 * cannot drift (ADR 0007, ADR 0008).
 */
import type { FailureOrigins, MapStepError } from './fan-out.js';
import type { MapperScope } from './scopes.js';
import type { RunRecord } from './record.js';
import { errorKind, stepError } from './step-error.js';

/** Facts the caller gathers about a failure it may settle. @internal */
export interface SettleFacts {
  /** Whether the scope that owns the settled map or frame was cancelled. */
  readonly parentAborted: boolean;
  /**
   * Whether a cancellation is the settled scope's own (a return map's `cancelSiblings`); only that
   * cancellation becomes settled data. Always false for a child frame.
   */
  readonly ownCancellation: boolean;
  /** Whether the error is this run's own checkpoint failure. */
  readonly checkpointFailure: boolean;
  /** Fatal authoring, configuration and budget errors never settle. */
  readonly origins: FailureOrigins;
}

/**
 * Whether a failure may become a settled outcome: the owning scope is not cancelled, the failure is
 * not a cancellation (unless it is the settled scope's own), and it is neither this run's checkpoint
 * failure nor a fatal error. @internal
 */
export function settlesFailure(error: unknown, facts: SettleFacts): boolean {
  return (
    !facts.parentAborted &&
    (errorKind(error) !== 'cancelled' || facts.ownCancellation) &&
    !facts.checkpointFailure &&
    !facts.origins.isFatal(error)
  );
}

/**
 * A settled failure attributed to its originating effect, with that effect's started attempts (one
 * for a body error without an effect). @internal
 */
export function settledFailure(
  origin: { readonly error: unknown; readonly stepId: string | null },
  record: RunRecord,
): { ok: false; error: MapStepError } {
  return {
    ok: false,
    error: {
      ...stepError(
        origin.error,
        origin.stepId === null ? 1 : (record.steps[origin.stepId]?.attempts ?? 1),
      ),
      stepId: origin.stepId,
    },
  };
}

/** The leaf, settled map and child frame IDs a settled scope owns, limited to recorded ones. @internal */
export function ownedRecords(
  scope: MapperScope,
  record: RunRecord,
): { steps: string[]; maps: string[]; children: string[] } {
  return {
    steps: [...scope.steps].filter((id) => Object.hasOwn(record.steps, id)),
    maps: [...scope.maps].filter((id) => Object.hasOwn(record.maps ?? {}, id)),
    children: [...scope.children],
  };
}

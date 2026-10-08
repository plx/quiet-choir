import type { ErrorKind } from '../runtime/model.js';
import type { AttemptRecord } from '../runtime/record.js';
import type { RunRecord, StepRecord } from '../runtime/store.js';
import { isTransientErrorKind } from '../runtime/step-error.js';

/** A run's root cause with its error kind always present. @internal */
export interface RootCauseSummary {
  readonly stepId: string | null;
  readonly error: string;
  readonly errorKind: ErrorKind | null;
}

/** One attempt's recorded error kind, or null for a missing attempt or a missing kind. @internal */
export function attemptErrorKind(
  attempt: Pick<AttemptRecord, 'errorKind'> | undefined,
): ErrorKind | null {
  return attempt?.errorKind ?? null;
}

/** A step's error kind: the kind of its last recorded attempt, or null without one. @internal */
export function stepErrorKind(step: Pick<StepRecord, 'attemptHistory'>): ErrorKind | null {
  return attemptErrorKind(step.attemptHistory?.at(-1));
}

/**
 * The root cause's error kind. Records written since the kind was stored return it directly. An
 * older record falls back to the root step's last attempt, which is null when the step is missing
 * or has no attempt, and for a body failure. Nothing is rewritten. @internal
 */
export function rootCauseErrorKind(run: Pick<RunRecord, 'rootCause' | 'steps'>): ErrorKind | null {
  const cause = run.rootCause;
  if (!cause) return null;
  if (cause.errorKind !== undefined) return cause.errorKind;
  if (cause.stepId === null) return null;
  const step = run.steps[cause.stepId];
  return step ? stepErrorKind(step) : null;
}

/** The run's root cause with `errorKind` normalized through {@link rootCauseErrorKind}. @internal */
export function rootCauseSummary(
  run: Pick<RunRecord, 'rootCause' | 'steps'>,
): RootCauseSummary | null {
  const cause = run.rootCause;
  if (!cause) return null;
  return { stepId: cause.stepId, error: cause.error, errorKind: rootCauseErrorKind(run) };
}

/** The failure-document pair for a kind: `retryable` means membership in the transient set. @internal */
export function failureKind(kind: ErrorKind | null): {
  readonly errorKind: ErrorKind | null;
  readonly retryable: boolean;
} {
  return { errorKind: kind, retryable: isTransientErrorKind(kind) };
}

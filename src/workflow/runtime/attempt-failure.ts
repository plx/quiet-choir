/**
 * Pure classification of one failed effect attempt, following
 * [ADR 0007](../../../docs/decisions/0007-durable-failure-outcomes.md).
 *
 * The function is pure: no I/O, no clock, no store. The runner gathers the facts, calls it once
 * per failed attempt, and performs every side effect (saves, events, cancellation errors,
 * backoff) from the result. ESLint keeps this module free of runtime imports.
 */
import type { ErrorKind, ErrorMode } from './model.js';
import { ConfigurationError } from './configuration-error.js';
import { errorKind } from './step-error.js';

/** Facts about one failed attempt, all gathered by the runner before classification. @internal */
export interface AttemptFailureInput {
  /** The error the attempt threw, after any transcript-close storage failure replaced it. */
  readonly cause: unknown;
  /** Whether the effect's scope signal is aborted. */
  readonly aborted: boolean;
  /** Whether `cause` is one of this run's own recorded checkpoint failures. */
  readonly checkpointProblem: boolean;
  /** The retry filter: `undefined` retries every kind and `[]` retries none. */
  readonly retryOn: readonly ErrorKind[] | undefined;
  /** The one-based number of the attempt that just failed. */
  readonly attempt: number;
  /** The most attempts the effect may make. */
  readonly maxAttempts: number;
  /** The effect's failure mode; `undefined` behaves as `'throw'`. */
  readonly onError: ErrorMode | undefined;
}

/** What the runner should do about a failed attempt. @internal */
export interface AttemptFailure {
  /** The failure is a scope cancellation: the signal aborted for a reason other than this run's storage. */
  readonly scoped: boolean;
  /** The status recorded on the step and the attempt. */
  readonly status: 'cancelled' | 'failed';
  /** The failure kind used for retry filtering: `'cancelled'` for a scope cancellation. */
  readonly errorKind: ErrorKind;
  /** The failure is this run's own storage failure or a configuration failure. */
  readonly infrastructure: boolean;
  /** The error must never become settled map data (configuration failures). */
  readonly markFatal: boolean;
  /** The failure is never retried and never settled. */
  readonly fatal: boolean;
  /** Another attempt follows after backoff. */
  readonly retry: boolean;
  /** The failure becomes a settled `onError: 'return'` result. */
  readonly settle: boolean;
}

/**
 * Classify a failed attempt.
 *
 * - Only an aborted signal that is not this run's own checkpoint failure is a scope cancellation.
 * - A callback's own `AbortError` fails the step with its message (`failed`, kind `cancelled`) but
 *   is still fatal: never retried or settled.
 * - Cancellation, this run's checkpoint failures and `ConfigurationError` are fatal. A domain
 *   error that merely reuses `CheckpointError` is not infrastructure.
 * - `retry.on` omitted retries every kind and `[]` retries none, bounded by `maxAttempts`.
 * - Settling happens only for a failure that is not fatal, not retried and has `onError: 'return'`.
 *
 * @internal
 */
export function classifyAttemptFailure(input: AttemptFailureInput): AttemptFailure {
  const { cause, aborted, checkpointProblem, retryOn, attempt, maxAttempts, onError } = input;
  const scoped = aborted && !checkpointProblem;
  const kind = scoped ? 'cancelled' : errorKind(cause);
  const markFatal = cause instanceof ConfigurationError;
  const infrastructure = checkpointProblem || markFatal;
  // fatal deliberately reads errorKind(cause), not the scope-adjusted kind.
  const fatal = scoped || errorKind(cause) === 'cancelled' || infrastructure;
  const retry =
    !fatal && attempt < maxAttempts && (retryOn === undefined || retryOn.includes(kind));
  const settle = !fatal && !retry && onError === 'return';
  return {
    scoped,
    status: scoped ? 'cancelled' : 'failed',
    errorKind: kind,
    infrastructure,
    markFatal,
    fatal,
    retry,
    settle,
  };
}

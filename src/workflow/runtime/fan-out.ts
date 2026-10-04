import { brandError, isBranded } from './error-brand.js';
import type { ErrorKind, StepError } from './model.js';

/** Attribution for the first failure that ended a run. */
export interface RootCause {
  /** Durable effect responsible, or null for a body failure or run interrupt. */
  readonly stepId: string | null;
  /** Original explanation, separate from cancellation diagnostics. */
  readonly error: string;
  /**
   * Classified kind of the root effect's failure, as saved on its last attempt. Null for a body
   * failure, a run-level failure or an interruption. Absent in records written before this field;
   * readers fall back to the root step's last attempt.
   */
  readonly errorKind?: ErrorKind | null;
  /**
   * Call-site effect kind of the root step: the harness name for an agent call, otherwise the step
   * kind (such as `step`, `exec` or `read-file`). It names the effect even when the failure came
   * before the step had a record. Null for a body failure or an interruption; absent in records
   * written before this field.
   */
  readonly effect?: string | null;
}

/** A mapper failure with its input position and optional effect identity. */
export interface FanOutFailure {
  /** Index in the map's input collection. */
  readonly index: number;
  /** Durable effect that failed, when attributable. */
  readonly stepId: string | null;
  /** Original in-process error, retained for catch/cause inspection. */
  readonly error: unknown;
}

/** A map stopped by failure after all started mappers have settled. */
export class FanOutError extends AggregateError {
  static {
    brandError(this, 'FanOutError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is FanOutError {
    return isBranded(this, value);
  }

  /** Policy that stopped this map. */
  public readonly policy: 'abort' | 'drain';
  /** Mapper failures in observation order; the first is the primary cause. */
  public readonly failures: readonly FanOutFailure[];
  /** Input indices that were never scheduled. */
  public readonly unscheduled: readonly number[];

  /** Construct a drained fan-out failure. */
  public constructor(
    policy: 'abort' | 'drain',
    failures: readonly FanOutFailure[],
    unscheduled: readonly number[],
  ) {
    const first = failures[0]?.error;
    super(
      failures.map((failure) => failure.error),
      errorMessage(first),
      { cause: first },
    );
    this.name = 'FanOutError';
    this.policy = policy;
    this.failures = [...failures];
    this.unscheduled = [...unscheduled];
  }
}

/** Scope cancellation, deliberately distinct from the failure that caused it. */
export class CancelledError extends Error {
  static {
    brandError(this, 'CancelledError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is CancelledError {
    return isBranded(this, value);
  }

  /** Failing effect that cancelled siblings, or null for a body failure/interrupt. */
  public readonly cancelledBy: string | null;
  /** Boundary whose signal was cancelled. */
  public readonly scope: 'run' | 'map';

  /** Retain the underlying cause without copying its error message to siblings. */
  public constructor(cancelledBy: string | null, cause: unknown, scope: 'run' | 'map' = 'run') {
    super(
      `${scope === 'run' ? 'Workflow' : 'Map'} cancelled${cancelledBy === null ? '' : ` by step ${cancelledBy}`}.`,
      { cause },
    );
    this.name = 'CancelledError';
    this.cancelledBy = cancelledBy;
    this.scope = scope;
  }
}

/** A map item's serialized failure. */
export type MapStepError = StepError & {
  /** Originating durable effect, or null for a mapper-body error. */
  readonly stepId: string | null;
};

/** Runtime attribution; only RootCause's plain data crosses into checkpoints. @internal */
export class FailureOrigins {
  private readonly fatalErrors = new Set<unknown>();
  public markFatal(error: unknown): void {
    this.fatalErrors.add(error);
  }
  public isFatal(error: unknown, visited = new Set<unknown>()): boolean {
    if (visited.has(error)) return false;
    visited.add(error);
    return (
      this.fatalErrors.has(error) ||
      (error instanceof FanOutError &&
        error.failures.some((failure) => this.isFatal(failure.error, visited))) ||
      (error instanceof Error && error.cause !== undefined && this.isFatal(error.cause, visited))
    );
  }
  /** Whether `error` is `target`, or reaches it through fan-out failures or causes. */
  public reaches(error: unknown, target: unknown, visited = new Set<unknown>()): boolean {
    if (visited.has(error)) return false;
    visited.add(error);
    return (
      Object.is(error, target) ||
      (error instanceof FanOutError &&
        error.failures.some((failure) => this.reaches(failure.error, target, visited))) ||
      (error instanceof Error &&
        error.cause !== undefined &&
        this.reaches(error.cause, target, visited))
    );
  }
  private readonly failures: { error: unknown; stepId: string; effect: string }[] = [];

  /** Attribute an error to its effect; `effect` is the call-site label RootCause reports. */
  public remember(error: unknown, stepId: string, effect: string): void {
    if (!this.failures.some((failure) => Object.is(failure.error, error)))
      this.failures.push({ error, stepId, effect });
  }

  /** The effect remembered for exactly this error object, without following causes. */
  public exact(error: unknown): string | null {
    return this.failures.find((failure) => Object.is(failure.error, error))?.stepId ?? null;
  }

  /** The original error and effect behind a failure; `effect` is the remembered call-site label. */
  public find(
    error: unknown,
    visited = new Set<unknown>(),
  ): { error: unknown; stepId: string | null; effect?: string } {
    if (visited.has(error)) return { error, stepId: null };
    visited.add(error);
    const known = this.failures.find((failure) => Object.is(failure.error, error));
    if (known) return known;
    if (error instanceof FanOutError && error.failures.length) {
      const first =
        error.failures.find((failure) => !(failure.error instanceof CancelledError)) ??
        error.failures[0];
      if (first) {
        // The mapper may have wrapped the remembered error, so its label comes from the cause chain.
        const effect = first.stepId === null ? undefined : this.find(first.error, visited).effect;
        return {
          error: first.error,
          stepId: first.stepId,
          ...(effect === undefined ? {} : { effect }),
        };
      }
    }
    if (error instanceof Error && error.cause !== undefined) {
      const cause = this.find(error.cause, visited);
      if (cause.stepId !== null) return cause;
    }
    return { error, stepId: null };
  }

  /**
   * Attribute a run's failure. `classify` is the runtime's error classifier, passed in because
   * step-error.ts imports this module.
   */
  public root(error: unknown, classify: (error: unknown) => ErrorKind): RootCause {
    const origin = this.find(error);
    return {
      stepId: origin.stepId,
      error: errorMessage(origin.error),
      errorKind: origin.stepId === null ? null : classify(origin.error),
      effect: origin.stepId === null ? null : (origin.effect ?? null),
    };
  }
}

/** Preserve messages from unknown thrown values. @internal */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

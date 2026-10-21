import { brandError, isBranded } from './error-brand.js';
import { PromptError } from '../prompts/error.js';
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
  /**
   * `isCancelled` is the runtime's cancellation test, which {@link find} uses to pass over
   * cancellations; the runner passes `errorKind(error) === 'cancelled'`, injected because
   * step-error.ts imports this module. The default recognizes only a {@link CancelledError}.
   */
  public constructor(
    private readonly isCancelled: (error: unknown) => boolean = (error) =>
      error instanceof CancelledError,
  ) {}
  private readonly fatalErrors = new Set<unknown>();
  public markFatal(error: unknown): void {
    this.fatalErrors.add(error);
  }
  /**
   * Whether `error` is fatal: marked, a prompt authoring error (ADR 0064, recognized from any
   * module instance), or a fan-out or cause chain that reaches one.
   */
  public isFatal(error: unknown, visited = new Set<unknown>()): boolean {
    if (visited.has(error)) return false;
    visited.add(error);
    return (
      this.fatalErrors.has(error) ||
      error instanceof PromptError ||
      (error instanceof FanOutError &&
        error.failures.some((failure) => this.isFatal(failure.error, visited))) ||
      (error instanceof Error && error.cause !== undefined && this.isFatal(error.cause, visited))
    );
  }
  /**
   * Whether `error` derives only from `target`: it is `target`, wraps it through a cause chain, or is
   * a fan-out with at least one non-cancellation failure, every one of which derives only from it.
   * A fan-out's own `cause` (its first failure) is not followed, so one unrelated member is enough
   * to answer false.
   */
  public onlyFrom(error: unknown, target: unknown, path = new Set<unknown>()): boolean {
    if (Object.is(error, target)) return true;
    // Guard cycles along this path only: siblings may share one error object.
    if (path.has(error)) return false;
    path.add(error);
    try {
      if (error instanceof FanOutError) {
        const failures = error.failures.filter(
          (failure) => !(failure.error instanceof CancelledError),
        );
        return (
          failures.length > 0 &&
          failures.every((failure) => this.onlyFrom(failure.error, target, path))
        );
      }
      return (
        error instanceof Error &&
        error.cause !== undefined &&
        this.onlyFrom(error.cause, target, path)
      );
    } finally {
      path.delete(error);
    }
  }
  private readonly failures: {
    error: unknown;
    stepId: string;
    effect: string;
    beforeAttempt: boolean;
  }[] = [];

  /**
   * Attribute an error to its effect; `effect` is the call-site label RootCause reports.
   * `beforeAttempt` is true when the effect's launch remembers an error that no attempt of the
   * effect attributed, so it was raised outside an attempt, such as a refusal before one starts.
   */
  public remember(error: unknown, stepId: string, effect: string, beforeAttempt = false): void {
    if (!this.failures.some((failure) => Object.is(failure.error, error)))
      this.failures.push({ error, stepId, effect, beforeAttempt });
  }

  /** The effect remembered for exactly this error object, without following causes. */
  public exact(error: unknown): string | null {
    return this.failures.find((failure) => Object.is(failure.error, error))?.stepId ?? null;
  }

  /**
   * The original error and effect behind a failure; `effect` is the remembered call-site label and
   * `beforeAttempt` whether that error was remembered outside an attempt. A fan-out failure
   * resolves to its first failure whose own origin is not a cancellation (its reported or
   * remembered error meets the constructor's cancellation test, for the runner errorKind
   * `cancelled`, so an AbortError leaf counts too), looking through nested
   * fan-outs to the leaf's own origin, so a nested map that only saw cancellations never masks a
   * sibling's real failure at any nesting level; only when every failure resolves to a
   * cancellation is the first one the origin. When a mapper wrapped the remembered error, `error`
   * is the mapper's error and `remembered` the remembered error its cause chain reaches;
   * `remembered` is absent when `error` is that error.
   */
  public find(error: unknown, visited = new Set<unknown>()): FailureOrigin {
    if (visited.has(error)) return { error, stepId: null };
    visited.add(error);
    const known = this.failures.find((failure) => Object.is(failure.error, error));
    if (known) return known;
    if (error instanceof FanOutError && error.failures.length) {
      let fallback: FailureOrigin | undefined;
      for (const failure of error.failures) {
        // Each failure is probed with its own copy of the walk so far: siblings may share an error
        // object, and one probe must not make it look revisited to the next.
        const origin = this.fanOutFailureOrigin(failure, new Set(visited));
        if (!this.isCancellation(origin)) return origin;
        fallback ??= origin;
      }
      if (fallback) return fallback;
    }
    if (error instanceof Error && error.cause !== undefined) {
      const cause = this.find(error.cause, visited);
      if (cause.stepId !== null) return cause;
    }
    return { error, stepId: null };
  }

  /** Whether an origin is a cancellation: its reported error or the remembered error behind it. */
  private isCancellation(origin: FailureOrigin): boolean {
    return this.isCancelled(origin.error) || this.isCancelled(rememberedError(origin));
  }

  /** The origin of one fan-out failure, as {@link find} reports it when it chooses that failure. */
  private fanOutFailureOrigin(failure: FanOutFailure, visited: Set<unknown>): FailureOrigin {
    // The failure may be a nested map's fan-out, or the mapper may have wrapped the remembered
    // error. A nested fan-out yields the leaf's own origin. A wrapper keeps the mapper's error,
    // while the label, the flag and the remembered error come from its cause chain.
    const nested = failure.stepId === null ? undefined : this.find(failure.error, visited);
    const resolved = nested?.stepId === null ? undefined : nested;
    if (failure.error instanceof FanOutError && resolved !== undefined) return resolved;
    const remembered = resolved === undefined ? failure.error : rememberedError(resolved);
    return {
      error: failure.error,
      stepId: failure.stepId,
      ...(nested?.effect === undefined ? {} : { effect: nested.effect }),
      ...(nested?.beforeAttempt === undefined ? {} : { beforeAttempt: nested.beforeAttempt }),
      ...(Object.is(remembered, failure.error) ? {} : { remembered }),
    };
  }

  /**
   * Attribute a run's failure. `classify` is the runtime's root-cause classifier, passed in because
   * step-error.ts imports this module; it learns whether the originating error was remembered
   * outside an attempt. The kind classifies the remembered root error, through nested maps and
   * mapper wrappers; for an error an attempt recorded, that is the kind the root step's last failed
   * attempt saved. The message stays that of the error {@link find} reports.
   */
  public root(
    error: unknown,
    classify: (error: unknown, beforeAttempt: boolean) => ErrorKind,
  ): RootCause {
    const origin = this.find(error);
    return {
      stepId: origin.stepId,
      error: errorMessage(origin.error),
      errorKind:
        origin.stepId === null
          ? null
          : classify(rememberedError(origin), origin.beforeAttempt === true),
      effect: origin.stepId === null ? null : (origin.effect ?? null),
    };
  }
}

/** The original error and effect behind a failure, as {@link FailureOrigins.find} reports it. */
interface FailureOrigin {
  error: unknown;
  stepId: string | null;
  effect?: string;
  beforeAttempt?: boolean;
  remembered?: unknown;
}

/** The remembered error behind a {@link FailureOrigins.find} origin: `remembered` when present. @internal */
export function rememberedError(origin: {
  readonly error: unknown;
  readonly remembered?: unknown;
}): unknown {
  return 'remembered' in origin ? origin.remembered : origin.error;
}

/** Preserve messages from unknown thrown values. @internal */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

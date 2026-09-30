import { brandError, isBranded } from './error-brand.js';
import type { JsonValue } from './model.js';
import type { RunRecord } from './store.js';

/** Stable machine-readable workflow command failures; numeric exits belong to the CLI. */
export type CliErrorCode =
  | 'answer.invalid'
  | 'answer.conflict'
  | 'usage.flag'
  | 'usage.file_not_found'
  | 'usage.entrypoint'
  | 'usage.run_id'
  | 'usage.input_json'
  | 'usage.input_file'
  | 'usage.input_schema'
  | 'usage.resume_requires_run_id'
  | 'run.exists'
  | 'run.not_found'
  | 'run.locked'
  | 'run.incompatible'
  | 'run.input_changed'
  | 'run.unreadable'
  | 'run.orphans'
  | 'load.typecheck'
  | 'load.import'
  | 'load.definition'
  | 'workflow.failed'
  | 'workflow.interrupted'
  | 'workflow.storage';

/** A run cannot start with the requested checkpoint or ownership. */
export class RunRefusedError extends Error {
  static {
    brandError(this, 'RunRefusedError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is RunRefusedError {
    return isBranded(this, value);
  }

  /** Preserve the underlying error without parsing its message. */
  public constructor(
    /** Stable refusal classification. */
    public readonly code: Extract<CliErrorCode, `run.${string}`>,
    /** Checkpoint whose acquisition or compatibility was refused. */
    public readonly runId: string,
    message: string,
    /** Serializable ownership, compatibility, or filesystem diagnostics. */
    public readonly details: JsonValue = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RunRefusedError';
  }
}

/** A workflow input failed its schema before the body or effects ran. */
export class WorkflowInputError extends Error {
  static {
    brandError(this, 'WorkflowInputError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is WorkflowInputError {
    return isBranded(this, value);
  }

  /** Stable usage classification. */
  public readonly code = 'usage.input_schema';

  /** Retain serializable validation issues and the original validator error. */
  public constructor(
    /** Serializable validator issues. */
    public readonly details: JsonValue,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkflowInputError';
  }
}

/**
 * Abort reason that marks an external interruption, such as a process signal or a tick deadline,
 * rather than a deliberate cancel. When a run's `RunOptions.signal` aborts with this reason and the
 * abort interrupts the run, the runner drains in-flight work and saves a resumable `suspended`
 * checkpoint with `nextWakeAt` set to now and an `interruptedBy` note, then still rejects with
 * {@link WorkflowRunError}. Any other abort reason saves `cancelled`.
 *
 * @example
 * ```ts
 * controller.abort(new RunInterruptedError('Worker shutting down.'));
 * ```
 */
export class RunInterruptedError extends Error {
  static {
    brandError(this, 'RunInterruptedError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is RunInterruptedError {
    return isBranded(this, value);
  }

  /** The message becomes the saved run's `interruptedBy.reason`. */
  public constructor(message = 'Workflow interrupted.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunInterruptedError';
  }
}

/**
 * A failed, cancelled, or interrupted-and-suspended workflow whose final checkpoint was saved
 * successfully. An interrupted run's saved status is `suspended` with `interruptedBy` set.
 */
export class WorkflowRunError extends Error {
  static {
    brandError(this, 'WorkflowRunError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is WorkflowRunError {
    return isBranded(this, value);
  }

  /** Persisted run identifier. */
  public readonly runId: string;
  /** Effect responsible for the failure; null for a body failure or run interruption. */
  public readonly stepId: string | null;

  /** Keep the saved snapshot and the prior rejection (including any checkpoint aggregate) as cause. */
  public constructor(
    /** Successfully persisted failed, cancelled, or interrupted snapshot from this invocation. */
    public readonly run: RunRecord,
    cause: unknown,
  ) {
    const stepId = run.rootCause?.stepId ?? null;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      stepId === null
        ? detail
        : `Step ${stepId.length > 80 ? `${stepId.slice(0, 80)}…` : stepId} (${run.steps[stepId]?.harness ?? run.steps[stepId]?.kind ?? 'unknown'}) failed: ${detail}`,
      { cause },
    );
    this.name = 'WorkflowRunError';
    this.runId = run.id;
    this.stepId = run.rootCause?.stepId ?? null;
  }
}

/** Whether an identifier is safe for a checkpoint filename. */
export function isValidRunId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id);
}

/** Shared validation text, also used before CLI module import. @internal */
export const runIdMessage =
  'Run ID must be 1–128 letters, numbers, underscores, or hyphens, starting with a letter or number.';

import type { WorktreeHandle } from './worktree-model.js';
import type { z } from 'zod';
import type {
  EffectResult,
  ErrorMode,
  HarnessInvocation,
  JsonValue,
  RetryPolicy,
  Settled,
  StepError,
} from './model.js';

/** Arguments run directly, or an explicitly requested operator-privileged shell. */
export type Command =
  | readonly [string, ...string[]]
  | {
      /** Explicit shell program, recorded in inspection; never interpolate untrusted values. */
      readonly shell: string;
    };

/** Semantic command inputs and changeable execution limits. */
export interface ExecOptions {
  /** Run on a shared checkout, serializing preparation, execution, and snapshot persistence. */
  readonly worktree?: WorktreeHandle;
  /** Directory relative to the workflow cwd. */
  readonly cwd?: string;
  /** Fingerprinted overlay; keep rotating credentials in the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Inherit the parent environment by default; false keeps only the overlay and run metadata. */
  readonly inheritEnv?: boolean;
  /** UTF-8 stdin, delivered after durable process registration. Only its digest is recorded. */
  readonly input?: string;
  /** Accepted exits, default [0]. 'any' treats nonzero exits as data, but still rejects signals. */
  readonly okExitCodes?: readonly number[] | 'any';
  /** Deadline in milliseconds, default 300000. Policy, not replay identity. */
  readonly timeoutMs?: number;
  /** Per-stream retained bytes, default 1048576. Plain exec keeps head/tail; json rejects overflow. */
  readonly maxOutputBytes?: number;
  /** Explicit retries for commands safe to repeat. */
  readonly retry?: RetryPolicy;
  /**
   * Throw failures by default, or save the final failure as an {@link ExecStepError} and return
   * it as `Settled`, so resume replays the same branch. Policy-free: not part of the summary.
   */
  readonly onError?: ErrorMode | undefined;
  /**
   * JSON labels recorded on the step, like `StepDefinition.meta`: `inspect` shows a step with a
   * string `integration` label as `integration.op`. Never part of identity or policy, so changing
   * a label never refuses a resume. Integration helpers use `{ integration, op }`.
   */
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

/**
 * Saved failure of a settled command. The process fields come from the command's
 * {@link ExecDiagnostics} and are absent when the failure carried none (for example a custom
 * `ProcessRunner`'s plain error, or a record saved before these fields existed).
 */
export interface ExecStepError extends StepError {
  /** Observed exit code, or null when the process did not exit normally. */
  readonly code?: number | null;
  /** Termination signal, or null on ordinary exit. */
  readonly signal?: string | null;
  /** Last 1024 characters of stdout. */
  readonly stdoutTail?: string;
  /** Last 1024 characters of stderr. */
  readonly stderrTail?: string;
  /**
   * `exec.json` only: stdout parsed as JSON, when the output was complete, at most 16384 UTF-8
   * bytes and valid JSON. Not validated against the success schema.
   */
  readonly parsed?: JsonValue;
}

/** Captured command result, checkpointed by plain exec. */
export interface ExecResult {
  /** Exit code, or null when terminated by a signal. */
  readonly code: number | null;
  /** Termination signal, or null on ordinary exit. */
  readonly signal: string | null;
  /** UTF-8 output, with head/tail retained on overflow. */
  readonly stdout: string;
  /** UTF-8 diagnostics, with head/tail retained on overflow. */
  readonly stderr: string;
  /** Output exceeded the cap or inherited pipes could not be fully drained. */
  readonly truncated: boolean;
  /** Monotonic wall time including child cleanup. */
  readonly durationMs: number;
}

/** Callable durable command API. */
export interface ExecFunction {
  /** Run once per durable ID and settle a failure; the saved outcome replays without the adapter. */
  (
    id: string,
    command: Command,
    options: ExecOptions & { readonly onError: 'return' },
  ): Promise<Settled<ExecResult, ExecStepError>>;
  /** Run once per durable ID; completed results replay without invoking the adapter. */
  <TMode extends ErrorMode = 'throw'>(
    id: string,
    command: Command,
    options?: ExecOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<ExecResult, TMode, ExecStepError>>;
  /** Parse and validate stdout, settling a failure as an {@link ExecStepError}. */
  json<T>(
    id: string,
    command: Command,
    options: ExecOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
  ): Promise<Settled<T, ExecStepError>>;
  /** Parse stdout, validate it, and checkpoint only the parsed value. */
  json<T, TMode extends ErrorMode = 'throw'>(
    id: string,
    command: Command,
    options: ExecOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode | undefined },
  ): Promise<EffectResult<T, TMode, ExecStepError>>;
}

/**
 * Options for a command a local step callback issues through `context.exec`: the options of
 * {@link ExecOptions} without `worktree`, `retry` and `meta`. The command is not a durable effect:
 * it is never replayed or reused, so `onError: 'return'` resolves to a failure value that a rerun
 * of the parent produces again. The runtime does keep the command and its raw result on the
 * parent's step record for fixture export; see {@link StepExecFunction}.
 */
export type StepExecOptions = Omit<ExecOptions, 'worktree' | 'retry' | 'meta'>;

/** Options for a command a poll observer issues through `context.exec`. */
export interface PollExecOptions extends StepExecOptions {
  /**
   * Run the real process even under a `--dry-run` rehearsal, which otherwise synthesizes the
   * command or answers it from an exec fixture rule. Keep it to read-only observations, such as the
   * initial check of a wait. Outside a rehearsal it changes nothing: exec fixture rules still apply.
   */
  readonly live?: boolean;
}

/**
 * Non-durable command API of a local step callback or poll observer (`context.exec`). A call takes
 * no step ID and is not an effect: it is never replayed or reused, and every rerun of the parent
 * runs it again, so commands run at least once. Its child is owned by the parent step or wait and
 * attempt, so orphan recovery covers it, and it carries the parent's run metadata, including
 * `QUIET_CHOIR_IDEMPOTENCY_KEY`. Under a rehearsal they are synthesized or answered by exec fixture
 * rules, like `ctx.exec`. A command still running when the callback or observation settles is
 * terminated.
 *
 * The commands are still recorded, for `workflow fixtures` only. The parent's step or wait record
 * keeps `innerCommands`: each command's argv or shell source, the `envSha256` and `inputSha256`
 * digests (never environment values or stdin) and the raw process result (exit code, signal,
 * stdout and stderr, up to 1 MiB per attempt), even when the call succeeds, fails or is
 * schema-parsed by `json`. A secret a command prints is therefore stored in the checkpoint and
 * journal, and a schema does not filter it out. Keep secrets out of command output.
 */
export interface StepExecFunction<TOptions extends StepExecOptions = StepExecOptions> {
  /** Run a command and return a failure as a value instead of throwing it. It is not replayed. */
  (
    command: Command,
    options: TOptions & { readonly onError: 'return' },
  ): Promise<Settled<ExecResult, ExecStepError>>;
  /** Run a command; a failure throws an `ExecError` into the parent attempt. */
  <TMode extends ErrorMode = 'throw'>(
    command: Command,
    options?: TOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<ExecResult, TMode, ExecStepError>>;
  /** Parse and validate stdout, returning a failure as a value. The raw stdout is still recorded. */
  json<T>(
    command: Command,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
  ): Promise<Settled<T, ExecStepError>>;
  /** Parse stdout as JSON and validate it with the schema. */
  json<T, TMode extends ErrorMode = 'throw'>(
    command: Command,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode | undefined },
  ): Promise<EffectResult<T, TMode, ExecStepError>>;
}

/** Normalized live request. Environment and input must never be copied into a checkpoint. */
export interface ProcessRunRequest {
  /** Explicit argv or shell command. */
  readonly command: Command;
  /** Absolute canonical working directory. */
  readonly cwd: string;
  /** Explicit environment overlay, excluding engine-supplied run metadata. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether the adapter should inherit its parent environment. */
  readonly inheritEnv: boolean;
  /** Text to send after process registration. */
  readonly input: string;
  /** Enforced wall-clock deadline. */
  readonly timeoutMs: number;
  /** Per-stream byte cap. */
  readonly maxOutputBytes: number;
  /** Plain output truncates; structured output rejects overflow. */
  readonly capture: 'truncate' | 'error';
  /** Output schema for deterministic/rehearsal adapters; null for plain exec. */
  readonly schema: JsonValue | null;
  /**
   * True for a command a step callback or poll observer issued through `context.exec`. The
   * invocation's `stepId` and `attempt` are then the parent step's or wait's. Omitted for a
   * `ctx.exec` effect.
   */
  readonly nested?: boolean;
}

/** Replaceable process integration, independent of agent admission and permissions. */
export interface ProcessRunner {
  /** Enforce limits, register children before stdin, reap groups, and preserve failures as ExecError. */
  run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult>;
}

/** Safe-to-record command description, including an explicit shell marker. */
export interface ExecSummary {
  /** Complete command; do not put secrets in argv or shell source. */
  readonly command: Command;
  /** Canonical working directory. */
  readonly cwd: string;
  /** SHA-256 of the explicit environment overlay; values are not stored. */
  readonly envSha256: string;
  /** Whether the parent environment is inherited. */
  readonly inheritEnv: boolean;
  /** SHA-256 of stdin; input is not stored. */
  readonly inputSha256: string;
  /** Exit-code branch contract. */
  readonly okExitCodes: readonly number[] | 'any';
  /** Whether stdout is parsed as JSON. */
  readonly structured: boolean;
}

/** Bounded failed-attempt diagnostics, separate from checkpointed output. */
export interface ExecDiagnostics {
  /** Observed exit code, if available. */
  readonly code: number | null;
  /** Observed signal, if available. */
  readonly signal: string | null;
  /** Last 1024 characters of stdout. */
  readonly stdoutTail: string;
  /** Last 1024 characters of stderr. */
  readonly stderrTail: string;
  /** Whether output capture was incomplete. */
  readonly truncated: boolean;
  /** Process wall time, if available. */
  readonly durationMs: number;
}

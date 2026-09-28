import type { z } from 'zod';
import type { HarnessInvocation, JsonValue, RetryPolicy } from './model.js';

/** Arguments run directly, or an explicitly requested operator-privileged shell. */
export type Command =
  | readonly [string, ...string[]]
  | {
      /** Explicit shell program, recorded in inspection; never interpolate untrusted values. */
      readonly shell: string;
    };

/** Semantic command inputs and changeable execution limits. */
export interface ExecOptions {
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
  /** Run once per durable ID; completed results replay without invoking the adapter. */
  (id: string, command: Command, options?: ExecOptions): Promise<ExecResult>;
  /** Parse stdout, validate it, and checkpoint only the parsed value. */
  json<T>(
    id: string,
    command: Command,
    options: ExecOptions & { readonly schema: z.ZodType<T> },
  ): Promise<T>;
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

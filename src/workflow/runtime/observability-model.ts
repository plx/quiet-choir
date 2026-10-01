import type { JsonValue } from './model.js';
import type { EnvironmentSummary } from './agent-environment-model.js';
import type { HarnessIsolation } from './agent-isolation.js';

/** Optional progress denominator for an observational phase. */
export interface PhaseOptions {
  /** Expected number of steps; a nonnegative safe integer. */
  readonly total?: number;
}

/** Current phase metadata; labels never participate in effect identity. */
export interface PhaseInfo {
  /** User-facing label. */
  readonly title: string;
  /** Expected step count, or null when unspecified. */
  readonly total: number | null;
}

/** Resolved agent request diagnostics, independent from its identity fingerprint. */
export interface RequestSummary {
  /** Resolved native configuration mode; absent in older checkpoints. */
  readonly isolation?: HarnessIsolation;
  /** Resolved Codex instruction loading; absent for other harnesses and in older checkpoints. */
  readonly instructions?: 'native' | 'none';
  /** Explicit environment names and digest, never values. */
  readonly environment?: EnvironmentSummary;
  /** Selected harness. */
  readonly harness: string;
  /** Option-semantics revision; absent in preceding-runtime records. */
  readonly revision?: number;
  /** Explicit resolved model; null means inherited native configuration. */
  readonly model: string | null;
  /** Resolved capability profile. */
  readonly profile: string | null;
  /** Effective applicable limits, with null for unspecified or inapplicable controls. */
  readonly limits: {
    /** Per-call deadline; admission waiting is outside this deadline. */
    readonly timeoutMs: number | null;
    /** Claude turn limit. */
    readonly maxTurns: number | null;
    /** Claude per-call budget. */
    readonly maxBudgetUsd: number | null;
    /** Native Codex sandbox selection. */
    readonly sandbox: string | null;
    /** Process cleanup grace when explicitly supplied by the harness defaults. */
    readonly killGraceMs: number | null;
  };
  /** Declared Claude tools, or null for inherited/non-Claude tool configuration. */
  readonly tools: readonly string[] | null;
  /** Absolute call working directory. */
  readonly cwd: string;
  /** Whether the caller requested structured output. */
  readonly structured: boolean;
  /** SHA-256 of the complete prompt's UTF-8 bytes. */
  readonly promptSha256: string;
  /** First 200 UTF-16 code units of the prompt. Treat checkpoint files as sensitive. */
  readonly promptPreview: string;
}

/** One workflow-body execution; a completed-run fast-path read creates no new execution. */
export interface ExecutionRecord {
  /** Monotonic execution number within this run. */
  readonly n: number;
  /** Local runner process ID. */
  readonly pid: number;
  /** ISO time immediately before this body execution starts. */
  readonly startedAt: string;
  /** ISO settlement time, or null when the owner did not persist a final outcome. */
  endedAt: string | null;
  /** Recorded outcome; historical running entries can indicate a crashed owner. */
  outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'suspended';
  /** Failure message retained even after a later successful resume. */
  error: string | null;
  /** Failure stack/cause chain, when available. */
  errorStack: string | null;
}

/** Persisted lifecycle, phase, or log entry. Step transitions also have live WorkflowEvents. */
export interface RunEvent {
  /** Inline frame at the observation call site, or null/absent for root events. */
  readonly frame?: string | null;
  /** ISO event time. */
  readonly at: string;
  /** Body execution that first recorded this entry. */
  readonly execution: number;
  /** Notification category. */
  readonly type:
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled'
    | 'run.suspended'
    | 'phase'
    | 'log';
  /** Phase at the call site. */
  readonly phase: string | null;
  /** Expected phase step count, when known. */
  readonly total: number | null;
  /** Human diagnostic or phase label. */
  readonly message: string | null;
  /** Explicit user log data; null when absent. */
  readonly data: JsonValue;
  /** Root effect on run failure; null for other notifications. */
  readonly stepId: string | null;
}

export type { UsageSummary } from './usage-model.js';

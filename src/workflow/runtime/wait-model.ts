import type { z } from 'zod';
import type { JsonInput, JsonValue, StepContext } from './model.js';
import type {
  AskOptions,
  QuestionRequest,
  QuestionRejection,
  PendingQuestion,
} from './question-model.js';

/** Injectable wall clock and cancellable timer used by durable waits. */
export interface WorkflowClock {
  /** Nonnegative integer Unix epoch milliseconds through year 9999. */
  now(): number;
  /** Sleep for the requested duration, rejecting promptly when cancelled. */
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** An external, schema-validated signal delivered through the run inbox. */
export type SignalSource<T> = AskOptions<T>;

/** Minimum spacing between observations, optionally increasing to a bounded maximum. */
export type PollInterval =
  | number
  | {
      /** Delay after the first nonterminal observation. */
      readonly initialMs: number;
      /** Largest delay between observations. */
      readonly maxMs: number;
      /** Growth factor; defaults to two. */
      readonly factor?: number;
    };

/** One read-only check; only its final value becomes a workflow branch decision. */
export interface PollSource<T, N extends JsonValue = JsonValue> {
  /** Explicit dependencies, included in durable identity. */
  readonly input: JsonInput;
  /** Terminal value schema; parsed before lossless-JSON validation. */
  readonly schema: z.ZodType<T>;
  /** Minimum spacing, not a guarantee of scheduler latency. */
  readonly every: PollInterval;
  /**
   * Upper bound, in milliseconds, for one observation: a positive integer. When it elapses before
   * the wait's deadline, the observation's `signal` aborts and the wait fails as if `observe` had
   * thrown. It defaults to 60 seconds and never runs past the deadline, where the signal also
   * aborts and the wait resolves by `deadline`. It is execution policy, not identity: it is not
   * persisted and may change on resume.
   */
  readonly observeTimeoutMs?: number;
  /**
   * Read external state without writes or nested workflow operations. Honor `context.signal`: an
   * observation that ignores its aborted signal is abandoned after a short grace, with a run
   * warning.
   */
  readonly observe: NoInfer<
    (
      context: StepContext,
    ) => Promise<
      { readonly done: true; readonly value: T } | { readonly done: false; readonly note?: N }
    >
  >;
}

/** Sources competing inside one durable wait; at least one must be supplied. */
export interface WaitSources {
  /** Relative duration, pinned to an absolute deadline when first opened. */
  readonly timeoutMs?: number;
  /** Absolute Unix epoch deadline; cannot be combined with timeoutMs. */
  readonly deadline?: number;
  /** An optional external answer, with its subject and presentation fingerprinted. */
  readonly signal?: SignalSource<unknown>;
  /** An optional changing-state observation. */
  readonly poll?: PollSource<unknown>;
}

/** A terminal external answer; its timestamp is supplied by the inbox writer. */
export interface SignalOutcome<T> {
  /** Winning source. */
  readonly by: 'signal';
  /** Authoritatively validated answer. */
  readonly value: T;
  /** Recorded delivery time, as Unix epoch milliseconds. */
  readonly at: number;
  /** Self-asserted author; filesystem permissions remain the trust boundary. */
  readonly actor: string | null;
}

/** A terminal observation, including a final check after a missed deadline. */
export interface PollOutcome<T> {
  /** Winning source. */
  readonly by: 'poll';
  /** Parsed terminal value. */
  readonly value: T;
  /** Time the terminal observation was resolved. */
  readonly at: number;
  /** Total observations across all resumes. */
  readonly checks: number;
}

/** No eligible signal or terminal poll was available at the deadline check. */
export interface DeadlineOutcome {
  /** Winning source. */
  readonly by: 'deadline';
  /** Time the owner resolved the wait, possibly after the pinned deadline. */
  readonly at: number;
  /** Latest nonterminal observation, or null. */
  readonly note: JsonValue;
}

/** Only outcomes corresponding to the supplied sources can be returned. */
export type WaitOutcome<S> =
  | (S extends {
      /** Supplied external answer contract. */
      readonly signal: {
        /** Signal value validator. */
        readonly schema: z.ZodType<infer T>;
      };
    }
      ? SignalOutcome<T>
      : never)
  | (S extends {
      /** Supplied observation contract. */
      readonly poll: {
        /** Terminal poll value validator. */
        readonly schema: z.ZodType<infer T>;
      };
    }
      ? PollOutcome<T>
      : never)
  | (S extends
      | {
          /** Supplied relative time bound. */
          readonly timeoutMs: number;
        }
      | {
          /** Supplied absolute time bound. */
          readonly deadline: number;
        }
      ? DeadlineOutcome
      : never);

/** A polling convenience call must include a finite time bound. */
export type PollOptions<T, N extends JsonValue = JsonValue> = PollSource<T, N> &
  (
    | {
        /** Relative duration, pinned on first open. */
        readonly timeoutMs: number;
        /** Mutually exclusive with the relative duration. */
        readonly deadline?: never;
      }
    | {
        /** Absolute epoch time from input or recorded data. */
        readonly deadline: number;
        /** Mutually exclusive with the absolute deadline. */
        readonly timeoutMs?: never;
      }
  );

/** Validated, serializable polling identity. */
export interface PollRequest {
  /** Canonical dependencies. */
  readonly input: JsonValue;
  /** Stored JSON Schema. */
  readonly schema: JsonValue;
  /** Normalized spacing. */
  readonly every: {
    /** Initial minimum spacing in milliseconds. */
    readonly initialMs: number;
    /** Maximum minimum spacing in milliseconds. */
    readonly maxMs: number;
    /** Exponential growth factor. */
    readonly factor: number;
  };
  /** Hash of observer source; captured dependencies still belong in input. */
  readonly observe: string;
}

/** Durable wait identity; signal presentation lives in the step's question record. */
export interface WaitRequest {
  /** Original relative timeout, or null. */
  readonly timeoutMs: number | null;
  /** Original explicit deadline, or null. */
  readonly deadline: number | null;
  /** Poll contract, or null. */
  readonly poll: PollRequest | null;
}

/** Bounded progress for one wait, overwritten rather than accumulating observations. */
export interface WaitRecord {
  /** Timing and polling identity. */
  readonly request: WaitRequest;
  /** First-open Unix epoch timestamp. */
  readonly openedAt: number;
  /** Pinned absolute deadline, or null for an unbounded external wait. */
  readonly deadline: number | null;
  /** Earliest next observation, or null without a poll. */
  nextCheckAt: number | null;
  /** Number of observations, not effect attempts. */
  checks: number;
  /** Latest nonterminal observation, or null. */
  note: JsonValue;
  /** First signal-notification attempt timestamp, or null. */
  notifiedAt: number | null;
}

/** Code-free view of a parked poll or deadline, optionally including a signal. */
export interface PendingWait {
  /** Distinguishes general waits from the legacy question projection. */
  readonly kind: 'wait';
  /** Owning run. */
  readonly runId: string;
  /** Fully qualified effect ID. */
  readonly stepId: string;
  /** First-open epoch time. */
  readonly openedAt: number;
  /** Pinned deadline, or null. */
  readonly deadline: number | null;
  /** Next poll time, or null. */
  readonly nextCheckAt: number | null;
  /** Total read-only observations. */
  readonly checks: number;
  /** Most recent nonterminal note. */
  readonly note: JsonValue;
  /** External signal presentation, or null. */
  readonly signal: QuestionRequest | null;
  /** Most recent rejected signal deliveries, empty without a signal source. */
  readonly rejections: readonly QuestionRejection[];
  /** Whether stored source bytes changed; null without launch metadata. */
  readonly codeChanged: boolean | null;
  /** Delivery command for a signal, or null for timer/poll-only and disposed rehearsals. */
  readonly answerCommand: readonly string[] | null;
}

/** A legacy question or a general signal/poll/deadline wait, inspected without importing code. */
export type PendingOperation = PendingQuestion | PendingWait;

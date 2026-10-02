import type { z } from 'zod';
import type { JsonInput, JsonValue, StepContext } from './model.js';
import type { RunRecord } from './store.js';
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

/**
 * The context one poll observation receives: the step context plus the wait's persisted progress
 * before this check. Every check is a fresh call (often in a fresh process after a suspension), so
 * cross-check state such as debounce flags belongs in the note, not in closures.
 */
export type PollContext<N extends JsonValue = JsonValue> = StepContext & {
  /** Progress persisted before this check; frozen, so observers cannot change saved state. */
  readonly previous: {
    /**
     * The latest nonterminal note, or null on the first check. It is read back from storage, so
     * narrow or parse it (for example with a Zod schema); `N` is not inferred from returned notes.
     */
    readonly note: N | null;
    /** Checks completed before this one, including tolerated errors; 0 on the first check. */
    readonly checks: number;
    /** First-open Unix epoch milliseconds of the wait. Keep other timestamps in the note. */
    readonly openedAt: number;
  };
};

/**
 * Opt-in tolerance for transient observation errors. Without it a rejected observation fails the
 * wait. It is execution policy, not identity: it is not persisted and may change on resume.
 *
 * Only a rejection of the observation itself, or an observeTimeoutMs expiry (code
 * `QUIET_CHOIR_POLL_OBSERVE_TIMEOUT`), is a candidate. Run cancellation or interruption,
 * context-operation violations, an invalid observe result, a terminal value that fails the schema,
 * and an invalid note always fail the wait.
 */
export interface PollErrorPolicy {
  /**
   * Consecutive tolerated errors allowed, a positive integer. Error `tolerate + 1` in a row fails
   * the wait with its own message. A successful observation resets the count; the count persists
   * across suspend, tick and resume.
   */
  readonly tolerate: number;
  /** Decide whether an error may be tolerated; defaults to `'transient'` for every candidate. */
  readonly classify?: (error: unknown) => 'transient' | 'fatal';
  /**
   * Delay, in milliseconds, before the next check after a tolerated error: a finite number of at
   * least zero. Null, or no callback, uses the poll's normal spacing.
   */
  readonly retryAfterMs?: (error: unknown) => number | null;
}

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
   * Tolerate a bounded number of consecutive observation errors instead of failing the wait. It is
   * execution policy, not identity: it is not persisted and may change on resume.
   */
  readonly onError?: PollErrorPolicy;
  /**
   * Read external state without writes or nested workflow operations. Honor `context.signal`: an
   * observation that ignores its aborted signal is abandoned after a short grace, with a run
   * warning. `context.previous` carries the persisted note and check count from earlier checks.
   */
  readonly observe: NoInfer<
    (
      context: PollContext<N>,
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
  /** Latest tolerated observation error and its consecutive count; absent after a success. */
  lastError?: WaitError;
}

/** A tolerated poll observation error, recorded instead of failing the wait. */
export interface WaitError {
  /** Error message, truncated to 4096 characters. */
  readonly message: string;
  /** Consecutive tolerated errors, including this one. */
  readonly consecutive: number;
  /** Unix epoch milliseconds when the error was recorded. */
  readonly at: number;
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
  /** Latest tolerated observation error, or null when the last check succeeded or none ran. */
  readonly lastError: WaitError | null;
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

/**
 * Whether an answer is already queued for a row's question, as read from the run's inbox. It is
 * advisory: while an owner consumes the file the state can briefly read `none`, and
 * `writeAnswer` remains the authoritative first-answer check.
 */
export interface PendingDelivery {
  /** `queued` when an inbox file exists for the question; `none` otherwise. */
  readonly state: 'none' | 'queued';
  /** Envelope delivery time (ISO 8601), or null when nothing is queued or the file is unreadable. */
  readonly at: string | null;
  /** Envelope author, or null when nothing is queued or the file is unreadable. */
  readonly by: string | null;
}

/** Run and delivery state that {@link listPending} adds to each waiting row. */
export interface PendingRunState {
  /** Status of the run that owns the row, from its checkpoint. */
  readonly runStatus: RunRecord['status'];
  /** Inbox delivery state, or null for a poll or deadline wait that accepts no answer. */
  readonly delivery: PendingDelivery | null;
}

/** A {@link PendingOperation} row as listed: with its run's status and its delivery state. */
export type PendingListing = PendingOperation & PendingRunState;

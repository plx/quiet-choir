// Part of the Node-free authoring model: model.ts and everything it imports must type-check without
// @types/node, because workflow type checks import it under tsconfigs with no Node types
// (TypeScript 6 includes none by default). Never import store.js, record.js, node:* or a module
// that does, even with `import type`, and never use Node globals. test/node-free-model.test.ts
// enforces this and names the offending import.
import type { z } from 'zod';
import type { JsonInput, JsonValue, StepContext } from './model.js';
import type {
  Command,
  ExecSummary,
  PollExecOptions,
  StepExecFunction,
  StepExecOptions,
} from './exec-model.js';
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
export type PollContext<N extends JsonInput = JsonValue> = Omit<StepContext, 'exec'> & {
  /**
   * Run a command through the run's process runner during this observation; see
   * {@link StepContext.exec}. The child is owned by the wait and aborted with the observation's
   * signal. `live: true` runs the real process even under `--dry-run`, for read-only checks only.
   */
  readonly exec: StepExecFunction<PollExecOptions>;
  /** Progress persisted before this check; frozen, so observers cannot change saved state. */
  readonly previous: {
    /**
     * The latest nonterminal note, or null on the first check. `N` is inferred from the poll's
     * `noteSchema`, which also validates the note when it is read back from storage. Without
     * `noteSchema` it is {@link JsonValue}: narrow or parse it (for example with a Zod schema).
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
 * and an invalid note (including a note that fails `noteSchema`, returned or saved) always fail the
 * wait.
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

/**
 * The result of one poll check: terminal with a `value` the poll's `schema` validates, or
 * nonterminal with an optional `note` that is saved for the next check (and validated with
 * `noteSchema` when the poll has one).
 */
export type PollResult<T, N extends JsonInput = JsonValue> =
  | {
      /** The check found the awaited state. */
      readonly done: true;
      /** Terminal value, parsed by the poll's `schema`. */
      readonly value: T;
    }
  | {
      /** The check found nothing final yet. */
      readonly done: false;
      /** Progress for the next check's `previous.note`; omitted or null saves null. */
      readonly note?: N | null;
    };

/**
 * `X` with readonly arrays, tuples and object properties at every depth; primitives, literals and
 * functions are unchanged. The inferred `ctx.poll` overload captures a callback's result as a
 * `const` type parameter, which turns an array literal such as `[1, 2]` into `readonly [1, 2]`, so
 * that result is checked against `PollResult<PollReadonly<T>, PollReadonly<N>>`: an array literal
 * still matches `z.array(...)`, a tuple schema or a `noteSchema` array. The outcome keeps the
 * schema's own type `T`, because the runtime parses the value with `schema`.
 */
export type PollReadonly<X> = X extends (...args: never[]) => unknown
  ? X
  : X extends readonly unknown[]
    ? X[number][] extends X
      ? PollReadonlyArray<X[number]>
      : { readonly [K in keyof X]: PollReadonly<X[K]> }
    : X extends object
      ? { readonly [K in keyof X]: PollReadonly<X[K]> }
      : X;

/**
 * A {@link PollReadonly} array. An interface rather than a mapped array type, so that a recursive
 * element type such as {@link JsonValue} is expanded only as deep as a check needs.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PollReadonlyArray<E> extends ReadonlyArray<PollReadonly<E>> {}

/** One read-only check; only its final value becomes a workflow branch decision. */
export interface PollSource<T, N extends JsonInput = JsonValue> {
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
   * aborts and the wait resolves by `deadline`. A body failure does not wait for it: the failure
   * drain aborts the signal at once. It is execution policy, not identity: it is not persisted and
   * may change on resume.
   */
  readonly observeTimeoutMs?: number;
  /**
   * Tolerate a bounded number of consecutive observation errors instead of failing the wait. It is
   * execution policy, not identity: it is not persisted and may change on resume.
   */
  readonly onError?: PollErrorPolicy;
  /**
   * Schema for the poll's note. It types `previous.note` (as `N | null`, with `N` inferred from
   * this schema, so no type arguments are needed) and validates notes in both directions: a
   * nonterminal note the check returns is parsed before it is saved, and the saved note is parsed
   * again before the next check sees it. Parsed output replaces the note, so a `z.object` strips
   * unknown keys. Null is outside the schema: the first check's `null`, and the null saved for a
   * `{ done: false }` with no note, are passed through unparsed, so the schema need not be
   * nullable, and a check may return `note: null` or forward `previous.note` whatever the schema. A note that fails the schema fails the wait with code
   * `QUIET_CHOIR_POLL_NOTE_INVALID` (error kind `schema`) and the Zod error as `cause`; `onError`
   * never tolerates it. The schema is reapplied to its own output on the next check, so it should
   * accept what it produces and avoid non-idempotent transforms. It is policy, not identity: it is
   * not persisted and may change on resume, so to migrate a changed note shape accept the old shape
   * (a union) or reset it with `.catch(null)`; otherwise use a new wait ID. Without it the note is
   * {@link JsonValue} and unvalidated.
   */
  readonly noteSchema?: z.ZodType<N>;
  /**
   * Read external state without writes or nested workflow operations. Honor `context.signal`: an
   * observation that ignores its aborted signal is abandoned after a short grace, with a run
   * warning. The signal also aborts when a body failure starts draining the run; that observation
   * records nothing and reruns on resume. `context.previous` carries the persisted note and check
   * count from earlier checks.
   */
  readonly observe: NoInfer<(context: PollContext<N>) => Promise<PollResult<T, N>>>;
  /** Only a {@link CommandPollSource} runs a command; an observer poll has none. */
  readonly command?: never;
}

/**
 * Options of the command a {@link CommandPollSource} runs on each check: those of a callback's
 * `context.exec` without `timeoutMs` (the poll's `observeTimeoutMs` bounds each check) and
 * `onError` (a failed command is a rejected observation, so the poll's `onError` applies).
 */
export type PollCommandExecOptions = Omit<StepExecOptions, 'timeoutMs' | 'onError'>;

/**
 * A poll whose every check runs one command through the run's process runner, validates its JSON
 * stdout with `output`, and lets `done` decide the outcome. The engine owns the child: it is
 * registered under the wait for orphan recovery, stopped with the observation's signal, and
 * synthesized or fixture-answered under a rehearsal. `input`, `schema`, `every`, `noteSchema`,
 * `observeTimeoutMs` and `onError` mean what they mean for an observer {@link PollSource}; a
 * `noteSchema` applies to the notes `done` returns and to `previous.note`.
 */
export interface CommandPollSource<T, O = unknown, N extends JsonInput = JsonValue> extends Omit<
  PollSource<T, N>,
  'observe' | 'command'
> {
  /**
   * The command for each check, an argv or `{ shell }`. With the canonical working directory and
   * the environment overlay, stdin digest and accepted exit codes from `commandOptions`, it is part
   * of the wait's identity, so changing it needs a new wait ID.
   */
  readonly command: Command;
  /** Schema for the command's JSON stdout, part of the wait's identity. */
  readonly output: z.ZodType<O>;
  /**
   * How to run the command. `cwd`, `env`, `inheritEnv`, `input` and `okExitCodes` are identity;
   * `maxOutputBytes` is policy. Output that exceeds the cap fails the check.
   */
  readonly commandOptions?: PollCommandExecOptions;
  /**
   * Run the real command even under a `--dry-run` rehearsal, which otherwise synthesizes its
   * output from `output` or answers it from an exec fixture rule. Keep it to read-only commands.
   * Policy, not identity.
   */
  readonly live?: boolean;
  /**
   * Decide the outcome of one check from the validated output and the wait's persisted progress
   * before it. It must be pure: it gets no context, cannot call context operations, and keeps
   * cross-check state (such as a debounce flag) in the note. Its source text is part of the wait's
   * identity. A throw is a rejected observation, so the poll's `onError` applies to it.
   *
   * `O` is inferred from `output`, never from `done`. In a `ctx.wait` poll source `output` is
   * `unknown`: narrow it, or use `ctx.poll` for an inferred type.
   */
  readonly done: NoInfer<
    (
      output: O,
      previous: PollContext<N>['previous'],
    ) => PollResult<T, N> | Promise<PollResult<T, N>>
  >;
  /** Only an observer {@link PollSource} has `observe`. */
  readonly observe?: never;
}

/**
 * Sources competing inside one durable wait; at least one must be supplied. `N` is the poll's note
 * type, which `ctx.wait` infers from the poll source's `noteSchema` as `ctx.poll` does.
 */
export interface WaitSources<N extends JsonInput = JsonValue> {
  /** Relative duration, pinned to an absolute deadline when first opened. */
  readonly timeoutMs?: number;
  /** Absolute Unix epoch deadline; cannot be combined with timeoutMs. */
  readonly deadline?: number;
  /** An optional external answer, with its subject and presentation fingerprinted. */
  readonly signal?: SignalSource<unknown>;
  /** An optional changing-state observation, by an observer or by a command. */
  readonly poll?: PollSource<unknown, N> | CommandPollSource<unknown, unknown, N>;
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

/** The finite time bound a `ctx.poll` call must include: `timeoutMs` or `deadline`, not both. */
export type PollTimeBound =
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
    };

/** A polling convenience call must include a finite time bound. */
export type PollOptions<T, N extends JsonInput = JsonValue> = PollSource<T, N> & PollTimeBound;

/**
 * A command poll's time bound, like {@link PollOptions}: `ctx.poll` requires `timeoutMs` or
 * `deadline`.
 */
export type CommandPollOptions<T, O = unknown, N extends JsonInput = JsonValue> = CommandPollSource<
  T,
  O,
  N
> &
  PollTimeBound;

/**
 * The options of an inferred `ctx.poll` call, in either form: an observer {@link PollSource} or a
 * {@link CommandPollSource}, with a time bound. `T` comes only from `schema`, never from a
 * callback; `N` from `noteSchema` (or {@link JsonValue} without one) and `O` from `output`. `R` is
 * the callback's own result type, which `ctx.poll` captures as a `const` type parameter checked
 * against a {@link PollResult} of {@link PollReadonly} views of `T` and `N`; so an `observe` or
 * `done` callback, with or without parameters, keeps a literal terminal value such as `'green'`
 * from a conditional expression or a statement return without `as const`, and an array literal
 * still matches an array or tuple schema.
 */
export type PollCallOptions<T, O, N extends JsonInput, R> = Omit<
  PollSource<T, N>,
  'observe' | 'command'
> &
  PollTimeBound &
  (
    | {
        /** Read external state, as {@link PollSource.observe}. */
        readonly observe: (context: PollContext<N>) => Promise<R>;
        /** Only a command poll runs a command. */
        readonly command?: never;
      }
    | (Pick<CommandPollSource<unknown, O, N>, 'command' | 'output' | 'commandOptions' | 'live'> & {
        /** Decide one check's outcome from the command's output, as {@link CommandPollSource.done}. */
        readonly done: (output: NoInfer<O>, previous: PollContext<N>['previous']) => R | Promise<R>;
        /** Only an observer poll has `observe`. */
        readonly observe?: never;
      })
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
  /**
   * Hash of the observer's source, or of `done`'s source for a command poll; captured dependencies
   * still belong in input.
   */
  readonly observe: string;
  /**
   * A command poll's command and output contract; absent for an observer poll, whose persisted
   * request and identity are unchanged by it.
   */
  readonly command?: {
    /** The prepared command: argv or shell, canonical cwd, env and stdin digests, exit codes. */
    readonly exec: ExecSummary;
    /** JSON Schema of the command's stdout. */
    readonly output: JsonValue;
  };
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
  /** The command a command poll runs on each check, or null for any other wait. */
  readonly command: Command | null;
  /** Most recent rejected signal deliveries, empty without a signal source. */
  readonly rejections: readonly QuestionRejection[];
  /** Whether stored source bytes changed; null without launch metadata. */
  readonly codeChanged: boolean | null;
  /**
   * Delivery command for a signal, or null for timer/poll-only and disposed rehearsals. Replace
   * ANSWER_JSON with serialized data and, for a human signal, NAME in `--by human:<NAME>` with the
   * human's name.
   */
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
  /**
   * Status of the run that owns the row, from its checkpoint. Spelled out, not `RunRecord['status']`,
   * because this module's types are part of the bundle that workflow type checks load, which must
   * not reach the store; a test keeps the two in step.
   */
  readonly runStatus: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  /** Inbox delivery state, or null for a poll or deadline wait that accepts no answer. */
  readonly delivery: PendingDelivery | null;
}

/** A {@link PendingOperation} row as listed: with its run's status and its delivery state. */
export type PendingListing = PendingOperation & PendingRunState;

import type { AgentRequest } from './harness-model.js';
import type {
  HarnessDeclaration,
  HarnessMap,
  BuiltInHarnesses,
  WorkflowHarnesses,
  RegisteredAgentClient,
  CallOptions,
  CapabilitiesOf,
} from './harness-model.js';
import type { ClaudeOptions } from '../../harnesses/builtins/claude-options.js';
import type { CodexOptions } from '../../harnesses/builtins/codex-options.js';
export type { ClaudeOptions } from '../../harnesses/builtins/claude-options.js';
export type { CodexOptions } from '../../harnesses/builtins/codex-options.js';
import type { AgentEnvironment, HostEnvironmentSummary } from './agent-environment-model.js';
import type { AgentDiagnostics, AgentProgress, TranscriptMode } from './agent-stream-model.js';
import type { AgentWorktree, HarnessIsolation } from './agent-isolation.js';
import type { MergeOptions, MergeResult, WorktreePolicy } from './worktree-model.js';
import type { WorktreeChange, WorktreeHandle, WorktreeCreateOptions } from './worktree-model.js';
import type {
  ReadFileOptions,
  ReadFileResult,
  WriteFileOptions,
  WriteFileResult,
} from './file-model.js';
import type { ExecFunction, StepExecFunction } from './exec-model.js';
import type { AskOptions, ApproveOptions, Approval } from './question-model.js';
import type {
  WaitSources,
  WaitOutcome,
  PollOptions,
  CommandPollOptions,
  PollOutcome,
  DeadlineOutcome,
} from './wait-model.js';
import type { PhaseOptions } from './observability-model.js';
import type { z } from 'zod';
import type { AgentDefaults, AgentProfile } from './profiles-model.js';
import type { MapStepError } from './fan-out.js';
import type { ModelUsage, TokenCounts } from './usage-model.js';
import type { ChildOptions, WorkflowDeclaration, WorkflowPhase } from './child-model.js';

/** A value that survives checkpoint serialization without changing its meaning. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON dependencies before persistence; undefined object members are omitted, never array elements. */
export type JsonInput =
  | null
  | boolean
  | number
  | string
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput | undefined };

/**
 * Stable categories used by settled outcomes and selective retry. `invalid-request` is a request
 * the provider rejected as malformed (HTTP 400/404/422, an unknown model or an invalid option);
 * `overloaded` is a provider-side failure (HTTP 500/502/503/529). `idle-timeout` is an agent
 * attempt that produced no output for its `idleTimeoutMs`, distinct from the wall-clock `timeout`.
 */
export type ErrorKind =
  | 'timeout'
  | 'idle-timeout'
  | 'rate-limit'
  | 'overloaded'
  | 'invalid-request'
  | 'schema'
  | 'authentication'
  | 'permission'
  | 'turn-limit'
  | 'budget-limit'
  | 'output-limit'
  | 'process'
  | 'protocol'
  | 'cancelled'
  | 'unknown';

/** Serialized final failure of an explicitly settled effect. */
export type StepError = Readonly<{
  /** Original failure explanation. */
  readonly message: string;
  /** Structured category, or unknown when no reliable category is available. */
  readonly kind: ErrorKind;
  /** Total started attempts for this step across resumes. */
  readonly attempts: number;
}>;

/** A journaled outcome that can safely select a branch on replay. */
export type Settled<T, TError = StepError> =
  | {
      /** Successful effect. */
      readonly ok: true;
      /** Validated effect result. */
      readonly value: T;
    }
  | {
      /** Failed effect after applicable retries. */
      readonly ok: false;
      /** Saved failure, replayed without executing the effect again. */
      readonly error: TError;
    };

/** Throw failures by default, or persist and return the final failure. */
export type ErrorMode = 'throw' | 'return';

/**
 * Return type selected by an effect's error mode. `TError` is the saved failure shape of a settled
 * result: {@link StepError} by default, `ExecStepError` for commands.
 */
export type EffectResult<T, TMode extends ErrorMode, TError = StepError> = TMode extends 'return'
  ? Settled<T, TError>
  : T;

/** Effort levels supported by both harnesses; model support can differ. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A native instruction file a harness loads on its own, recorded as a path and digest, never contents. */
export interface InstructionSource {
  /** User-level files depend on who runs the workflow; project files belong to the checkout. */
  readonly scope: 'user' | 'project';
  /** Plain AGENTS.md, an AGENTS.override.md that replaces it in its directory, or a skill description file. */
  readonly kind: 'agents' | 'agents-override' | 'skill';
  /** Absolute path of the file. */
  readonly path: string;
  /** SHA-256 hex digest of the file bytes. */
  readonly sha256: string;
}

/** Native harness installation captured for diagnostics, outside semantic identity. */
export interface HarnessMetadata {
  /** Parent variable names and scrubbed host-session names, never values. */
  readonly environment?: HostEnvironmentSummary;
  /** Executable selected by the adapter. */
  readonly binary: string;
  /** Version string, or null if version discovery failed. */
  readonly version: string | null;
  /** Nonfatal discovery diagnostics. */
  readonly warnings?: readonly string[];
  /** Native instruction files the harness loads whatever the isolation mode, as paths and digests. */
  readonly instructionSources?: readonly InstructionSource[];
}

/** An immutable image snapshot; adapters must use these bytes when provided. */
export interface ImageAttachment {
  /** SHA-256 of the original file bytes. */
  readonly sha256: string;
  /** File bytes encoded as base64; not persisted in the run record. */
  readonly base64: string;
}

/** Options shared by headless agent calls. */
export interface AgentOptions {
  /** Native configuration loading, default restricted. It never selects a checkout. */
  readonly isolation?: HarnessIsolation | undefined;
  /**
   * Run in a runtime-owned checkout: `true` for a fresh worktree from HEAD per attempt, `{ base }`
   * for one from another ref or commit, or a `ctx.worktree` handle to share that checkout.
   */
  readonly worktree?: AgentWorktree | undefined;
  /** Additional tool directories; Codex treats these as writable roots. */
  readonly addDirs?: readonly string[] | undefined;
  /** Fingerprinted escape hatch; use --flag=value for values, never reserved/typed flags. */
  readonly extraArgs?: readonly string[] | undefined;
  /** Fingerprinted set/unset edits after host scrubbing; flat set-only overlays remain supported. */
  readonly env?: AgentEnvironment | undefined;
  /** Declared role or built-in preset; omission uses workflow defaults. */
  readonly profile?: string | undefined;
  /** Persist a terminal outcome for branching; cancellation, configuration (e.g. missing harness), and checkpoint-write failures still reject. */
  readonly onError?: ErrorMode | undefined;
  /** Instructions sent over stdin, never interpolated into a shell command. */
  readonly prompt: string;
  /** Model name or harness alias; omission uses the harness default. */
  readonly model?: string | undefined;
  /** Working directory, relative to the workflow run's working directory. */
  readonly cwd?: string | undefined;
  /** Wall-clock deadline in milliseconds; implicit text profile: 300,000. Custom harnesses must enforce it. */
  readonly timeoutMs?: number | undefined;
  /** Idle deadline: no stdout/stderr output for this long ends the attempt with kind idle-timeout. Off by default; custom harnesses must enforce it. */
  readonly idleTimeoutMs?: number | undefined;
  /** Explicit runtime retries for calls safe to repeat; not part of replay identity. */
  readonly retry?: RetryPolicy | undefined;
}

/** Plain-data inputs for planning a harness invocation, before durable call identity is attached. */
export type BuiltinHarnessRequestInput = (
  | {
      /** Claude Code integration. */
      readonly harness: 'claude';
      /** Claude-specific invocation options. */
      readonly options: ClaudeOptions;
    }
  | {
      /** Codex integration. */
      readonly harness: 'codex';
      /** Codex-specific invocation options. */
      readonly options: CodexOptions;
    }
) & {
  /** Absolute execution directory. */
  readonly cwd: string;
  /** JSON Schema for structured responses, or null for text. */
  readonly outputSchema: JsonValue | null;
  /** Runtime image bytes corresponding to options.images; immutable for this invocation. */
  readonly imageAttachments?: readonly ImageAttachment[];
};

/** Plain-data agent options before durable attempt identity is attached. */
export interface HarnessRequestInput<O extends AgentOptions = AgentOptions> {
  /** Registered harness identity, separate from any model-provider option. */
  readonly harness: string;
  /** Definition revision; pure planners may omit it for built-in revision one. */
  readonly revision?: number;
  /** Validated options from the corresponding registration. */
  readonly options: O;
  /** Absolute execution directory. */
  readonly cwd: string;
  /** Structured response schema, or null for text. */
  readonly outputSchema: JsonValue | null;
  /** Immutable image bytes for adapters supporting image inputs. */
  readonly imageAttachments?: readonly ImageAttachment[];
}

/** Durable identity of one attempt, attached after semantic fingerprinting. */
export interface HarnessCall {
  /** Owning run ID. */
  readonly runId: string;
  /** Fully qualified step ID. */
  readonly stepId: string;
  /** One-based cumulative attempt, including attempts before resume. */
  readonly attempt: number;
  /** Stable across retries and resumes: `${runId}/${stepId}`. */
  readonly idempotencyKey: string;
}

/** Compatibility name for the generic request delivered to every harness. */
export type HarnessRequest = AgentRequest;

/** Usage reported by the harness, with null for unavailable measurements. */
export interface AgentUsage {
  /** Total processed input for current native adapters; legacy values retain their original meaning. */
  readonly inputTokens: number | null;
  /** Generated output tokens, including reasoning. */
  readonly outputTokens: number | null;
  /** Harness-reported USD estimate, not a bill; null where unavailable. */
  readonly costUsd: number | null;
  /** Disjoint categories where known; reasoning is a subset of output. */
  readonly tokens?: TokenCounts;
  /** Measurements attributed to effective models; do not add these to the top-level totals. */
  readonly byModel?: Readonly<Record<string, ModelUsage>>;
  /** Requested model after policy resolution, and effective names only when actually reported. */
  readonly model?: {
    /** Model option after policy resolution; null when the harness chooses its own default. */
    readonly requested: string | null;
    /** Native model identifiers, or null when the harness does not establish them. */
    readonly effective: readonly string[] | null;
  };
  /** At least one measurement was reported, or all measurements are unavailable. */
  readonly completeness?: 'reported' | 'unavailable';
  /** Verbatim native usage fields, including cache TTLs and cost basis. */
  readonly reported?: JsonValue;
  /** JSON-compatible custom measurements are preserved outside the identity contract. */
  readonly [key: string]: unknown;
}

/** Normalized response from a headless harness. */
export interface HarnessResponse {
  /** Bounded native metadata, including warnings and transcript information when available. */
  readonly diagnostics?: AgentDiagnostics;
  /** Final text, or serialized structured output. */
  readonly text: string;
  /** Native session/thread identifier for diagnostics; not a workflow resume token. */
  readonly sessionId: string | null;
  /** Optional partial measurements; the runtime fills absent values with null and preserves extras. */
  readonly usage?: Partial<AgentUsage> | null;
  /** Recoverable protocol notices, persisted as diagnostics outside the result fingerprint. */
  readonly warnings?: readonly string[];
  /** Count of denied tool requests reported by the terminal envelope. */
  readonly permissionDenials?: number;
  /** Reported agent turns, when available. */
  readonly turns?: number;
}

/** Identity of a directly spawned child and its owned process group. */
export interface HarnessProcess {
  /** Child PID; must be greater than one. */
  readonly pid: number;
  /** Detached POSIX group ID (equal to pid), or null for a Windows child. */
  readonly pgid: number | null;
  /** Executable name, excluding arguments and credentials. */
  readonly binary: string;
  /** Absolute invocation working directory. */
  readonly cwd: string;
  /** Wall-clock spawn timestamp for diagnostics. */
  readonly startedAt: string;
  /** OS birth identity, including boot identity where available; null when unavailable. */
  readonly osStartTime: string | null;
}

/** Runtime ownership and cancellation for a single harness attempt. */
export interface HarnessInvocation {
  /** Predetermined native session ID, when the harness accepts one. Never semantic identity. */
  readonly sessionId?: string | null;
  /** Runtime-owned transcript path, or null when disabled. Write through onOutput. */
  readonly transcriptPath?: string | null;
  /** Resolved resource policy, outside the request fingerprint. */
  readonly policy?: ExecutionPolicy;
  /** Persist the first observed native ID before consuming further output. */
  readonly onSession?: (sessionId: string) => Promise<void>;
  /** Deliver a lossy bounded activity observation; observer exceptions cannot fail the call. */
  readonly onProgress?: (event: AgentProgress) => void;
  /** Tee raw bytes with backpressure; a rejected write must terminate the child. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => Promise<void>;
  /** Captured scope signal; installation discovery instead receives the run's shared discovery signal. */
  readonly signal: AbortSignal;
  /** Owning durable run. */
  readonly runId: string;
  /** Fully qualified effect name. */
  readonly stepId: string;
  /** One-based attempt number across resumes. */
  readonly attempt: number;
  /** Register immediately after spawn, before sending input. Release only after reaping. */
  trackProcess(process: HarnessProcess): Promise<{
    /** Remove the durable ownership record after confirming the process/group is gone. */
    release(): Promise<void>;
  }>;
}

/** Replaceable integration port, also useful for deterministic tests. */
export interface Harness {
  /** Checkpoint provenance; changing a recorded kind requires explicit authorization. Defaults to custom. */
  readonly kind?: string;
  /**
   * Discover the native binary/version on first live use in each run invocation. Discovery is
   * shared by the run: `invocation.signal` aborts on interruption or once no effect still awaits
   * the result.
   */
  metadata?(request: HarnessRequest, invocation: HarnessInvocation): Promise<HarnessMetadata>;
  /** Report effective adapter limits for attempt records. Omit unknown defaults; never perform effects here. */
  policyDefaults?(harness: HarnessRequest['harness']): ExecutionPolicy;
  /** Invoke one fresh session; enforce your own limits, settle on abort, and reject process/protocol failure. */
  invoke(request: HarnessRequest, invocation: HarnessInvocation): Promise<HarnessResponse>;
}

/** Typed and validated agent output, saved together with harness metadata. */
export interface AgentResult<T> {
  /** Extensible native diagnostics; absent from legacy or custom results. */
  readonly diagnostics?: AgentDiagnostics;
  /** Captured change for isolated calls; absent for ordinary and legacy results. */
  readonly worktree?: WorktreeChange;
  /** Validated output, inferred from the schema for object calls. */
  readonly output: T;
  /** Native harness session identifier. */
  readonly sessionId: string | null;
  /** Harness-reported usage. */
  readonly usage: AgentUsage;
}

/** Dedicated typed API for a harness, with durable calls keyed by unique step IDs. */
export interface AgentClient<TOptions extends AgentOptions> {
  /** Return only the structured output; checkpoint the same result and metadata as object(). */
  value<T>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
  ): Promise<Settled<T>>;
  /** Return structured output with an inferred or dynamic error mode. */
  value<T, TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode | undefined },
  ): Promise<EffectResult<T, TMode>>;
  /** Without a schema, return only text; onError: return produces Settled<string>. */
  value<TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly schema?: never; readonly onError?: TMode | undefined },
  ): Promise<EffectResult<string, TMode>>;
  /** Invoke the harness for a plain text response. */
  text<TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<AgentResult<string>, TMode>>;
  /** Request structured output and validate it locally before checkpointing. */
  object<T>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
  ): Promise<Settled<AgentResult<T>>>;
  /** Request structured output with an inferred or dynamic error mode. */
  object<T, TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode | undefined },
  ): Promise<EffectResult<AgentResult<T>, TMode>>;
}

/** Retry policy explicitly opted into for an effect that is safe to repeat. */
export interface RetryPolicy {
  /** Maximum total attempts during this execution; defaults to one. */
  readonly maxAttempts: number;
  /** Initial delay in milliseconds, doubled on each retry; defaults to 100. */
  readonly delayMs?: number;
  /**
   * Retry only these categories; `'transient'` stands for `rate-limit`, `overloaded`, `timeout`
   * and `idle-timeout`. Omission retries every non-fatal failure except `invalid-request`; []
   * retries none.
   */
  readonly on?: readonly (ErrorKind | 'transient')[];
}

/** Context supplied to a local effect. */
export interface StepContext {
  /** Replace this local attempt's cumulative reported usage; saved with its outcome, including failure. */
  readonly reportUsage: (usage: AgentUsage) => void;
  /** Actual execution directory; mapped into an isolated checkout when selected. */
  readonly cwd: string;
  /** Cooperative cancellation signal; effects should pass it to cancellable operations. */
  readonly signal: AbortSignal;
  /** Stable run/step key for deduplicating external side effects. */
  readonly idempotencyKey: string;
  /** Total persisted attempt number, including previous resumes. */
  readonly attempt: number;
  /**
   * Run a command through the run's process runner while this callback is active, without a step
   * ID: `exec(command, options?)` and `exec.json(command, { schema })`. It is not a durable effect:
   * no checkpoint or step record is written and every rerun of this step runs it again (at least
   * once). The child is owned under this step and attempt for orphan recovery, receives this step's
   * `QUIET_CHOIR_*` metadata, and is synthesized or fixture-answered under a rehearsal like
   * `ctx.exec`. A failure throws an `ExecError` into this attempt unless `onError: 'return'`.
   */
  readonly exec: StepExecFunction;
}

/** A local durable effect. Keep nondeterminism and side effects inside its callback. */
export interface StepDefinition<T> {
  /** JSON labels for inspection, excluded from semantic identity; never put credentials here. */
  readonly meta?: Readonly<Record<string, JsonValue>>;
  /** Serialize on this handle and snapshot its tree after a validated result. */
  readonly worktree?: WorktreeHandle;
  /** Persist and return final failures as Settled<T>; cancellation still rejects. */
  readonly onError?: ErrorMode | undefined;
  /** Explicit revision for captured values, helpers, or environment not visible in callback source. */
  readonly version?: string;
  /**
   * Identify this step by its explicit `version` instead of callback source, so the callback text
   * is excluded from identity and `version` becomes required. Built-in helpers only; this field is
   * not public API.
   *
   * @internal
   */
  readonly identity?: 'version';
  /** Explicit JSON dependencies, checked for drift on replay after omitting undefined object members. */
  readonly input: JsonInput;
  /** Runtime validator for the result, also applied on replay. */
  readonly schema: z.ZodType<T>;
  /** Optional retry policy; there are no automatic retries by default. */
  readonly retry?: RetryPolicy;
  /** Perform the effect. Do not nest workflow steps inside this callback. */
  readonly run: NoInfer<(context: StepContext) => Promise<T> | T>;
}

/**
 * Declared child names of a `children` tuple. An unparameterized context (`any`) or any child whose
 * name is a plain `string` (such as a {@link WorkflowDeclaration}) widens this to `string`.
 */
export type ChildNamesOf<TChildren> = 0 extends 1 & TChildren
  ? string
  : TChildren extends readonly WorkflowDeclaration[]
    ? TChildren[number]['name']
    : string;

/**
 * Input of declared child `N`: the parsed type of its input schema, or {@link JsonValue} when the
 * children are not known precisely (see {@link ChildNamesOf}).
 */
export type ChildInputOf<TChildren, N extends string> =
  string extends ChildNamesOf<TChildren>
    ? JsonValue
    : TChildren extends readonly WorkflowDeclaration[]
      ? z.output<
          Extract<
            TChildren[number],
            {
              /** Declared child name. */
              readonly name: N;
            }
          >['input']
        >
      : JsonValue;

/**
 * Output of declared child `N`: the parsed type of its output schema, or {@link JsonValue} when the
 * children are not known precisely (see {@link ChildNamesOf}).
 */
export type ChildOutputOf<TChildren, N extends string> =
  string extends ChildNamesOf<TChildren>
    ? JsonValue
    : TChildren extends readonly WorkflowDeclaration[]
      ? z.output<
          Extract<
            TChildren[number],
            {
              /** Declared child name. */
              readonly name: N;
            }
          >['output']
        >
      : JsonValue;

/**
 * Durable operations available to ordinary TypeScript workflow code. `TStrict` is the workflow's
 * `strictProfiles` literal: exactly `true` omits profile-owned capability keys from call-site option
 * types, and the default `boolean` keeps them, so an unparameterized helper context stays permissive.
 * `TChildren` is the declared `children` tuple that types by-name child dispatch; the default `any`
 * keeps by-name dispatch on JSON values and lets typed contexts reach bare `WorkflowContext` helpers.
 */
export interface WorkflowContext<
  TProfile extends string = string,
  R extends HarnessMap = BuiltInHarnesses,
  TStrict extends boolean = boolean,
  // `any`, not a concrete array: a concrete default makes typed contexts unassignable to helpers
  // that take a bare WorkflowContext, through the variance of the by-name workflow overload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TChildren extends readonly WorkflowDeclaration[] = any,
> {
  /**
   * Select one explicitly registered harness; capabilities determine structured-output availability.
   * Options are typed like `ctx.claude`: `profile` must be a built-in or declared role, and a strict
   * workflow omits the harness's literal `capabilityKeys` (see {@link CallOptions}).
   */
  agent<K extends keyof R & string>(
    name: K,
  ): RegisteredAgentClient<CallOptions<K, R[K], TProfile, TStrict>, CapabilitiesOf<R[K]>>;
  /**
   * Run a typed child inline with validated I/O, recorded identity, and a scoped effect namespace.
   * With `onError: 'return'`, the frame's outcome is saved and returned as
   * `Settled<O, MapStepError>`; resume replays it without running the child body again.
   */
  workflow<
    I,
    O,
    P extends string,
    H extends readonly HarnessDeclaration[],
    S extends boolean,
    C extends readonly WorkflowDeclaration[],
    M extends string,
  >(
    id: string,
    child: WorkflowDefinition<I, O, P, H, S, C, M>,
    input: NoInfer<I>,
    options: ChildOptions & { readonly onError: 'return' },
  ): Promise<Settled<O, MapStepError>>;
  /** Run a typed child inline with an inferred or dynamic error mode. */
  workflow<
    I,
    O,
    P extends string,
    H extends readonly HarnessDeclaration[],
    S extends boolean,
    C extends readonly WorkflowDeclaration[],
    M extends string,
    TMode extends ErrorMode = 'throw',
  >(
    id: string,
    child: WorkflowDefinition<I, O, P, H, S, C, M>,
    input: NoInfer<I>,
    options?: ChildOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<O, TMode, MapStepError>>;
  /**
   * Dispatch only among the current workflow's declared children; the runtime validates input and
   * output with the child's schemas. In a workflow defined with literal `children`, the name must be
   * declared, the input must match that child's input type, and the result has its output type. A
   * bare `WorkflowContext`, or a child typed as an erased {@link WorkflowDeclaration}, falls back to
   * any name and {@link JsonValue} input and output. `onError: 'return'` returns the saved frame
   * outcome as a `Settled` result with a `MapStepError`.
   */
  workflow<const N extends string>(
    id: string,
    childName: N & ChildNamesOf<TChildren>,
    input: NoInfer<ChildInputOf<TChildren, N>>,
    options: ChildOptions & { readonly onError: 'return' },
  ): Promise<Settled<ChildOutputOf<TChildren, N>, MapStepError>>;
  /** Dispatch a declared child by name with an inferred or dynamic error mode. */
  workflow<const N extends string, TMode extends ErrorMode = 'throw'>(
    id: string,
    childName: N & ChildNamesOf<TChildren>,
    input: NoInfer<ChildInputOf<TChildren, N>>,
    options?: ChildOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<ChildOutputOf<TChildren, N>, TMode, MapStepError>>;
  /**
   * Integrate pinned changes in input order; only target checkout modifies the source working tree.
   * With `onError: 'return'`, a failure such as an `onConflict: 'fail'` conflict is saved and
   * replayed as a settled result without touching Git again.
   */
  merge(
    id: string,
    changes: readonly (WorktreeChange | WorktreeHandle)[],
    options: MergeOptions & { readonly onError: 'return' },
  ): Promise<Settled<MergeResult>>;
  /** Integrate pinned changes with an inferred or dynamic error mode. */
  merge<TMode extends ErrorMode = 'throw'>(
    id: string,
    changes: readonly (WorktreeChange | WorktreeHandle)[],
    options?: MergeOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<MergeResult, TMode>>;
  /** Create a run-owned shared checkout; completed effects on it become pinned snapshots. */
  worktree(id: string, options?: WorktreeCreateOptions): Promise<WorktreeHandle>;
  /** Canonical workflow working directory. */
  readonly cwd: string;
  /** Operator-privileged durable commands; agent tool grants do not restrict this API. */
  readonly exec: ExecFunction;
  /**
   * Atomically publish UTF-8 content and save a hash-only receipt. Creates missing parent
   * directories. With `onError: 'return'`, a failure such as an `ifMatch` conflict is saved and
   * replayed as a settled result.
   */
  writeFile(
    id: string,
    path: string,
    content: string,
    options: WriteFileOptions & { readonly onError: 'return' },
  ): Promise<Settled<WriteFileResult>>;
  /** Publish UTF-8 content with an inferred or dynamic error mode. */
  writeFile<TMode extends ErrorMode = 'throw'>(
    id: string,
    path: string,
    content: string,
    options?: WriteFileOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<WriteFileResult, TMode>>;
  /**
   * Save a size-capped UTF-8 snapshot; later reads with this ID replay it. With
   * `onError: 'return'`, a failure such as an oversized file is saved and replayed as a settled
   * result.
   */
  readFile(
    id: string,
    path: string,
    options: ReadFileOptions & { readonly onError: 'return' },
  ): Promise<Settled<ReadFileResult>>;
  /** Save a snapshot with an inferred or dynamic error mode. */
  readFile<TMode extends ErrorMode = 'throw'>(
    id: string,
    path: string,
    options?: ReadFileOptions & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<ReadFileResult, TMode>>;
  /** Record the current clock once and replay it as a stable deadline anchor. */
  now(id: string): Promise<number>;
  /** Choose and persist one signal, poll, or deadline outcome. Never race durable operations yourself. */
  wait<const S extends WaitSources>(id: string, sources: S): Promise<WaitOutcome<S>>;
  /** Wait until a fixed epoch timestamp, suspending when quiescent unless due shortly. */
  sleepUntil(id: string, epochMs: number): Promise<null>;
  /**
   * Poll changing state with a pinned finite deadline and one bounded progress record. This form
   * runs one command per check through the run's process runner: its JSON stdout is validated with
   * `output` and `done(output, previous)` decides the outcome.
   */
  poll<T, O, N extends JsonValue = JsonValue>(
    id: string,
    options: CommandPollOptions<T, O, N>,
  ): Promise<PollOutcome<T> | DeadlineOutcome>;
  /**
   * Poll with a read-only observer callback. Declared last, so a mistake in an observer poll is
   * reported against this form.
   */
  poll<T, N extends JsonValue = JsonValue>(
    id: string,
    options: PollOptions<T, N>,
  ): Promise<PollOutcome<T> | DeadlineOutcome>;
  /** Await an external, schema-validated answer; quiescent runs suspend without rejecting. */
  ask<T>(id: string, options: AskOptions<T>): Promise<T>;
  /** Await approval of the fingerprinted subject. Human routing is a guardrail, not authentication. */
  approve(id: string, options: ApproveOptions): Promise<Approval>;
  /** Record a phase until the next phase call in this scope; never affects replay identity. */
  phase(title: string, options?: PhaseOptions): void;
  /** Attribute steps/logs in this callback to an isolated phase, including concurrent workers. */
  phase<T>(title: string, body: () => Promise<T>, options?: PhaseOptions): Promise<T>;
  /** Persist an observational message/data and emit it; matching prior occurrences replay once. */
  log(message: string, data?: JsonValue): void;
  /** Stable identifier for this execution and all resumes. */
  readonly runId: string;
  /** Current cancellation scope signal; nested maps inherit the run signal. */
  readonly signal: AbortSignal;
  /** Pure stable segments from arbitrary text/numbers; identical to exported stepId. */
  id(...parts: readonly (string | number)[]): string;
  /** Prefix every effect launched in the callback; nested scopes compose without counters. */
  scope<T>(prefix: string, run: () => Promise<T>): Promise<T>;
  /** Bind a lexical prefix to a reusable context; descendants retain their nested scope prefixes. */
  within(prefix: string): WorkflowContext<TProfile, R, TStrict, TChildren>;
  /** Claude-specific headless API; a strict workflow omits profile-owned keys (see {@link CallOptions}). */
  readonly claude: AgentClient<
    CallOptions<'claude', BuiltInHarnesses['claude'], TProfile, TStrict>
  >;
  /** Codex-specific headless API; a strict workflow omits profile-owned keys (see {@link CallOptions}). */
  readonly codex: AgentClient<CallOptions<'codex', BuiltInHarnesses['codex'], TProfile, TStrict>>;
  /** Save a JSON result and reuse it on resume when its inputs match. */
  step<T>(
    id: string,
    definition: StepDefinition<T> & { readonly onError: 'return' },
  ): Promise<Settled<T>>;
  /** Save a JSON result with an inferred or dynamic error mode. */
  step<T, TMode extends ErrorMode = 'throw'>(
    id: string,
    definition: StepDefinition<T> & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<T, TMode>>;
  /** Pin a relative timeout once; long waits suspend after active work drains. */
  sleep(id: string, milliseconds: number): Promise<null>;
  /**
   * Bounded fan-out in input order. Each item is scoped as `id/key` (its index by default), and every
   * key is validated before any mapper starts. Supply unique effect IDs inside the mapper.
   *
   * By default a mapper failure drains: scheduling stops and started mappers finish without being
   * aborted, then the map rejects with FanOutError (an escaping failure is attributed in
   * RunRecord.rootCause). `cancelSiblings: true` also cancels this map's own subtree, never the run.
   *
   * `onError: 'return'` journals each whole item outcome under the map ID and returns
   * `Settled<U, MapStepError>[]`; replay skips committed mappers and their owned effects. Inputs and
   * results must be lossless JSON, and `version` revises dependencies the items, keys and mapper
   * source do not show. With `cancelSiblings: true` the first item failure cancels the rest, which
   * are returned as `'cancelled'` failures. Run cancellation, infrastructure and authoring errors
   * still reject.
   */
  map<T, U, TMode extends 'throw' | 'return' = 'throw'>(
    id: string,
    items: readonly T[],
    options: MapOptions<T> & { readonly onError?: TMode | undefined },
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<TMode extends 'return' ? Settled<U, MapStepError>[] : U[]>;
}

/**
 * Definition of a typed workflow; plain JavaScript controls branching, loops, and composition.
 * `TStrict`, `TChildren` and `TName` carry the literal `strictProfiles`, `children` and `name` that
 * `defineWorkflow` infers into the context type; their defaults keep an unparameterized
 * `WorkflowDefinition<I, O>` parameter assignable from any typed definition.
 */
export interface WorkflowDefinition<
  TInput,
  TOutput,
  TProfile extends string = string,
  H extends readonly HarnessDeclaration[] = readonly HarnessDeclaration[],
  TStrict extends boolean = boolean,
  // `any`, not a concrete array: a concrete default makes typed definitions unassignable to
  // WorkflowDefinition<I, O> parameters through the variance of the run context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TChildren extends readonly WorkflowDeclaration[] = any,
  TName extends string = string,
> {
  /** Explicit agent registrations; Claude and Codex remain implicitly available. */
  readonly harnesses?: H;
  /** Human purpose, outside runtime replay identity. */
  readonly description?: string;
  /** Guidance for choosing this workflow, outside runtime replay identity. */
  readonly whenToUse?: string;
  /** Expected stages; these descriptions do not emit progress events. */
  readonly phases?: readonly WorkflowPhase[];
  /**
   * Inline children available for discovery and name-based dispatch. `defineWorkflow` keeps the list
   * as a tuple type, so `ctx.workflow(id, name, input)` checks the name and input and infers the
   * output; a workflow without children rejects by-name dispatch at type level.
   */
  readonly children?: TChildren;
  /** Common defaults applied after the selected preset. */
  readonly defaults?: AgentDefaults<NoInfer<TProfile>>;
  /** Named capability roles, resolved before executing the workflow body. */
  readonly profiles?: Readonly<Record<TProfile, AgentProfile>>;
  /**
   * Prohibit raw capability controls (tools, sandbox, env, `isolation: 'inherit'` and the rest) at
   * call sites; defaults to true. `defineWorkflow` infers the literal: omitted or `true` removes those
   * keys from `ctx.claude`, `ctx.codex` and `ctx.agent(name)` option types, while only a literal
   * `false` (or a non-literal `boolean`) types them. The runtime check still applies to untyped code.
   */
  readonly strictProfiles?: TStrict;
  /**
   * Worktree cache and dependency-provisioning policy for isolated effects. Only the root definition
   * passed to `runWorkflow` (or the CLI) is read; a child's field is ignored. Each field that
   * `RunOptions.worktrees` (or `--worktree-keep`/`--worktree-root`) sets replaces this one. It is
   * validated when the definition loads and stays outside step identity.
   */
  readonly worktrees?: WorktreePolicy;
  /** Stable workflow name, checked on resume; a literal name types by-name dispatch from a parent. */
  readonly name: TName;
  /** Explicit compatibility version; bump whenever code or dependencies change semantics. */
  readonly version: string;
  /** Input validator and source of the inferred input type. */
  readonly input: z.ZodType<TInput>;
  /** Output validator and source of the inferred output type. */
  readonly output: z.ZodType<TOutput>;
  /** Workflow body. It replays from the beginning when resuming. */
  readonly run: NoInfer<
    (
      context: WorkflowContext<
        NoInfer<TProfile>,
        WorkflowHarnesses<NoInfer<H>>,
        NoInfer<TStrict>,
        NoInfer<TChildren>
      >,
      input: TInput,
    ) => Promise<TOutput>
  >;
}

/**
 * Define a workflow with input/output types inferred from its runtime schemas. The literal
 * `strictProfiles` (omitted means `true`), `children` tuple and `name` are inferred too, so strict
 * call sites, declared profiles and by-name child dispatch are checked at type level.
 */
export function defineWorkflow<
  TInput,
  TOutput,
  TProfile extends string = never,
  const H extends readonly HarnessDeclaration[] = readonly [],
  const TStrict extends boolean = true,
  const TChildren extends readonly WorkflowDeclaration[] = readonly [],
  const TName extends string = string,
>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile, H, TStrict, TChildren, TName>,
): WorkflowDefinition<TInput, TOutput, TProfile, H, TStrict, TChildren, TName> {
  if (!definition.name.trim() || !definition.version.trim()) {
    throw new Error('Workflow name and version must be nonempty.');
  }
  return definition;
}

/** Execution limits reported by an adapter or resolved for an attempt. Never step identity. */
export interface ExecutionPolicy {
  /** Retained parser state and single-line cap; defaults to 8 MiB for CliHarness. */
  readonly maxRetainedBytes?: number;
  /** Combined raw stdout/stderr safety cap; defaults to 1 GiB for CliHarness. */
  readonly maxStreamBytes?: number;
  /** Per-attempt transcript file cap, including its truncation marker; defaults to 64 MiB. */
  readonly maxTranscriptBytes?: number;
  /** Transcript retention; defaults to on. */
  readonly transcripts?: TranscriptMode;
  /** Wall-clock deadline enforced by the harness. */
  readonly timeoutMs?: number;
  /** Output idle deadline enforced by the harness; absent when off. */
  readonly idleTimeoutMs?: number;
  /** Claude turn limit. */
  readonly maxTurns?: number;
  /** Claude per-call spend limit. */
  readonly maxBudgetUsd?: number;
  /** Runtime retry policy; repeated effects remain at least once. */
  readonly retry?: RetryPolicy;
  /** Legacy alias for agent maxRetainedBytes; command capture keeps its per-stream meaning. */
  readonly maxOutputBytes?: number;
  /** Adapter's termination grace period. */
  readonly killGraceMs?: number;
  /** Adapter executable name or path, when known. */
  readonly binary?: string;
}

/** A run-level policy rule. Later matching rules win, field by field. */
export interface PolicyOverride {
  /** Agent parser state and single-line cap, independent of the whole trace. */
  readonly maxRetainedBytes?: number;
  /** Agent raw stdout/stderr safety cap. */
  readonly maxStreamBytes?: number;
  /** Agent transcript file cap, including its truncation marker. */
  readonly maxTranscriptBytes?: number;
  /** Agent transcript retention. */
  readonly transcripts?: TranscriptMode;
  /** Step-ID glob: * stays within a segment; ** crosses slashes. Omission matches all IDs. */
  readonly match?: string;
  /** Limit the rule to an effect category. Sleep does not accept policy overrides. */
  readonly kind?: string;
  /** Output cap: per stream for exec; legacy maxRetainedBytes alias for agents. */
  readonly maxOutputBytes?: number;
  /** Harness wall-clock deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Agent output idle deadline in milliseconds; agent rules only. */
  readonly idleTimeoutMs?: number;
  /** Claude turn limit. */
  readonly maxTurns?: number;
  /** Claude spend limit in USD. */
  readonly maxBudgetUsd?: number;
  /** Retry only effects safe to repeat. */
  readonly retry?: RetryPolicy;
  /** Explicitly authorized model replacement for unfinished calls only. */
  readonly model?: string;
  /**
   * Explicitly authorized Codex effort replacement for unfinished calls only. Codex-only: a rule
   * that sets it never changes a Claude call's effort, and a claude-scoped rule cannot set it.
   */
  readonly effort?: CodexOptions['effort'];
}

/** Fully resolved runtime retry policy plus adapter-declared limits and their provenance. */
export interface AttemptPolicy {
  /** Requested selections, explicitly marking harness-inherited choices. Absent in older records. */
  readonly requested?: {
    /** Model name, or inherited. */
    readonly model: string;
    /** Effort level, or inherited. */
    readonly effort: string;
  };
  /** Resolved role name for agent attempts; outside semantic identity. */
  readonly profile?: string;
  /** Limits used for this attempt; custom adapters may leave unknown defaults absent. */
  readonly policy: ExecutionPolicy & {
    /** Runtime retry values after filling in maxAttempts and delayMs. */
    readonly retry: RetryPolicy & Required<Pick<RetryPolicy, 'maxAttempts' | 'delayMs'>>;
  };
  /** Value origins: runtime, harness, call-site, or override:N (zero-based saved rule index). */
  readonly sources: Readonly<Record<string, string>>;
  /** Explicit model sent to the harness; null means its own configuration chooses. */
  readonly requestedModel: string | null;
  /**
   * Explicit effort sent to Codex (call site, profile or override); null for Claude calls and when
   * Codex's own configuration chooses. Records written before #341 stored it as reasoningEffort.
   */
  readonly effort: CodexOptions['effort'] | null;
}

/** Scheduling, item identity and failure policy for a named map. */
export interface MapOptions<T> {
  /** Positive local mapper bound; RunOptions.agentLimit separately caps live agents across the run. */
  readonly concurrency: number;
  /** Explicit stable item key; defaults to its index. Keys must be valid IDs and unique in this call. */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /**
   * `'throw'` (the default) rejects with FanOutError after a mapper failure; `'return'` journals
   * every item outcome and returns `Settled<U, MapStepError>[]`. Scheduling policy, outside the map
   * journal's fingerprint.
   */
  readonly onError?: 'throw' | 'return' | undefined;
  /**
   * Cancel this map's own subtree after the first item failure instead of draining started mappers
   * (the default). Scheduling policy, outside the map journal's fingerprint.
   */
  readonly cancelSiblings?: boolean | undefined;
  /** With `onError: 'return'`, a revision for dependencies not shown by items, keys or mapper source. */
  readonly version?: string | undefined;
}

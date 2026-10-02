import type { AgentRequest } from './harness-model.js';
import type {
  HarnessDeclaration,
  HarnessMap,
  BuiltInHarnesses,
  WorkflowHarnesses,
  RegisteredAgentClient,
  OptionsOf,
  CapabilitiesOf,
} from './harness-model.js';
import type { ClaudeOptions } from '../../harnesses/builtins/claude-options.js';
import type { CodexOptions } from '../../harnesses/builtins/codex-options.js';
export type { ClaudeOptions } from '../../harnesses/builtins/claude-options.js';
export type { CodexOptions } from '../../harnesses/builtins/codex-options.js';
import type { AgentEnvironment, HostEnvironmentSummary } from './agent-environment-model.js';
import type { AgentDiagnostics, AgentProgress, TranscriptMode } from './agent-stream-model.js';
import type { AgentIsolation, AgentWorktree } from './agent-isolation.js';
import type { MergeOptions, MergeResult } from './worktree-model.js';
import type { WorktreeChange, WorktreeHandle, WorktreeCreateOptions } from './worktree-model.js';
import type {
  ReadFileOptions,
  ReadFileResult,
  WriteFileOptions,
  WriteFileResult,
} from './file-model.js';
import type { ExecFunction } from './exec-model.js';
import type { AskOptions, ApproveOptions, Approval } from './question-model.js';
import type {
  WaitSources,
  WaitOutcome,
  PollOptions,
  PollOutcome,
  DeadlineOutcome,
} from './wait-model.js';
import type { PhaseOptions } from './observability-model.js';
import type { z } from 'zod';
import type { AgentDefaults, AgentProfile, BuiltinProfile } from './profiles-model.js';
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
 * `overloaded` is a provider-side failure (HTTP 500/502/503/529).
 */
export type ErrorKind =
  | 'timeout'
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
  /** Native configuration loading, default restricted; also accepts the original worktree shorthand. */
  readonly isolation?: AgentIsolation | undefined;
  /** Select a managed checkout independently from native configuration loading. */
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
   * Retry only these categories; `'transient'` stands for `rate-limit`, `overloaded` and
   * `timeout`. Omission retries every non-fatal failure except `invalid-request`; [] retries none.
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

/** Durable operations available to ordinary TypeScript workflow code. */
export interface WorkflowContext<
  TProfile extends string = string,
  R extends HarnessMap = BuiltInHarnesses,
> {
  /** Select one explicitly registered harness; capabilities determine structured-output availability. */
  agent<K extends keyof R & string>(
    name: K,
  ): RegisteredAgentClient<OptionsOf<R[K]>, CapabilitiesOf<R[K]>>;
  /** Run a typed child inline with validated I/O, recorded identity, and a scoped effect namespace. */
  workflow<I, O, P extends string, H extends readonly HarnessDeclaration[]>(
    id: string,
    child: WorkflowDefinition<I, O, P, H>,
    input: NoInfer<I>,
    options?: ChildOptions,
  ): Promise<O>;
  /** Dispatch only among the current workflow's declared children; validate input and return JSON. */
  workflow(
    id: string,
    childName: string,
    input: JsonValue,
    options?: ChildOptions,
  ): Promise<JsonValue>;
  /** Integrate pinned changes in input order; only target checkout modifies the source working tree. */
  merge(
    id: string,
    changes: readonly (WorktreeChange | WorktreeHandle)[],
    options?: MergeOptions,
  ): Promise<MergeResult>;
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
  /** Poll changing state with a pinned finite deadline and one bounded progress record. */
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
  within(prefix: string): WorkflowContext<TProfile, R>;
  /** Claude-specific headless API. */
  readonly claude: AgentClient<
    Omit<ClaudeOptions, 'profile'> & {
      /** Built-in preset or one of this workflow's declared role names. */
      readonly profile?: BuiltinProfile | TProfile | undefined;
    }
  >;
  /** Codex-specific headless API. */
  readonly codex: AgentClient<
    Omit<CodexOptions, 'profile'> & {
      /** Built-in preset or one of this workflow's declared role names. */
      readonly profile?: BuiltinProfile | TProfile | undefined;
    }
  >;
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
  /** Scope each item as id/key (index by default); validate all keys before starting any mapper. */
  map<T, U>(
    id: string,
    items: readonly T[],
    options: MapOptions<T>,
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<U[]>;
  /** Journal whole item outcomes under the named map ID, including mapper-body failures. */
  map<T, U>(
    id: string,
    items: readonly T[],
    options: SettledNamedMapOptions<T>,
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<Settled<U, MapStepError>[]>;
  /**
   * Bounded fan-out in input order. Default drain stops scheduling after failure and lets started
   * mappers finish without aborting them. Explicit abort cancels only this map's subtree. Both
   * reject with FanOutError after draining; an escaping failure is attributed in RunRecord.rootCause.
   * Supply unique effect IDs inside mappers.
   * @deprecated Use the named map overload for per-item prefixes. This form keeps legacy IDs.
   */
  map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
    options?: { readonly onError?: 'abort' | 'drain' },
  ): Promise<U[]>;
  /**
   * Journal every item outcome under an explicit map ID; replay skips settled mappers and their owned
   * effects. Inputs/results must be lossless JSON. Cancellation, infrastructure, and authoring errors
   * still reject. Failed outcomes include their originating step ID, or null for mapper-body errors.
   * @deprecated Use the named settled map overload. This form keeps legacy IDs and journals.
   */
  map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
    options: SettledMapOptions,
  ): Promise<Settled<U, MapStepError>[]>;
}

/** Definition of a typed workflow; plain JavaScript controls branching, loops, and composition. */
export interface WorkflowDefinition<
  TInput,
  TOutput,
  TProfile extends string = string,
  H extends readonly HarnessDeclaration[] = readonly HarnessDeclaration[],
> {
  /** Explicit agent registrations; Claude and Codex remain implicitly available. */
  readonly harnesses?: H;
  /** Human purpose, outside runtime replay identity. */
  readonly description?: string;
  /** Guidance for choosing this workflow, outside runtime replay identity. */
  readonly whenToUse?: string;
  /** Expected stages; these descriptions do not emit progress events. */
  readonly phases?: readonly WorkflowPhase[];
  /** Inline children available for discovery and name-based dispatch. */
  readonly children?: readonly WorkflowDeclaration[];
  /** Common defaults applied after the selected preset. */
  readonly defaults?: AgentDefaults<NoInfer<TProfile>>;
  /** Named capability roles, resolved before executing the workflow body. */
  readonly profiles?: Readonly<Record<TProfile, AgentProfile>>;
  /** Prohibit raw tools/allowedTools/sandbox at call sites; defaults to true. */
  readonly strictProfiles?: boolean;
  /** Stable workflow name, checked on resume. */
  readonly name: string;
  /** Explicit compatibility version; bump whenever code or dependencies change semantics. */
  readonly version: string;
  /** Input validator and source of the inferred input type. */
  readonly input: z.ZodType<TInput>;
  /** Output validator and source of the inferred output type. */
  readonly output: z.ZodType<TOutput>;
  /** Workflow body. It replays from the beginning when resuming. */
  readonly run: NoInfer<
    (
      context: WorkflowContext<NoInfer<TProfile>, WorkflowHarnesses<NoInfer<H>>>,
      input: TInput,
    ) => Promise<TOutput>
  >;
}

/** Define a workflow with input/output types inferred from its runtime schemas. */
export function defineWorkflow<
  TInput,
  TOutput,
  TProfile extends string = never,
  const H extends readonly HarnessDeclaration[] = readonly [],
>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile, H>,
): WorkflowDefinition<TInput, TOutput, TProfile, H> {
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
  /** Claude turn limit. */
  readonly maxTurns?: number;
  /** Claude spend limit in USD. */
  readonly maxBudgetUsd?: number;
  /** Retry only effects safe to repeat. */
  readonly retry?: RetryPolicy;
  /** Explicitly authorized model replacement for unfinished calls only. */
  readonly model?: string;
  /** Explicitly authorized Codex effort replacement for unfinished calls only. */
  readonly reasoningEffort?: CodexOptions['reasoningEffort'];
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
  /** Explicit effort sent to Codex; null means its own configuration chooses. */
  readonly reasoningEffort: CodexOptions['reasoningEffort'] | null;
}

/** Stable identity and policy for a durable settled map. */
export interface SettledMapOptions {
  /** Run-unique map journal ID. This does not prefix effect IDs. */
  readonly id: string;
  /** Journal successes and failures for every item without cancelling siblings. */
  readonly onError: 'settle';
  /** Revision for captured values or helpers not visible in mapper source and items. */
  readonly version?: string;
}

/** Scheduling and item identity for a named map. */
export interface MapOptions<T> {
  /** Positive local mapper bound; RunOptions.agentLimit separately caps live agents across the run. */
  readonly concurrency: number;
  /** Explicit stable item key; defaults to its index. Keys must be valid IDs and unique in this call. */
  readonly key?: (item: T, index: number) => string;
  /** Default drain lets started work finish; abort cancels only this subtree. */
  readonly onError?: 'drain' | 'abort';
}

/** Named map with durable aggregate decisions. */
export interface SettledNamedMapOptions<T> extends Omit<MapOptions<T>, 'onError'> {
  /** Persist each entire mapper outcome; cancellation/infrastructure/authoring errors still reject. */
  readonly onError: 'settle';
  /** Revision for dependencies not represented by item data, keys, or mapper source. */
  readonly version?: string;
}

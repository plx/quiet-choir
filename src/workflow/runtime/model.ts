import type { z } from 'zod';
import type { AgentDefaults, AgentProfile, BuiltinProfile } from './profiles-model.js';
import type { MapStepError } from './fan-out.js';

/** A value that survives checkpoint serialization without changing its meaning. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Stable categories used by settled outcomes and selective retry. */
export type ErrorKind =
  | 'timeout'
  | 'rate-limit'
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

/** Return type selected by an effect's error mode. */
export type EffectResult<T, TMode extends ErrorMode> = TMode extends 'return' ? Settled<T> : T;

/** Effort levels supported by both harnesses; model support can differ. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Native harness installation captured for diagnostics, outside semantic identity. */
export interface HarnessMetadata {
  /** Executable selected by the adapter. */
  readonly binary: string;
  /** Version string, or null if version discovery failed. */
  readonly version: string | null;
  /** Nonfatal discovery diagnostics. */
  readonly warnings?: readonly string[];
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
  /** Shared reasoning effort; cannot accompany Codex reasoningEffort. */
  readonly effort?: Effort;
  /** Additional tool directories; Codex treats these as writable roots. */
  readonly addDirs?: readonly string[];
  /** Fingerprinted escape hatch; use --flag=value for values, never reserved/typed flags. */
  readonly extraArgs?: readonly string[];
  /** Fingerprinted environment overlay. Keep rotating secrets in the parent environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Declared role or built-in preset; omission uses workflow defaults. */
  readonly profile?: string;
  /** Persist a terminal outcome for branching; cancellation, configuration (e.g. missing harness), and checkpoint-write failures still reject. */
  readonly onError?: ErrorMode;
  /** Instructions sent over stdin, never interpolated into a shell command. */
  readonly prompt: string;
  /** Model name or harness alias; omission uses the harness default. */
  readonly model?: string;
  /** Working directory, relative to the workflow run's working directory. */
  readonly cwd?: string;
  /** Wall-clock deadline in milliseconds; implicit text profile: 300,000. Custom harnesses must enforce it. */
  readonly timeoutMs?: number;
  /** Explicit runtime retries for calls safe to repeat; not part of replay identity. */
  readonly retry?: RetryPolicy;
}

/** Claude-specific controls. CliHarness denies unapproved tools by default. */
export interface ClaudeOptions extends AgentOptions {
  /** Explicit deny rules such as Bash(git push:*). */
  readonly disallowedTools?: readonly string[];
  /** Permission mode; bypass and interactive modes remain unsupported. */
  readonly permissionMode?: 'dontAsk' | 'acceptEdits' | 'plan';
  /** Replace the system prompt via a private temporary file. */
  readonly systemPrompt?: string;
  /** Append stable role instructions via a private temporary file. */
  readonly appendSystemPrompt?: string;
  /** Select a native agent definition. */
  readonly agent?: string;
  /** Native subagent definitions, passed through a private JSON file. */
  readonly agents?: Readonly<
    Record<
      string,
      {
        /** When the native agent should be used. */
        readonly description: string;
        /** Agent role instructions. */
        readonly prompt: string;
        /** Additional native subagent fields; bypass modes are rejected. */
        readonly [key: string]: JsonValue;
      }
    >
  >;
  /** Explicit MCP servers, written to a private configuration file. */
  readonly mcpServers?: Readonly<Record<string, JsonValue>>;
  /** Ignore other MCP configuration sources. */
  readonly strictMcpConfig?: boolean;
  /** Extra native settings; typed model/agent/permission controls cannot be duplicated here. */
  readonly settings?: Readonly<Record<string, JsonValue>>;
  /** Fallback model or ordered models; semantic identity, not a policy override. */
  readonly fallbackModel?: string | readonly string[];
  /** Built-in tools to expose; use a workflow profile under default strictProfiles. Default: none. */
  readonly tools?: readonly string[];
  /** Narrower tool permissions; omission pre-approves the exposed tools. */
  readonly allowedTools?: readonly string[];
  /** Maximum agent turns; implicit text profile: 10. */
  readonly maxTurns?: number;
  /** Per-call USD limit enforced by Claude; implicit text profile: 0.50. */
  readonly maxBudgetUsd?: number;
}

/** Codex-specific controls. CliHarness defaults to read-only sandbox and never approving. */
export interface CodexOptions extends AgentOptions {
  /** Network access for workspace-write; requires that sandbox explicitly. */
  readonly networkAccess?: boolean;
  /** Native Codex configuration profile; profile itself selects the quiet-choir role. */
  readonly harnessProfile?: string;
  /** Dotted native config keys with JSON-to-TOML values; owned settings and null are rejected. */
  readonly config?: Readonly<Record<string, JsonValue>>;
  /** Local images; the runtime fingerprints and snapshots file contents, not paths. */
  readonly images?: readonly string[];
  /** Structured-output encoding; compat translates common Zod shapes, strict requires a native Codex schema. CliHarness default: compat; the core supplies no default. */
  readonly structuredOutput?: 'strict' | 'compat';
  /** Filesystem sandbox; declare in a workflow profile under default strictProfiles. Default: read-only. */
  readonly sandbox?: 'read-only' | 'workspace-write';
  /** Harness reasoning effort. */
  readonly reasoningEffort?: 'none' | 'minimal' | Effort;
  /** Allow use outside a Git repository. */
  readonly skipGitRepoCheck?: boolean;
}

/** Plain-data request passed from the engine to a harness adapter. */
export type HarnessRequest = (
  | {
      /** Claude Code integration. */
      readonly provider: 'claude';
      /** Claude-specific invocation options. */
      readonly options: ClaudeOptions;
    }
  | {
      /** Codex integration. */
      readonly provider: 'codex';
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

/** Usage reported by the harness, with null for unavailable measurements. */
export interface AgentUsage {
  /** Uncached and/or total input tokens as reported by the harness. */
  readonly inputTokens: number | null;
  /** Generated output tokens. */
  readonly outputTokens: number | null;
  /** Estimated USD cost, when the harness reports it. */
  readonly costUsd: number | null;
}

/** Normalized response from a headless harness. */
export interface HarnessResponse {
  /** Final text, or serialized structured output. */
  readonly text: string;
  /** Native session/thread identifier for diagnostics; not a workflow resume token. */
  readonly sessionId: string | null;
  /** Usage metadata for this invocation. */
  readonly usage: AgentUsage;
  /** Recoverable protocol notices, persisted as diagnostics outside the result fingerprint. */
  readonly warnings?: readonly string[];
  /** Count of denied tool requests reported by the terminal envelope. */
  readonly permissionDenials?: number;
  /** Reported agent turns, when available. */
  readonly turns?: number;
}

/** Replaceable integration port, also useful for deterministic tests. */
export interface Harness {
  /**
   * Discover the native binary/version on first live use in each run invocation. Discovery is
   * shared by the run: `signal` aborts on interruption or once no effect still awaits the result.
   */
  metadata?(request: HarnessRequest, signal: AbortSignal): Promise<HarnessMetadata>;
  /** Report effective adapter limits for attempt records. Omit unknown defaults; never perform effects here. */
  policyDefaults?(provider: HarnessRequest['provider']): ExecutionPolicy;
  /** Invoke one fresh session; enforce your own limits, settle on abort, and reject process/protocol failure. */
  invoke(request: HarnessRequest, signal: AbortSignal): Promise<HarnessResponse>;
}

/** Typed and validated agent output, saved together with harness metadata. */
export interface AgentResult<T> {
  /** Validated output, inferred from the schema for object calls. */
  readonly output: T;
  /** Native harness session identifier. */
  readonly sessionId: string | null;
  /** Harness-reported usage. */
  readonly usage: AgentUsage;
}

/** Dedicated typed API for a harness, with durable calls keyed by unique step IDs. */
export interface AgentClient<TOptions extends AgentOptions> {
  /** Invoke the harness for a plain text response. */
  text<TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly onError?: TMode },
  ): Promise<EffectResult<AgentResult<string>, TMode>>;
  /** Request structured output and validate it locally before checkpointing. */
  object<T>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
  ): Promise<Settled<AgentResult<T>>>;
  /** Request structured output with an inferred or dynamic error mode. */
  object<T, TMode extends ErrorMode = 'throw'>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode },
  ): Promise<EffectResult<AgentResult<T>, TMode>>;
}

/** Retry policy explicitly opted into for an effect that is safe to repeat. */
export interface RetryPolicy {
  /** Maximum total attempts during this execution; defaults to one. */
  readonly maxAttempts: number;
  /** Initial delay in milliseconds, doubled on each retry; defaults to 100. */
  readonly delayMs?: number;
  /** Retry only these categories; omission retries all non-cancellation effect failures, [] retries none. */
  readonly on?: readonly ErrorKind[];
}

/** Context supplied to a local effect. */
export interface StepContext {
  /** Cooperative cancellation signal; effects should pass it to cancellable operations. */
  readonly signal: AbortSignal;
  /** Stable run/step key for deduplicating external side effects. */
  readonly idempotencyKey: string;
  /** Total persisted attempt number, including previous resumes. */
  readonly attempt: number;
}

/** A local durable effect. Keep nondeterminism and side effects inside its callback. */
export interface StepDefinition<T> {
  /** Persist and return final failures as Settled<T>; cancellation still rejects. */
  readonly onError?: ErrorMode;
  /** Explicit revision for captured values, helpers, or environment not visible in callback source. */
  readonly version?: string;
  /** Explicit JSON-serializable dependencies, checked for drift on replay. */
  readonly input: JsonValue;
  /** Runtime validator for the result, also applied on replay. */
  readonly schema: z.ZodType<T>;
  /** Optional retry policy; there are no automatic retries by default. */
  readonly retry?: RetryPolicy;
  /** Perform the effect. Do not nest workflow steps inside this callback. */
  readonly run: (context: StepContext) => Promise<T> | T;
}

/** Durable operations available to ordinary TypeScript workflow code. */
export interface WorkflowContext<TProfile extends string = string> {
  /** Stable identifier for this execution and all resumes. */
  readonly runId: string;
  /** Current cancellation scope signal; nested maps inherit the run signal. */
  readonly signal: AbortSignal;
  /** Pure stable segments from arbitrary text/numbers; identical to exported stepId. */
  id(...parts: readonly (string | number)[]): string;
  /** Prefix every effect launched in the callback; nested scopes compose without counters. */
  scope<T>(prefix: string, run: () => Promise<T>): Promise<T>;
  /** Bind a lexical prefix to a reusable context; descendants retain their nested scope prefixes. */
  within(prefix: string): WorkflowContext<TProfile>;
  /** Claude-specific headless API. */
  readonly claude: AgentClient<
    Omit<ClaudeOptions, 'profile'> & {
      /** Built-in preset or one of this workflow's declared role names. */
      readonly profile?: BuiltinProfile | TProfile;
    }
  >;
  /** Codex-specific headless API. */
  readonly codex: AgentClient<
    Omit<CodexOptions, 'profile'> & {
      /** Built-in preset or one of this workflow's declared role names. */
      readonly profile?: BuiltinProfile | TProfile;
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
    definition: StepDefinition<T> & { readonly onError?: TMode },
  ): Promise<EffectResult<T, TMode>>;
  /** Checkpoint a wall-clock wake time so resuming waits only the remaining duration. */
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
export interface WorkflowDefinition<TInput, TOutput, TProfile extends string = string> {
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
  readonly run: (context: WorkflowContext<NoInfer<TProfile>>, input: TInput) => Promise<TOutput>;
}

/** Define a workflow with input/output types inferred from its runtime schemas. */
export function defineWorkflow<TInput, TOutput, TProfile extends string = never>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile>,
): WorkflowDefinition<TInput, TOutput, TProfile> {
  if (!definition.name.trim() || !definition.version.trim()) {
    throw new Error('Workflow name and version must be nonempty.');
  }
  return definition;
}

/** Execution limits reported by an adapter or resolved for an attempt. Never step identity. */
export interface ExecutionPolicy {
  /** Wall-clock deadline enforced by the harness. */
  readonly timeoutMs?: number;
  /** Claude turn limit. */
  readonly maxTurns?: number;
  /** Claude per-call spend limit. */
  readonly maxBudgetUsd?: number;
  /** Runtime retry policy; repeated effects remain at least once. */
  readonly retry?: RetryPolicy;
  /** Adapter's combined stdout/stderr cap. */
  readonly maxOutputBytes?: number;
  /** Adapter's termination grace period. */
  readonly killGraceMs?: number;
  /** Adapter executable name or path, when known. */
  readonly binary?: string;
}

/** A run-level policy rule. Later matching rules win, field by field. */
export interface PolicyOverride {
  /** Step-ID glob: * stays within a segment; ** crosses slashes. Omission matches all IDs. */
  readonly match?: string;
  /** Limit the rule to an effect category. Sleep does not accept policy overrides. */
  readonly kind?: 'claude' | 'codex' | 'step';
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
  /** Maximum active mappers in this map; must be a positive integer. */
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

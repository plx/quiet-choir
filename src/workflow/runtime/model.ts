import type { z } from 'zod';

/** A value that survives checkpoint serialization without changing its meaning. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Options shared by headless agent calls. */
export interface AgentOptions {
  /** Instructions sent over stdin, never interpolated into a shell command. */
  readonly prompt: string;
  /** Model name or harness alias; omission uses the harness default. */
  readonly model?: string;
  /** Working directory, relative to the workflow run's working directory. */
  readonly cwd?: string;
  /** Wall-clock deadline in milliseconds. CliHarness default: 900,000; custom harnesses must enforce their own deadline. */
  readonly timeoutMs?: number;
  /** Explicit runtime retries for calls safe to repeat; not part of replay identity. */
  readonly retry?: RetryPolicy;
}

/** Claude-specific controls. CliHarness denies unapproved tools by default. */
export interface ClaudeOptions extends AgentOptions {
  /** Built-in tools to expose. CliHarness default: none; the core supplies no default. */
  readonly tools?: readonly string[];
  /** Explicit tool permissions for this invocation. */
  readonly allowedTools?: readonly string[];
  /** Maximum agent turns. CliHarness default: 25; the core supplies no default. */
  readonly maxTurns?: number;
  /** Per-call USD limit. CliHarness default: 0.25, enforced by Claude; the core supplies no default. */
  readonly maxBudgetUsd?: number;
}

/** Codex-specific controls. CliHarness defaults to read-only sandbox and never approving. */
export interface CodexOptions extends AgentOptions {
  /** Structured-output encoding; compat translates common Zod shapes, strict requires a native Codex schema. CliHarness default: compat; the core supplies no default. */
  readonly structuredOutput?: 'strict' | 'compat';
  /** Filesystem sandbox for model-generated commands. CliHarness default: read-only; the core supplies no default. */
  readonly sandbox?: 'read-only' | 'workspace-write';
  /** Harness reasoning effort. */
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
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
}

/** Replaceable integration port, also useful for deterministic tests. */
export interface Harness {
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
  text(id: string, options: TOptions): Promise<AgentResult<string>>;
  /** Request structured output and validate it locally before checkpointing. */
  object<T>(
    id: string,
    options: TOptions & { readonly schema: z.ZodType<T> },
  ): Promise<AgentResult<T>>;
}

/** Retry policy explicitly opted into for an effect that is safe to repeat. */
export interface RetryPolicy {
  /** Maximum total attempts during this execution; defaults to one. */
  readonly maxAttempts: number;
  /** Initial delay in milliseconds, doubled on each retry; defaults to 100. */
  readonly delayMs?: number;
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
export interface WorkflowContext {
  /** Stable identifier for this execution and all resumes. */
  readonly runId: string;
  /** Run cancellation signal. */
  readonly signal: AbortSignal;
  /** Claude-specific headless API. */
  readonly claude: AgentClient<ClaudeOptions>;
  /** Codex-specific headless API. */
  readonly codex: AgentClient<CodexOptions>;
  /** Save a JSON result and reuse it on resume when its inputs match. */
  step<T>(id: string, definition: StepDefinition<T>): Promise<T>;
  /** Checkpoint a wall-clock wake time so resuming waits only the remaining duration. */
  sleep(id: string, milliseconds: number): Promise<null>;
  /** Map in input order with bounded concurrency and unique step IDs. A mapper failure cancels the run and drains active workers. */
  map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<U[]>;
}

/** Definition of a typed workflow; plain JavaScript controls branching, loops, and composition. */
export interface WorkflowDefinition<TInput, TOutput> {
  /** Stable workflow name, checked on resume. */
  readonly name: string;
  /** Explicit compatibility version; bump whenever code or dependencies change semantics. */
  readonly version: string;
  /** Input validator and source of the inferred input type. */
  readonly input: z.ZodType<TInput>;
  /** Output validator and source of the inferred output type. */
  readonly output: z.ZodType<TOutput>;
  /** Workflow body. It replays from the beginning when resuming. */
  readonly run: (context: WorkflowContext, input: TInput) => Promise<TOutput>;
}

/** Define a workflow with input/output types inferred from its runtime schemas. */
export function defineWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
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
  /** Limits used for this attempt; custom adapters may leave unknown defaults absent. */
  readonly policy: ExecutionPolicy & {
    /** Runtime retry values after filling in maxAttempts and delayMs. */
    readonly retry: Required<RetryPolicy>;
  };
  /** Value origins: runtime, harness, call-site, or override:N (zero-based saved rule index). */
  readonly sources: Readonly<Record<string, string>>;
  /** Explicit model sent to the harness; null means its own configuration chooses. */
  readonly requestedModel: string | null;
  /** Explicit effort sent to Codex; null means its own configuration chooses. */
  readonly reasoningEffort: CodexOptions['reasoningEffort'] | null;
}

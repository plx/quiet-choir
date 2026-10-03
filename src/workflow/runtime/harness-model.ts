import type { z } from 'zod';
import type {
  AgentClient,
  AgentOptions,
  AgentResult,
  ClaudeOptions,
  CodexOptions,
  EffectResult,
  ErrorMode,
  ExecutionPolicy,
  HarnessCall,
  HarnessInvocation,
  HarnessMetadata,
  HarnessResponse,
  ImageAttachment,
  JsonValue,
} from './model.js';
import type { AccessClass, BuiltinProfile } from './profiles-model.js';
import type { AgentIsolation } from './agent-isolation.js';
import type {
  claudeCapabilityKeys,
  codexCapabilityKeys,
} from '../../harnesses/builtins/capability-keys.js';

/** Public features advertised by one named agent harness. */
export interface HarnessCapabilities {
  /** Whether structured responses are native, prompted, or unsupported. */
  readonly structuredOutput: 'native' | 'prompted' | 'none';
  /** Supported effort values, for discovery rather than automatic option translation. */
  readonly effort?: readonly string[];
  /** Whether the adapter supports an explicit filesystem sandbox. */
  readonly sandbox?: boolean;
  /** Informational native-session support; the runtime still starts fresh attempts. */
  readonly sessionResume?: boolean;
}

/** Validated agent input with durable attempt identity, independent of a model provider. */
export interface AgentRequest<O extends AgentOptions = AgentOptions> {
  /** Registered harness name; an option named provider may separately identify its model service. */
  readonly harness: string;
  /** Definition revision whose option semantics this attempt uses. */
  readonly revision: number;
  /** Validated author options with resolved workflow policy; adapters own native defaults. */
  readonly options: O;
  /** Absolute execution directory, including any runtime-owned worktree. */
  readonly cwd: string;
  /** Structured response contract, or null for a text response. */
  readonly outputSchema: JsonValue | null;
  /** Owning durable run. */
  readonly runId: string;
  /** Fully qualified effect ID. */
  readonly stepId: string;
  /** One-based cumulative attempt number. */
  readonly attempt: number;
  /** Stable external deduplication key across retries and resumes. */
  readonly idempotencyKey: string;
  /** Compatibility view of the same attempt identity. */
  readonly call: HarnessCall;
  /** Immutable bytes captured by the runtime for built-in image inputs. */
  readonly imageAttachments?: readonly ImageAttachment[];
}

/** One registered adapter; the runtime owns durability, validation and invocation admission. */
export interface HarnessAdapter<O extends AgentOptions = AgentOptions> {
  /** Execution provenance, outside semantic identity. */
  readonly kind?: string;
  /** Pure effective limits; constructors and defaults must not launch agent work. */
  policyDefaults?(): ExecutionPolicy;
  /** Optional installation discovery on first live use, outside replay identity. */
  metadata?(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<HarnessMetadata>;
  /** Honor abort and reject native/protocol failures; runtime calls always supply ownership hooks. */
  invoke(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<HarnessResponse>;
}

/** Zero-inference installation information returned by a package probe. */
export interface HarnessProbe {
  /** Observed version string, or null when unavailable. */
  readonly version: string | null;
}

/**
 * A package's typed option contract and adapter factory, registered explicitly by workflows. `K` is
 * the literal tuple of `capabilityKeys`, which `defineHarness` infers so strict call sites can omit
 * those keys; a widened list keeps call-site types permissive and leaves the check to the runtime.
 */
export interface HarnessDefinition<
  N extends string,
  O extends AgentOptions,
  C extends HarnessCapabilities,
  K extends readonly (keyof O & string)[] = readonly (keyof O & string)[],
> {
  /** Persisted lowercase name, matching /^[a-z][a-z0-9-]{0,31}$/. */
  readonly name: N;
  /** Positive revision; bump when existing recorded options change meaning. */
  readonly revision: number;
  /** Object schema; defineHarness makes its top-level unknown-key handling strict. */
  readonly options: z.ZodType<O>;
  /** Discoverable features and structured-client availability. */
  readonly capabilities: C;
  /** Option keys treated as execution policy rather than replay identity. */
  readonly policy?: readonly (keyof O & string)[];
  /**
   * Capability controls that strict profiles own; adapters remain responsible for enforcing them.
   * Under `strictProfiles` the workflow's `ctx.agent(name)` option type omits a literal list's keys.
   */
  readonly capabilityKeys?: K;
  /** Pure access classification of partial profile or resolved call options; omission conservatively requires exec access. */
  readonly access?: (options: Partial<O>) => AccessClass;
  /** Construct an adapter from operator configuration, outside effect identity. */
  readonly createAdapter?: (config: JsonValue) => HarnessAdapter<O>;
  /** Zero-inference installation probe; the CLI passes its cancellation signal when available. */
  readonly probe?: (config: JsonValue, signal?: AbortSignal) => Promise<HarnessProbe>;
}

/** Erased registration contract; individual definitions retain their precise option and feature types. */
export interface HarnessDeclaration {
  /** Persisted harness name. */
  readonly name: string;
  /** Version of the option semantics. */
  readonly revision: number;
  /** Runtime option validator. */
  readonly options: z.ZodType<AgentOptions>;
  /** Advertised features. */
  readonly capabilities: HarnessCapabilities;
  /** Non-semantic option keys. */
  readonly policy?: readonly string[];
  /** Profile-owned capability option keys. */
  readonly capabilityKeys?: readonly string[];
  /** Pure access classifier; receives validated partial profile or concrete call options. */
  readonly access?: (options: never) => AccessClass;
  /** Type-erased factory; callers recover its options from the registration schema. */
  readonly createAdapter?: (config: JsonValue) => HarnessAdapter<never>;
  /** Optional zero-inference installation discovery. */
  readonly probe?: (config: JsonValue, signal?: AbortSignal) => Promise<HarnessProbe>;
}

/** Value-level registry used by the typed context; no global declaration merging. */
export type HarnessMap = Readonly<Record<string, HarnessDeclaration>>;

/** Shared native structured-output contract of the two built-in clients. */
export interface NativeHarnessCapabilities extends HarnessCapabilities {
  /** Structured output is provided by the native harness protocol. */
  readonly structuredOutput: 'native';
}

/** The two implicit clients available in every workflow. */
// A type alias retains a closed key set while satisfying the registry index constraint.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type BuiltInHarnesses = {
  /** Claude Code option and response contract. */
  readonly claude: HarnessDefinition<
    'claude',
    ClaudeOptions,
    NativeHarnessCapabilities,
    typeof claudeCapabilityKeys
  >;
  /** Codex option and response contract. */
  readonly codex: HarnessDefinition<
    'codex',
    CodexOptions,
    NativeHarnessCapabilities,
    typeof codexCapabilityKeys
  >;
};

/** Built-ins plus the literal registrations supplied to defineWorkflow. */
export type WorkflowHarnesses<H extends readonly HarnessDeclaration[]> = BuiltInHarnesses & {
  readonly [D in H[number] as D['name']]: D;
};

/** Options inferred from a harness package's runtime schema. */
export type OptionsOf<D> = D extends {
  /** Runtime option schema. */ readonly options: z.ZodType<infer O extends AgentOptions>;
}
  ? O
  : never;

/** Feature contract inferred from a registration. */
export type CapabilitiesOf<D> = D extends {
  /** Registered feature contract. */
  readonly capabilities: infer C extends HarnessCapabilities;
}
  ? C
  : never;

/**
 * The literal `capabilityKeys` of a registration, as a union. A registration without the field, or
 * with a widened `string[]` list (such as an erased {@link HarnessDeclaration}), yields `never`, so
 * its call sites stay permissive at type level and the runtime strict check remains the backstop.
 */
export type CapabilityKeysOf<D> = D extends {
  /** Profile-owned capability option keys. */
  readonly capabilityKeys?: infer K;
}
  ? Exclude<K, undefined> extends infer T extends readonly string[]
    ? number extends T['length']
      ? never
      : T[number]
    : never
  : never;

/**
 * Call-site options of harness `K` with registration `D` in a workflow with declared roles `TProfile`.
 * `profile` accepts a built-in preset or a declared role. When `TStrict` is exactly `true` (a
 * workflow that omits `strictProfiles` or sets it to a literal `true`), the harness's capability keys
 * are omitted, mirroring the runtime check: for Claude and Codex every key except `isolation`, which
 * is narrowed to exclude `'inherit'`; for a registered harness every literal `capabilityKeys` entry.
 * A literal `false`, or a non-literal `boolean`, keeps every option.
 */
export type CallOptions<
  K extends string,
  D,
  TProfile extends string,
  TStrict extends boolean,
> = Extract<
  ([TStrict] extends [true]
    ? K extends 'claude' | 'codex'
      ? Omit<OptionsOf<D>, 'profile' | 'isolation' | CapabilityKeysOf<D>> & {
          /** Native configuration mode or worktree shorthand; strict profiles own `'inherit'`. */
          readonly isolation?: Exclude<AgentIsolation, 'inherit'> | undefined;
        }
      : Omit<OptionsOf<D>, 'profile' | CapabilityKeysOf<D>>
    : Omit<OptionsOf<D>, 'profile'>) & {
    /** Built-in preset or one of this workflow's declared role names. */
    readonly profile?: BuiltinProfile | TProfile | undefined;
  },
  AgentOptions
>;

/** Client that cannot request structured responses from a text-only registration. */
export type RegisteredAgentClient<
  O extends AgentOptions,
  C extends HarnessCapabilities,
> = 'none' extends C['structuredOutput']
  ? {
      /** Invoke a text response and retain session/usage diagnostics. */
      text<TMode extends ErrorMode = 'throw'>(
        id: string,
        options: O & { readonly onError?: TMode | undefined },
      ): Promise<EffectResult<AgentResult<string>, TMode>>;
      /** Return only text; schemas are unavailable for this registration. */
      value<TMode extends ErrorMode = 'throw'>(
        id: string,
        options: O & { readonly schema?: never; readonly onError?: TMode | undefined },
      ): Promise<EffectResult<string, TMode>>;
    }
  : AgentClient<O>;

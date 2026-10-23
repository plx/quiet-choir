import type { ClaudeOptions, CodexOptions, JsonValue } from './model.js';
import type { HarnessIsolation } from './agent-isolation.js';
import type { EnvironmentSummary } from './agent-environment-model.js';
/** Named presets supplied by the runtime. */
export type BuiltinProfile = 'text' | 'readonly' | 'edit';

/** Capability classification; exec includes arbitrary command or unknown tool execution. */
export type AccessClass = 'none' | 'read' | 'write' | 'exec';

/** Resource limits available to profile launch overrides. Codex uses only the two deadlines. */
export interface ProfileLimits {
  /** Wall-clock deadline, enforced by the harness. */
  readonly timeoutMs?: number;
  /** Idle deadline: no native output for this long ends the attempt (kind idle-timeout). Off by default. */
  readonly idleTimeoutMs?: number;
  /** Claude agent turn cap. */
  readonly maxTurns?: number;
  /** Claude per-call spend cap in USD. */
  readonly maxBudgetUsd?: number;
}

/** A shared role with harness-specific semantics and common resource limits. */
export interface AgentProfile extends ProfileLimits {
  /** Options for explicitly registered harnesses; prompt and per-call control fields stay at the call site. */
  readonly harnesses?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Configuration policy for both providers; harness-specific settings can override it. */
  readonly isolation?: HarnessIsolation;
  /** Built-in or declared parent; inheritance cycles are definition errors. */
  readonly extends?: string;
  /** Human-readable purpose, included in validate's manifest. */
  readonly description?: string;
  /** Optional assertion of the inferred maximum access across both providers. */
  readonly access?: AccessClass;
  /**
   * Whether this role expects tools. A completed attempt with a known zero tool count then records
   * a `no-tool-use` step warning. Defaults to true when the role grants more than the text baseline
   * (any Claude tool, or a Codex sandbox beyond read-only).
   */
  readonly expectsToolUse?: boolean;
  /** Warn by default, or fail on reported permission denials. */
  readonly onPermissionDenied?: 'warn' | 'fail';
  /** Claude model, tool gates, role prompts, configuration mode and native controls. */
  readonly claude?: Omit<
    ClaudeOptions,
    | 'profile'
    | 'prompt'
    | 'cwd'
    | 'onError'
    | 'retry'
    | 'isolation'
    | 'worktree'
    | 'systemPrompt'
    | 'appendSystemPrompt'
    | keyof ProfileLimits
  > & {
    /** Replace the system prompt via a private temporary file. Profiles take a string. */
    readonly systemPrompt?: string;
    /** Append stable role instructions via a private temporary file. Profiles take a string. */
    readonly appendSystemPrompt?: string;
    /** Overrides the profile-wide configuration mode; checkout placement stays per call. */
    readonly isolation?: HarnessIsolation;
  };
  /** Codex model, sandbox, effort and native controls. */
  readonly codex?: Omit<
    CodexOptions,
    | 'profile'
    | 'prompt'
    | 'cwd'
    | 'onError'
    | 'retry'
    | 'images'
    | 'isolation'
    | 'worktree'
    | keyof ProfileLimits
  > & {
    /** Overrides the profile-wide configuration mode; checkout placement stays per call. */
    readonly isolation?: HarnessIsolation;
  };
}

/** Workflow-wide defaults applied after the selected built-in preset. */
export interface AgentDefaults<TName extends string = string> extends Omit<
  AgentProfile,
  'extends'
> {
  /** Implicit profile for calls that omit profile. Defaults to text. */
  readonly profile?: BuiltinProfile | TName;
}

/** One ordered launch-time limit override; '*' selects every profile. */
export interface ProfileOverride extends ProfileLimits {
  /** Built-in/declared name or '*'; semantic fields cannot be overridden here. */
  readonly profile: string;
}

/**
 * Public stand-in for one free-form native control that manifests do not print. The raw value stays
 * in the live profile for execution and grant pins; a digest of a short or guessable value can be
 * guessed, which is the same trade-off as an environment digest.
 */
export interface RedactedControl {
  /** SHA-256 of the canonical JSON of the raw control value. */
  readonly sha256: string;
  /**
   * Sorted top-level names (settings keys, server or subagent names, dotted config keys, or the
   * keys of an object-valued registered harness option); absent for strings, numbers, booleans and
   * arrays.
   */
  readonly keys?: readonly string[];
}

/**
 * Fully resolved plain-data role, suitable for validation output: the resolved role in public
 * capability manifests.
 *
 * @deprecated Roster entries replace profiles (ADR 0063); this name goes with them (#696). The
 * runtime calls it ResolvedRole.
 */
export interface ResolvedProfile extends Omit<
  AgentProfile,
  'extends' | 'access' | 'claude' | 'codex'
> {
  /** Inferred access for each declared additional harness. */
  readonly harnessAccess?: Readonly<Record<string, AccessClass>>;
  /** Profile-owned generic capability controls, used for grant pinning and child delegation. */
  readonly harnessCapabilities?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Safe environment diagnostics retained when serializable manifests omit explicit values. */
  readonly environment?: {
    /** Claude environment edit names and digest. */
    readonly claude: EnvironmentSummary;
    /** Codex environment edit names and digest. */
    readonly codex: EnvironmentSummary;
  };
  /**
   * Names and digests of free-form controls that public manifests (checkpoints, validate and
   * check-resume output) omit from `claude` and `codex`, and of registered harness options a
   * declaration lists in `sensitiveOptions`. Absent when the profile sets none of them.
   */
  readonly redacted?: {
    /** Claude controls omitted from `claude`. */
    readonly claude?: {
      /** Native settings object. */
      readonly settings?: RedactedControl;
      /** MCP server definitions, by server name. */
      readonly mcpServers?: RedactedControl;
      /** Subagent definitions, by agent name, including descriptions and prompts. */
      readonly agents?: RedactedControl;
      /** Replacement system prompt. */
      readonly systemPrompt?: RedactedControl;
      /** Appended system prompt. */
      readonly appendSystemPrompt?: RedactedControl;
    };
    /** Codex controls omitted from `codex`. */
    readonly codex?: {
      /** Dotted native config overrides, by key. */
      readonly config?: RedactedControl;
    };
    /**
     * Registered harness options listed in the declaration's `sensitiveOptions`, by harness name
     * and option key, omitted from both `harnesses` and `harnessCapabilities`.
     */
    readonly harnesses?: Readonly<Record<string, Readonly<Record<string, RedactedControl>>>>;
  };
  /** Name used for selection and diagnostics, outside step identity. */
  readonly name: string;
  /**
   * The one harness a roster entry is pinned to (ADR 0063 §4); absent for profiles and built-ins.
   * A call that selects this role on another harness is refused, and `access` is this harness's.
   */
  readonly harness?: string;
  /**
   * Maximum harness access, checked against an optional declaration; for a roster entry, the
   * pinned harness's access only.
   */
  readonly access: AccessClass;
  /** Claude tools classification. */
  readonly claudeAccess: AccessClass;
  /** Codex sandbox classification; at least read, even for text. */
  readonly codexAccess: AccessClass;
  /** Resolved Claude semantics, including both tool gates. */
  readonly claude: NonNullable<AgentProfile['claude']> & {
    /** Exact exposed tools. */
    readonly tools: readonly string[];
    /** Exact pre-approved tools or narrower rules. */
    readonly allowedTools: readonly string[];
  };
  /** Resolved Codex semantics, including its sandbox. */
  readonly codex: NonNullable<AgentProfile['codex']> & {
    /** Effective filesystem sandbox. */
    readonly sandbox: 'read-only' | 'workspace-write';
  };
}

/**
 * A fully resolved role: a roster entry, built-in preset or declared profile (ADR 0063 section 4).
 * @internal
 */
export type ResolvedRole = ResolvedProfile; // eslint-disable-line @typescript-eslint/no-deprecated -- the public manifest keeps the deprecated name until the removal slice (#696)

/** Capability declaration without evaluating the workflow body. */
export interface CapabilityManifest {
  /** Whether call-site capability controls are prohibited. */
  readonly strictProfiles: boolean;
  /** Default profile name. */
  readonly defaultProfile: string;
  /** Resolved implicit call defaults. */
  readonly defaults: ResolvedProfile; // eslint-disable-line @typescript-eslint/no-deprecated -- the public manifest keeps the deprecated name until the removal slice (#696)
  /** All callable profiles, including built-ins. Under requireGrants, elevated ones need a grant. */
  readonly profiles: Readonly<Record<string, ResolvedProfile>>; // eslint-disable-line @typescript-eslint/no-deprecated -- the public manifest keeps the deprecated name until the removal slice (#696)
  /**
   * Declared/default elevated roles checked before the body starts under `requireGrants`; empty
   * when the run and its root definition do not opt in.
   */
  readonly requiredGrants: readonly string[];
}

/**
 * Maps each key of an inferred value type `T` that `Shape` does not declare to `never`, and
 * recurses into nested object values against the declared field type, so structured values such as
 * `env: { set, unset }` are checked too; declared keys whose values are not objects map to
 * `unknown`, so `Shape` alone checks them. `defineRoster` intersects the literal entries it infers
 * with this, which keeps the excess-property checks that inferring them would otherwise drop: an
 * unknown key then fails as not assignable to `never`. Arrays and shapes with an index signature
 * (native settings, MCP servers and subagents, the flat `env` overlay) stay open. A union `Shape`
 * accepts a value that matches some member, so `env: { FOO: 'bar' }` still compiles as the flat
 * overlay. It distributes over unions of `T`.
 */
export type NoExtraKeys<T, Shape> = T extends readonly unknown[]
  ? unknown
  : T extends object
    ? // O: the non-array object members of Shape.
      (
        NonNullable<Shape> extends infer S
          ? S extends readonly unknown[]
            ? never
            : S extends object
              ? S
              : never
          : never
      ) extends infer O
      ? [O] extends [never]
        ? unknown
        : // M: the members T matches; with none, check every member so unknown keys still fail.
          (O extends unknown ? (T extends O ? O : never) : never) extends infer M
          ? ([M] extends [never] ? O : M) extends infer C
            ? // A union of one exact view per member; an index-signature member is open.
              C extends unknown
              ? string extends keyof C
                ? unknown
                : { readonly [K in keyof T]: K extends keyof C ? NoExtraKeys<T[K], C[K]> : never }
              : never
            : never
          : never
      : never
    : unknown;

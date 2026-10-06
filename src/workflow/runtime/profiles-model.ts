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
    | keyof ProfileLimits
  > & {
    /** Overrides the profile-wide configuration mode; checkout placement stays per call. */
    readonly isolation?: HarnessIsolation;
    /**
     * Directories that bound call-site `addDirs` under `strictProfiles`. A call using this profile
     * may pass `addDirs` whose canonical paths (symlinks resolved, `..` segments refused) equal or
     * sit inside one of these roots; accepted entries are appended to this profile's own `addDirs`
     * as canonical absolute paths. Roots resolve against the run's working directory and are
     * pinned by named grants. Without roots, strict call sites cannot pass `addDirs`. Profile-only:
     * never a call option.
     */
    readonly addDirRoots?: readonly string[];
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
    /**
     * Not supported: Codex `addDirs` are writable sandbox roots, so Codex cannot take bounded
     * call-site directories. List them statically in `codex.addDirs`; a definition that sets this
     * fails validation.
     */
    readonly addDirRoots?: never;
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

/** Fully resolved plain-data role, suitable for validation output. */
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
  /** Maximum harness access, checked against an optional declaration. */
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

/** Capability declaration without evaluating the workflow body. */
export interface CapabilityManifest {
  /** Whether call-site capability controls are prohibited. */
  readonly strictProfiles: boolean;
  /** Default profile name. */
  readonly defaultProfile: string;
  /** Resolved implicit call defaults. */
  readonly defaults: ResolvedProfile;
  /** All callable profiles, including built-ins. Elevated built-ins require a grant before use. */
  readonly profiles: Readonly<Record<string, ResolvedProfile>>;
  /** Declared/default elevated roles checked before the body starts. */
  readonly requiredGrants: readonly string[];
}

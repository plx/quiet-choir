import type { ClaudeOptions, CodexOptions, JsonValue } from './model.js';
import type { HarnessIsolation } from './agent-isolation.js';
import type { EnvironmentSummary } from './agent-environment-model.js';
/** Named presets supplied by the runtime. */
export type BuiltinProfile = 'text' | 'readonly' | 'edit';

/** Capability classification; exec includes arbitrary command or unknown tool execution. */
export type AccessClass = 'none' | 'read' | 'write' | 'exec';

/** Resource limits available to profile launch overrides. Codex uses only timeoutMs. */
export interface ProfileLimits {
  /** Wall-clock deadline, enforced by the harness. */
  readonly timeoutMs?: number;
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
  /** Whether this role expects tools; reserved for tool-count diagnostics once available. */
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
  /** Sorted top-level names (settings keys, server or subagent names, dotted config keys); absent for strings. */
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
   * check-resume output) omit from `claude` and `codex`. Absent when the profile sets none of them.
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

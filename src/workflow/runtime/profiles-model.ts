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

/** A shared role with provider-specific semantics and common resource limits. */
export interface AgentProfile extends ProfileLimits {
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
  /** Claude model and exact exposed/pre-approved tools. */
  readonly claude?: {
    /** Model alias or name; omission uses harness configuration. */
    readonly model?: string;
    /** Exposed tools; omission inherits. Replacing this also replaces inferred allowedTools. */
    readonly tools?: readonly string[];
    /** Narrower permission rules; omission pre-approves the exposed tools. */
    readonly allowedTools?: readonly string[];
  };
  /** Codex model, sandbox and reasoning controls. */
  readonly codex?: {
    /** Model alias or name; omission uses harness configuration. */
    readonly model?: string;
    /** Filesystem sandbox. */
    readonly sandbox?: 'read-only' | 'workspace-write';
    /** Reasoning effort; omission uses harness configuration. */
    readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    /** Allow execution outside Git. */
    readonly skipGitRepoCheck?: boolean;
    /** Structured schema encoding. */
    readonly structuredOutput?: 'strict' | 'compat';
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

/** Fully resolved plain-data role, suitable for validation output. */
export interface ResolvedProfile extends Omit<
  AgentProfile,
  'extends' | 'access' | 'claude' | 'codex'
> {
  /** Name used for selection and diagnostics, outside step identity. */
  readonly name: string;
  /** Maximum provider access, checked against an optional declaration. */
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

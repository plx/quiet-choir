import type { AgentOptions, Effort, JsonValue } from '../../workflow/runtime/model.js';

/** Codex-specific controls. CliHarness defaults to read-only sandbox and never approving. */
export interface CodexOptions extends AgentOptions {
  /** Native effort level; cannot accompany Codex reasoningEffort. */
  readonly effort?: Effort | undefined;
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

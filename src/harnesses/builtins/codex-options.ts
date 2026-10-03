import type { AgentOptions, Effort, JsonValue } from '../../workflow/runtime/model.js';

/** Codex-specific controls. CliHarness defaults to read-only sandbox and never approving. */
export interface CodexOptions extends AgentOptions {
  /** Reasoning effort, sent as model_reasoning_effort; Codex also accepts none and minimal. */
  readonly effort?: 'none' | 'minimal' | Effort | undefined;
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
  /**
   * Native instruction loading. `'native'` (the default) lets Codex read the user's
   * `CODEX_HOME/AGENTS.md`, user skills and project `AGENTS.md` files. `'none'` runs Codex against
   * a private temporary `CODEX_HOME` holding only a copy of `auth.json` (refreshed credentials are
   * written back) and sets `project_doc_max_bytes=0`. `'none'` requires restricted isolation and
   * enters step identity; `'native'` and unset fingerprint identically.
   */
  readonly instructions?: 'native' | 'none';
  /** Allow use outside a Git repository. */
  readonly skipGitRepoCheck?: boolean;
}

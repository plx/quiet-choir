import type { AgentOptions, Effort, JsonValue } from '../../workflow/runtime/model.js';

/** Claude-specific controls. CliHarness denies unapproved tools by default. */
export interface ClaudeOptions extends AgentOptions {
  /** Native effort level, mapped to --effort. */
  readonly effort?: Effort | undefined;
  /** Warn about denied tools, or fail the call; overrides the selected profile policy. */
  readonly onPermissionDenied?: 'warn' | 'fail';
  /** Explicit plugin directories; native code is trusted and paths enter semantic identity. */
  readonly plugins?: readonly string[];
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

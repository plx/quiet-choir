import { environmentEdits } from '../harness-kit.js';
import type { AgentEnvironment, HostEnvironmentSummary } from '../harness-kit.js';

/**
 * Additional exact host names to scrub on top of the built-in host-session patterns, or false to
 * retain host-session context entirely. An explicit `env.set` still applies after scrubbing.
 */
export type ScrubEnvironment = false | readonly string[];

/** Host-session names: identifiers, sockets and markers of the agent session that launched us. */
const sessionNames = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TURN_ID',
  'AI_AGENT',
  'TRACEPARENT',
]);
const sessionPrefixes = ['CLAUDE_CODE_', 'CLAUDE_PLUGIN_', 'CODEX_INTERNAL_', 'CODEX_COMPANION_'];
/** `CLAUDE_CODE_*` names that select authentication or behavior rather than describe a session. */
const keptClaudeCode = /^CLAUDE_CODE_(?:USE_.*|OAUTH_TOKEN|EFFORT_LEVEL|SUBAGENT_MODEL)$/u;

/** Whether the built-in scrub removes a host name; authentication and behavior names stay. */
function hostSession(name: string): boolean {
  if (sessionNames.has(name)) return true;
  if (!sessionPrefixes.some((prefix) => name.startsWith(prefix))) return false;
  return !keptClaudeCode.test(name);
}
const behavior =
  /^(?:ANTHROPIC_|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_KEY$|CODEX_HOME$|CLAUDE_CODE_EFFORT_LEVEL$|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_CODE_OAUTH_TOKEN$|MAX_THINKING_TOKENS$|CLAUDE_CONFIG_DIR$)/u;

/** Validate adapter configuration without reading the host environment. @internal */
export function validateScrubEnvironment(scrub: ScrubEnvironment | undefined): void {
  if (scrub === undefined || scrub === false) return;
  if (
    !Array.isArray(scrub) ||
    scrub.some((name) => typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name))
  )
    throw new Error('scrubEnv must be false or an array of environment variable names.');
}

/**
 * Build one child process environment from `parent` (by default `process.env`) without mutating
 * it: remove host-session variables, then apply explicit `edits`. Pass the result's `env` to
 * {@link runProcess} with `inheritEnv: false`, since `runProcess` otherwise overlays the host
 * environment.
 *
 * The scrub removes `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, `TRACEPARENT`,
 * `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_TURN_ID`, and every `CLAUDE_PLUGIN_*`,
 * `CODEX_INTERNAL_*`, `CODEX_COMPANION_*` and `CLAUDE_CODE_*` name except `CLAUDE_CODE_USE_*`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL`.
 * Credentials and configuration such as `ANTHROPIC_*`, `OPENAI_*`, `CODEX_HOME`, `CODEX_API_KEY`
 * and `CLAUDE_CONFIG_DIR` are kept. `scrub` adds exact names, or `false` disables scrubbing.
 *
 * The summary lists names only, never values: `variables` are inherited authentication and
 * behavior names, and `scrubbed` every name removed.
 */
export function childEnvironment(
  edits?: AgentEnvironment,
  scrub?: ScrubEnvironment,
  parent: NodeJS.ProcessEnv = process.env,
): {
  /** Complete child environment: the scrubbed parent plus explicit edits. */
  env: Record<string, string>;
  /** Inherited and scrubbed host names, never values. */
  summary: HostEnvironmentSummary;
} {
  validateScrubEnvironment(scrub);
  const extra = new Set(scrub === false ? [] : (scrub ?? []));
  const removed = (name: string): boolean =>
    scrub !== false && (hostSession(name) || extra.has(name));
  const entries = Object.entries(parent).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const summary = {
    variables: entries
      .map(([name]) => name)
      .filter((name) => behavior.test(name))
      .sort(),
    scrubbed: entries
      .map(([name]) => name)
      .filter(removed)
      .sort(),
  };
  const changes = environmentEdits(edits);
  const env = Object.fromEntries([
    ...entries.filter(([name]) => !removed(name)),
    ...Object.entries(changes.set),
  ]);
  for (const name of changes.unset) Reflect.deleteProperty(env, name);
  return { env, summary };
}

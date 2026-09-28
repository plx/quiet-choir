import { environmentEdits } from '../harness-kit.js';
import type { AgentEnvironment, HostEnvironmentSummary } from '../harness-kit.js';

/** Additional host names to scrub, or false to explicitly retain host-session context. */
export type ScrubEnvironment = false | readonly string[];

const sessionNames = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TRACEPARENT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TURN_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
]);
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

/** Capture one child environment without mutating process.env or exposing its values as diagnostics. @internal */
export function childEnvironment(
  edits: AgentEnvironment | undefined,
  scrub: ScrubEnvironment | undefined,
  parent: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; summary: HostEnvironmentSummary } {
  validateScrubEnvironment(scrub);
  const configured =
    scrub === false ? new Set<string>() : new Set([...sessionNames, ...(scrub ?? [])]);
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
      .filter((name) => configured.has(name))
      .sort(),
  };
  const changes = environmentEdits(edits);
  const env = Object.fromEntries([
    ...entries.filter(([name]) => !configured.has(name)),
    ...Object.entries(changes.set),
  ]);
  for (const name of changes.unset) Reflect.deleteProperty(env, name);
  return { env, summary };
}

/**
 * Claude Code capability fragments: the runtime's text, read-only and edit configurations, a web
 * reader, and allowlisted shells. Spread one into a `defineRoster` entry, as in
 * `Reviewer: { ...std.claude.ReadOnly, description: 'Reviews the diff.' }`, and compose it with a
 * model tier (`std.tiers`), limits (`std.limits`) and a persona (`std.personas`) in that order, so
 * each later `description` wins. Each entry is frozen data with a short `description` that a spread
 * entry overrides.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Researcher: { ...std.claude.Web, ...std.tiers.Scribe },
 *   Checker: std.claude.shell([...std.bash.gitRead, ...std.bash.nodeCheck]),
 *   Fixer: {
 *     ...std.claude.editShell([...std.bash.nodeCheck, ...std.bash.gitCommit]),
 *     ...std.tiers.Mechanic,
 *   },
 * });
 * ```
 *
 * Access follows the tools: {@link Text} is `none`, {@link ReadOnly} and {@link Web} are `read`,
 * {@link Edit} is `write`, and both shells are `exec` (a narrowed `Bash` still counts as a shell),
 * so a workflow with `requireGrants` needs a grant for {@link Edit} and the shells. `tools` and
 * `allowedTools` replace on spread: override them together, since an `allowedTools` rule must
 * narrow an exposed tool.
 *
 * @module
 */
import { noPush } from './bash.js';

/** A text-only Claude agent: no tools, the text configuration's turn, spend and time limits. */
export const Text: {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** No built-in tools. */
  readonly tools: readonly [];
  /** At most 10 agent turns. */
  readonly maxTurns: 10;
  /** At most USD 0.50 per call. */
  readonly maxBudgetUsd: 0.5;
  /** Five minutes per call. */
  readonly timeoutMs: 300_000;
} = Object.freeze({
  harness: 'claude',
  description: 'Answers from the prompt alone; uses no tools.',
  tools: Object.freeze([] as const),
  maxTurns: 10,
  maxBudgetUsd: 0.5,
  timeoutMs: 300_000,
});

/** A read-only Claude agent: Read, Grep and Glob, the read-only configuration's limits. */
export const ReadOnly: {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** The read-only built-in tools. */
  readonly tools: readonly ['Read', 'Grep', 'Glob'];
  /** At most 25 agent turns. */
  readonly maxTurns: 25;
  /** At most USD 2 per call. */
  readonly maxBudgetUsd: 2;
  /** Fifteen minutes per call. */
  readonly timeoutMs: 900_000;
} = Object.freeze({
  harness: 'claude',
  description: 'Reads files and answers; never edits.',
  tools: Object.freeze(['Read', 'Grep', 'Glob'] as const),
  maxTurns: 25,
  maxBudgetUsd: 2,
  timeoutMs: 900_000,
});

/**
 * A Claude agent that edits files: the read tools plus Edit and Write, the edit configuration's
 * limits.
 */
export const Edit: {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** The read tools plus Edit and Write. */
  readonly tools: readonly ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
  /** At most 40 agent turns. */
  readonly maxTurns: 40;
  /** At most USD 5 per call. */
  readonly maxBudgetUsd: 5;
  /** Thirty minutes per call. */
  readonly timeoutMs: 1_800_000;
} = Object.freeze({
  harness: 'claude',
  description: 'Edits files in the working tree.',
  tools: Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write'] as const),
  maxTurns: 40,
  maxBudgetUsd: 5,
  timeoutMs: 1_800_000,
});

/**
 * A Claude agent that reads files and the web: the read tools plus WebSearch and WebFetch, with
 * {@link ReadOnly}'s limits. Its access is `read`, so it needs no grant; it does need network
 * access to the sites it fetches.
 */
export const Web: {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** The read tools plus WebSearch and WebFetch. */
  readonly tools: readonly ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
  /** At most 25 agent turns. */
  readonly maxTurns: 25;
  /** At most USD 2 per call. */
  readonly maxBudgetUsd: 2;
  /** Fifteen minutes per call. */
  readonly timeoutMs: 900_000;
} = Object.freeze({
  harness: 'claude',
  description: 'Reads files and the web; never edits.',
  tools: Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] as const),
  maxTurns: 25,
  maxBudgetUsd: 2,
  timeoutMs: 900_000,
});

/** What {@link shell} returns: the read tools plus a `Bash` narrowed to an allowlist. */
export interface ShellEntry {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** The read tools plus Bash. */
  readonly tools: readonly ['Read', 'Grep', 'Glob', 'Bash'];
  /** The read tools plus the `Bash(...)` rules, so Bash runs only allowlisted commands. */
  readonly allowedTools: readonly string[];
  /** Rules denied even when the allowlist matches. */
  readonly disallowedTools: readonly string[];
  /** At most 25 agent turns. */
  readonly maxTurns: 25;
  /** At most USD 2 per call. */
  readonly maxBudgetUsd: 2;
  /** Fifteen minutes per call. */
  readonly timeoutMs: 900_000;
}

/** What {@link editShell} returns: the edit tools plus a `Bash` narrowed to an allowlist. */
export interface EditShellEntry {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** The read tools, Edit and Write, plus Bash. */
  readonly tools: readonly ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
  /** The read and edit tools plus the `Bash(...)` rules, so Bash runs only allowlisted commands. */
  readonly allowedTools: readonly string[];
  /** Rules denied even when the allowlist matches. */
  readonly disallowedTools: readonly string[];
  /** At most 40 agent turns. */
  readonly maxTurns: 40;
  /** At most USD 5 per call. */
  readonly maxBudgetUsd: 5;
  /** Thirty minutes per call. */
  readonly timeoutMs: 1_800_000;
}

/**
 * A `Bash(...)` rule: the tool name and one nonempty parenthesized command pattern, with no further
 * parentheses or control characters, so one string holds exactly one rule.
 */
const bashRule = /^Bash\([^()\p{Cc}]+\)$/u;

/** The command a `Bash(<command>)` or `Bash(<command>:*)` rule matches, without the prefix marker. */
function ruleCommand(rule: string): { command: string; prefix: boolean } | undefined {
  if (!bashRule.test(rule)) return undefined;
  const body = rule.slice('Bash('.length, -')'.length);
  return body.endsWith(':*')
    ? { command: body.slice(0, -':*'.length), prefix: true }
    : { command: body, prefix: false };
}

/**
 * Whether the deny rule `denied` matches every command the allow rule `allowed` approves: the same
 * rule, or a prefix deny rule whose command is the allowed command or a whole-word prefix of it.
 */
function shadows(denied: string, allowed: string): boolean {
  if (denied === allowed) return true;
  const deny = ruleCommand(denied);
  const allow = ruleCommand(allowed);
  if (deny === undefined || allow === undefined || !deny.prefix) return false;
  return allow.command === deny.command || allow.command.startsWith(`${deny.command} `);
}

/** Validate and de-duplicate the allow and deny lists of a shell entry, keeping first positions. */
function shellRules(
  where: string,
  rules: readonly string[],
  deny: readonly string[],
): { allow: readonly string[]; deny: readonly string[] } {
  // Checked as unknown: an untyped caller may pass anything.
  const allowValue: unknown = rules;
  const denyValue: unknown = deny;
  if (!Array.isArray(allowValue) || allowValue.length === 0)
    throw new TypeError(
      `${where} needs at least one Bash(...) rule, such as those in std.bash; without one, Bash runs nothing.`,
    );
  for (const rule of allowValue as readonly unknown[])
    if (typeof rule !== 'string' || !bashRule.test(rule))
      throw new TypeError(
        `${where} rule ${JSON.stringify(rule)} must be a Bash(...) rule, such as std.bash.rule('git', 'log').`,
      );
  if (!Array.isArray(denyValue))
    throw new TypeError(`${where} deny must be an array of permission rules.`);
  for (const rule of denyValue as readonly unknown[])
    if (typeof rule !== 'string' || rule.trim() === '' || rule !== rule.trim())
      throw new TypeError(
        `${where} deny rule ${JSON.stringify(rule)} must be a nonempty permission rule without surrounding whitespace.`,
      );
  const denied = new Set(deny);
  for (const rule of rules)
    for (const denial of denied)
      if (shadows(denial, rule))
        throw new TypeError(
          `${where} rule ${rule} is both allowed and denied (by ${denial}); pass a deny list without it.`,
        );
  return { allow: [...new Set(rules)], deny: Object.freeze([...denied]) };
}

/**
 * A Claude agent that reads files and runs allowlisted commands: Read, Grep, Glob and a `Bash`
 * narrowed by `allowedTools` to `rules`, with {@link ReadOnly}'s limits. It has no edit tools, but
 * a shell is `exec` access whatever its allowlist, so a workflow with `requireGrants` needs a grant
 * for it. Build `rules` from `std.bash`; duplicate rules are dropped, keeping first positions.
 *
 * ```ts
 * Checker: std.claude.shell([...std.bash.gitRead, ...std.bash.nodeCheck]),
 * ```
 *
 * @param rules - The `Bash(...)` rules the agent may run, such as `std.bash.gitRead`.
 * @param deny - Rules denied even when an allowed rule matches. Default: `std.bash.noPush`.
 * @returns A frozen entry; spread it, then a tier and a persona, into a roster entry.
 * @throws TypeError - `rules` is empty, a rule is not a `Bash(...)` rule, a deny rule is not a
 *   nonempty string, or a deny rule matches every command an allowed rule approves (the same rule,
 *   or a prefix rule such as `Bash(git push:*)` against `Bash(git push --dry-run:*)`).
 */
export function shell(rules: readonly string[], deny: readonly string[] = noPush): ShellEntry {
  const checked = shellRules('std.claude.shell', rules, deny);
  return Object.freeze({
    harness: 'claude',
    description: 'Reads files and runs allowlisted commands.',
    tools: Object.freeze(['Read', 'Grep', 'Glob', 'Bash'] as const),
    allowedTools: Object.freeze(['Read', 'Grep', 'Glob', ...checked.allow]),
    disallowedTools: checked.deny,
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
  });
}

/**
 * A Claude agent that edits files and runs allowlisted commands: the read tools, Edit, Write and a
 * `Bash` narrowed by `allowedTools` to `rules`, with {@link Edit}'s limits. Its access is `exec`.
 * Build `rules` from `std.bash`; duplicate rules are dropped, keeping first positions.
 *
 * ```ts
 * Fixer: {
 *   ...std.claude.editShell([...std.bash.nodeCheck, ...std.bash.gitCommit], std.bash.noRewrite),
 *   ...std.tiers.Mechanic,
 * },
 * ```
 *
 * @param rules - The `Bash(...)` rules the agent may run, such as `std.bash.gitCommit`.
 * @param deny - Rules denied even when an allowed rule matches. Default: `std.bash.noPush`; pass
 *   `std.bash.noRewrite` to also forbid resets, rebases and other history rewrites.
 * @returns A frozen entry; spread it, then a tier and a persona, into a roster entry.
 * @throws TypeError - `rules` is empty, a rule is not a `Bash(...)` rule, a deny rule is not a
 *   nonempty string, or a deny rule matches every command an allowed rule approves.
 */
export function editShell(
  rules: readonly string[],
  deny: readonly string[] = noPush,
): EditShellEntry {
  const checked = shellRules('std.claude.editShell', rules, deny);
  return Object.freeze({
    harness: 'claude',
    description: 'Edits files and runs allowlisted commands.',
    tools: Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] as const),
    allowedTools: Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', ...checked.allow]),
    disallowedTools: checked.deny,
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
  });
}

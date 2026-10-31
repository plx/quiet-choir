/**
 * Claude Code roster entries carrying the values of the built-in `text`, `readonly` and `edit`
 * presets (ADR 0063 section 3): spread one into a `defineRoster` entry, as in
 * `Reviewer: { ...std.claude.ReadOnly, description: 'Reviews the diff.' }`. Each entry is frozen
 * data with a short `description` that a spread entry overrides.
 *
 * @module
 */

/** A text-only Claude agent: no tools, the `text` preset's turn, spend and time limits. */
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

/** A read-only Claude agent: Read, Grep and Glob, the `readonly` preset's limits. */
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
 * A Claude agent that edits files: the read tools plus Edit and Write, the `edit` preset's limits.
 * Without a shell its agent cannot delete, rename or chmod a file; retract such a path from code on
 * the shared handle instead (see `docs/worktrees.md`, "Shared write, test, fix sequences").
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

/**
 * Codex roster entries carrying the sandbox and time limit of the built-in `text`, `readonly` and
 * `edit` presets (ADR 0063 section 3): spread one into a `defineRoster` entry, as in
 * `Mechanic: { ...std.codex.Edit, description: 'Applies the fix.' }`. Each entry is frozen data
 * with a short `description` that a spread entry overrides.
 *
 * Codex has no tool-less mode: `Text` differs from `ReadOnly` only in its shorter time limit. Codex's
 * read-only sandbox blocks writes and network access, not reads: the agent can read, and run
 * read-only commands over, any file the OS user can read, so a `cwd` or runtime worktree places a
 * call without confining it. Use `std.claude.Text` for prompt-only roles, and a restricted Claude
 * reader where confinement matters.
 *
 * The entries carry no `maxTurns` or `maxBudgetUsd`: those are Claude-only limits that Codex
 * options do not have, so a Codex roster entry cannot set them.
 *
 * @module
 */

/**
 * A Codex agent for text answers. It is not tool-less: it has `ReadOnly`'s read-only sandbox, which
 * can read any file the user can read, not only its working directory, and the `text` preset's time
 * limit.
 */
export const Text: {
  /** Pinned to Codex. */
  readonly harness: 'codex';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** Codex's read-only sandbox. */
  readonly sandbox: 'read-only';
  /** Five minutes per call. */
  readonly timeoutMs: 300_000;
} = Object.freeze({
  harness: 'codex',
  description: 'Answers in text; can still read any file through a read-only sandbox.',
  sandbox: 'read-only',
  timeoutMs: 300_000,
});

/**
 * A read-only Codex agent: a sandbox that blocks writes but not reads outside its working
 * directory, and the `readonly` preset's time limit.
 */
export const ReadOnly: {
  /** Pinned to Codex. */
  readonly harness: 'codex';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** Codex's read-only sandbox. */
  readonly sandbox: 'read-only';
  /** Fifteen minutes per call. */
  readonly timeoutMs: 900_000;
} = Object.freeze({
  harness: 'codex',
  description: 'Reads through a read-only sandbox.',
  sandbox: 'read-only',
  timeoutMs: 900_000,
});

/** A Codex agent that edits files: a workspace-write sandbox and the `edit` preset's time limit. */
export const Edit: {
  /** Pinned to Codex. */
  readonly harness: 'codex';
  /** What the entry is for; a spreading entry usually replaces it. */
  readonly description: string;
  /** Codex's workspace-write sandbox. */
  readonly sandbox: 'workspace-write';
  /** Thirty minutes per call. */
  readonly timeoutMs: 1_800_000;
} = Object.freeze({
  harness: 'codex',
  description: 'Edits files in a workspace-write sandbox.',
  sandbox: 'workspace-write',
  timeoutMs: 1_800_000,
});

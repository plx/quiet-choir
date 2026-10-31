/**
 * Codex roster entries carrying the sandbox and time limit of the built-in `text`, `readonly` and
 * `edit` presets (ADR 0063 section 3): spread one into a `defineRoster` entry, as in
 * `Mechanic: { ...std.codex.Edit, description: 'Applies the fix.' }`. Each entry is frozen data
 * with a short `description` that a spread entry overrides.
 *
 * Codex has no tool-less mode: every Codex call runs in a sandbox that reads, and can run read-only
 * commands over, its working directory, so `Text` differs from `ReadOnly` only in its shorter time
 * limit.
 *
 * The entries carry no `maxTurns` or `maxBudgetUsd`: those are Claude-only limits that Codex
 * options do not have, so a Codex roster entry cannot set them.
 *
 * @module
 */

/**
 * A Codex agent for text answers. It is not tool-less: it has the same read-only sandbox as
 * `ReadOnly`, which reads, and runs read-only commands over, its working directory, with the `text`
 * preset's time limit.
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
  description: 'Answers in text; still reads its working directory through a read-only sandbox.',
  sandbox: 'read-only',
  timeoutMs: 300_000,
});

/** A read-only Codex agent: a read-only sandbox and the `readonly` preset's time limit. */
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

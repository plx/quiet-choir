/**
 * Codex capability fragments carrying the sandbox and time limit of the runtime's text, read-only
 * and edit configurations (ADR 0063 section 3): spread one into a `defineRoster` entry, as in
 * `Mechanic: { ...std.codex.Edit, effort: 'high', description: 'Applies the fix.' }`. Each entry is
 * frozen data with a short `description` that a spread entry overrides; `std.roles` has complete
 * Codex entries built from them.
 *
 * The entries carry no `maxTurns` or `maxBudgetUsd`: those are Claude-only limits that Codex
 * options do not have, so a Codex roster entry cannot set them, and the `std.tiers`, `std.limits`
 * and `std.personas` fragments, which are Claude-only, do not spread onto them. Codex has no
 * standing system prompt: prepend a persona's `appendSystemPrompt` text to the call's prompt instead.
 *
 * @module
 */

/** A Codex agent meant for text answers: a read-only sandbox and the text configuration's time limit. */
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
  description: 'Answers from the prompt through a read-only sandbox.',
  sandbox: 'read-only',
  timeoutMs: 300_000,
});

/** A read-only Codex agent: a read-only sandbox and the read-only configuration's time limit. */
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

/** A Codex agent that edits files: a workspace-write sandbox and the edit configuration's time limit. */
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

/**
 * Model tiers from the native epic scripts: each fixes only a Claude model and effort, so it
 * composes with a capability entry by spread, as in
 * `Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic }`. A tier alone is a valid roster entry
 * with Claude's default capabilities. Each tier is frozen data; its `description` replaces the
 * capability entry's when spread after it.
 *
 * @module
 */
import type { Effort } from '../index.js';

/**
 * The shape of every tier: a Claude model and effort with a one-line purpose.
 *
 * @typeParam M - The model alias.
 * @typeParam E - The effort level.
 */
export interface Tier<M extends string = string, E extends Effort = Effort> {
  /** Pinned to Claude Code. */
  readonly harness: 'claude';
  /** The Claude model alias. */
  readonly model: M;
  /** The Claude effort level. */
  readonly effort: E;
  /** What the tier is spent on. */
  readonly description: string;
}

/** Haiku at low effort: runs commands and relays their output. */
export const Clerk: Tier<'haiku', 'low'> = Object.freeze({
  harness: 'claude',
  model: 'haiku',
  effort: 'low',
  description: 'Runs commands and relays their output.',
});

/** Sonnet at low effort: copies long output exactly. */
export const Copyist: Tier<'sonnet', 'low'> = Object.freeze({
  harness: 'claude',
  model: 'sonnet',
  effort: 'low',
  description: 'Copies long output exactly.',
});

/** Sonnet at medium effort: writes descriptions and summaries. */
export const Scribe: Tier<'sonnet', 'medium'> = Object.freeze({
  harness: 'claude',
  model: 'sonnet',
  effort: 'medium',
  description: 'Writes descriptions and summaries.',
});

/** Sonnet at high effort: mechanical implementation. */
export const Mechanic: Tier<'sonnet', 'high'> = Object.freeze({
  harness: 'claude',
  model: 'sonnet',
  effort: 'high',
  description: 'Implements mechanical changes.',
});

/** Opus at high effort: readiness checks and implementation plans. */
export const Planner: Tier<'opus', 'high'> = Object.freeze({
  harness: 'claude',
  model: 'opus',
  effort: 'high',
  description: 'Checks readiness and writes implementation plans.',
});

/** Opus at medium effort: confirms a verdict before it is acted on. */
export const Skeptic: Tier<'opus', 'medium'> = Object.freeze({
  harness: 'claude',
  model: 'opus',
  effort: 'medium',
  description: 'Confirms a verdict before it is acted on.',
});

/** Opus at high effort: subtle implementation, and escalation when a mechanic fails. */
export const Surgeon: Tier<'opus', 'high'> = Object.freeze({
  harness: 'claude',
  model: 'opus',
  effort: 'high',
  description: 'Implements subtle changes; takes over when a mechanic fails.',
});

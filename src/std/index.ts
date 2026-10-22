/**
 * `quiet-choir/std`: the opt-in standard library, built only on the public `quiet-choir` entry
 * point. It is a seed sized for the dog-food ports; a later decision record scopes the full
 * library once the ports show what recurs.
 *
 * - {@link claude} and {@link codex}: per-harness roster entries carrying the values of the
 *   built-in `text`, `readonly` and `edit` presets, to spread into a `defineRoster` entry.
 * - {@link tiers}: Claude model and effort tiers that compose with those entries by spread.
 * - {@link exec}: `json`, `git` and `committedArtifact` over public context methods.
 * - {@link patterns}: `reviewRevise` and `tolerantPanel`, typed against teams (ADR 0067).
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Reviewer: { ...std.claude.ReadOnly, description: 'Reviews the diff.' },
 *   Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic },
 * });
 * ```
 *
 * @packageDocumentation
 */
export * as claude from './claude.js';
export * as codex from './codex.js';
export * as tiers from './tiers.js';
export * as exec from './exec.js';
export * as patterns from './patterns.js';

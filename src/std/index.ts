/**
 * `quiet-choir/std`: the opt-in standard library, built only on the public `quiet-choir` entry
 * point, so a workflow can spend its lines on what is specific to it (ADR 0068). Every piece is an
 * ordinary composition of public context methods; nothing here is registered with the runtime.
 *
 * Roster inventory, composed by spread into a `defineRoster` entry:
 *
 * - {@link claude} and {@link codex}: per-harness capability fragments (text, read-only, edit,
 *   web, and allowlisted shells).
 * - {@link tiers}: Claude model and effort tiers.
 * - {@link limits}: Claude turn, spend and time limits.
 * - {@link personas}: standing system prompts for Claude roles.
 * - {@link roles}: complete entries that combine the axes above, and shell factories.
 * - {@link rosters}: ready-made rosters of those roles.
 * - {@link bash}: `Bash(...)` allowlist rules for shell-capable Claude entries.
 *
 * Data and helpers:
 *
 * - {@link types}: Zod schemas for recurring agent outputs and workflow data.
 * - {@link lenses}: catalogs of named lenses for bug hunts, review, security, design, research,
 *   releases, writing, evidence, requirements, specifications and critique.
 * - {@link data}: pure helpers for health, voting, deduplication, ranking, coverage and hashing.
 * - {@link text}: stable prompt text and Markdown reports.
 * - {@link exec}: durable command, Git and publication helpers.
 *
 * Higher-order workflow pieces:
 *
 * - {@link flow}: team-free control flow (loop until dry, dependency waves, settled fan-out).
 * - {@link patterns}: team-typed patterns (ADR 0067) such as review/revise, adversarial
 *   verification, critique, repair, tournaments, gates and map/reduce. Each result has a Zod
 *   schema of the same name, so a workflow can return it as its output.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Reviewer: { ...std.claude.ReadOnly, description: 'Reviews the diff.' },
 *   Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic },
 *   Skeptic: std.roles.Skeptic,
 * });
 * ```
 *
 * @packageDocumentation
 */
export * as claude from './claude.js';
export * as codex from './codex.js';
export * as tiers from './tiers.js';
export * as limits from './limits.js';
export * as personas from './personas.js';
export * as roles from './roles.js';
export * as rosters from './rosters.js';
export * as bash from './bash.js';
export * as types from './types.js';
export * as lenses from './lenses.js';
export * as data from './data.js';
export * as text from './text.js';
export * as exec from './exec.js';
export * as flow from './flow.js';
export * as patterns from './patterns.js';

/**
 * Ready-made rosters of the `std.roles` entries, for short examples and scratch workflows that
 * call a few standard roles:
 *
 * ```ts
 * import { defineWorkflow, z } from 'quiet-choir';
 * import * as std from 'quiet-choir/std';
 *
 * export default defineWorkflow({
 *   name: 'second-opinion',
 *   version: '1',
 *   input: z.object({ claim: z.string() }),
 *   output: z.boolean(),
 *   roster: std.rosters.readers,
 *   async run(ctx, { claim }) {
 *     const verdict = await ctx.roster.Skeptic.value('refute', {
 *       prompt: `Refute this claim; when unsure, answer refuted: true.\n\n${claim}`,
 *       schema: z.object({ refuted: z.boolean(), reasoning: z.string() }),
 *     });
 *     return !verdict.refuted;
 *   },
 * });
 * ```
 *
 * A `defineRoster` result cannot be spread into another roster, so neither can be extended. To
 * add or change an entry, build a roster from `std.roles` instead. Under `requireGrants`, every
 * `write` or `exec` entry needs a grant before the body runs, even when the body never calls it:
 * {@link readers} needs none, while {@link standard} needs grants for its five editing roles.
 *
 * @module
 */
import { defineRoster, type Roster } from '../index.js';
import * as roles from './roles.js';

/** The role names in {@link readers}: the `std.roles` entries with `none` or `read` access. */
export type ReaderRole =
  | 'Clerk'
  | 'Writer'
  | 'Scout'
  | 'Reader'
  | 'Researcher'
  | 'Reviewer'
  | 'Skeptic'
  | 'Critic'
  | 'Judge'
  | 'Planner'
  | 'Scribe'
  | 'CodexReader'
  | 'CodexReviewer';

/**
 * Every `std.roles` entry that cannot change files: `Clerk` and `Writer` (`none`), and `Scout`,
 * `Reader`, `Researcher`, `Reviewer`, `Skeptic`, `Critic`, `Judge`, `Planner`, `Scribe`,
 * `CodexReader` and `CodexReviewer` (`read`). It needs no grant under `requireGrants`.
 */
export const readers: Roster<Pick<typeof roles, ReaderRole>, readonly []> = defineRoster({
  Clerk: roles.Clerk,
  Writer: roles.Writer,
  Scout: roles.Scout,
  Reader: roles.Reader,
  Researcher: roles.Researcher,
  Reviewer: roles.Reviewer,
  Skeptic: roles.Skeptic,
  Critic: roles.Critic,
  Judge: roles.Judge,
  Planner: roles.Planner,
  Scribe: roles.Scribe,
  CodexReader: roles.CodexReader,
  CodexReviewer: roles.CodexReviewer,
});

/**
 * Every `std.roles` entry: those of {@link readers} plus the `write` roles `Editor`, `Mechanic`,
 * `Surgeon`, `CodexEditor` and `CodexMechanic`, which each need a grant under `requireGrants`.
 */
export const standard: Roster<typeof roles, readonly []> = defineRoster({
  Clerk: roles.Clerk,
  Writer: roles.Writer,
  Scout: roles.Scout,
  Reader: roles.Reader,
  Researcher: roles.Researcher,
  Reviewer: roles.Reviewer,
  Skeptic: roles.Skeptic,
  Critic: roles.Critic,
  Judge: roles.Judge,
  Planner: roles.Planner,
  Scribe: roles.Scribe,
  Editor: roles.Editor,
  Mechanic: roles.Mechanic,
  Surgeon: roles.Surgeon,
  CodexReader: roles.CodexReader,
  CodexReviewer: roles.CodexReviewer,
  CodexEditor: roles.CodexEditor,
  CodexMechanic: roles.CodexMechanic,
});

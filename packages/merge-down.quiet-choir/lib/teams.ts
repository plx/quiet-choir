// Teams for the swappable slots (ADR 0067). The fix stage picks a slot by the reviewer's complexity
// rating; the rebase stage's resolver is the surgeon for a change PR and the mechanic for a
// Dependabot PR, as the native script chose its tier.
import { defineTeam, type TeamOf } from 'quiet-choir';

/** The fixers: a mid-tier mechanic, and a surgeon for subtle work and for repairs. */
export const FixTeam = defineTeam({
  mechanic: 'Implements mechanical fixes and dependency updates.',
  surgeon: 'Implements subtle fixes, and takes over when the suite still fails after a fix.',
});
/** `{ mechanic, surgeon }`. */
export type FixTeam = TeamOf<typeof FixTeam>;

/** The semantic rebase: one resolver that finishes a conflicted rebase. */
export const ResolveTeam = defineTeam({
  resolver: 'Resolves rebase conflicts semantically, keeping both the PR and upstream intent.',
});
/** `{ resolver }`. */
export type ResolveTeam = TeamOf<typeof ResolveTeam>;

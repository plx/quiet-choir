// The implementer slot (ADR 0067). The plan's complexity and size pick the slot, as the native
// script chose its tier; the `implementer` input overrides it.
import { defineTeam, type TeamOf } from 'quiet-choir';

/** The implementers: a mid-tier mechanic, and a surgeon for subtle or large work and follow-ups. */
export const ImplementTeam = defineTeam({
  mechanic: 'Implements a mechanical plan.',
  surgeon:
    'Implements a subtle or large plan, and takes over when the mechanic leaves work unfinished.',
});
/** `{ mechanic, surgeon }`. */
export type ImplementTeam = TeamOf<typeof ImplementTeam>;

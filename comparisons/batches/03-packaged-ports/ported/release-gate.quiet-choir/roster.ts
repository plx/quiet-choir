// Data only. No entry writes: assessors and the confirmer read, the gatekeeper has no tools and
// decides from the evidence code hands it. The upstream's high effort on every call is the Skeptic
// tier at high effort for the judges, the Planner tier for the gatekeeper's synthesis, and high
// effort on the Confirmer, which runs on Codex so a blocker faces an independent harness.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Assessor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Judges one readiness dimension from the range and command output; never edits.',
  },
  Confirmer: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Tries to downgrade one blocker against the code, on Codex; never edits.',
  },
  Gatekeeper: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Chooses among the decisions code allows and writes the rationale; uses no tools.',
  },
});

// Data only. No role edits: the checker and the challenger read a runtime-owned checkout of the
// pinned snapshot, and code runs every command. The upstream's high-effort decomposition is the
// Planner tier, its high-effort checks the Skeptic tier at high effort and its low-effort summary
// the Copyist tier; the letter-vs-spirit challenge runs on Codex at high effort, so a second
// harness, not the checker's, judges each pass.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Decomposer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Breaks the criteria into binary sub-checks and adds implied ones; uses no tools.',
  },
  Checker: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: "Judges one criterion's sub-checks against the pinned snapshot; never edits.",
  },
  Challenger: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Re-examines a passing criterion for letter-vs-spirit gaps; never edits.',
  },
  Narrator: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Narrates the verdict the workflow computed for stakeholders; uses no tools.',
  },
});

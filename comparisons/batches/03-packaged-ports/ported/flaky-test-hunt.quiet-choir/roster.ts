// Data only. Code runs every stress iteration, so the upstream's low-effort stress runner has no
// entry. Sweepers and the diagnostician read; only the Fixer writes, and only in a runtime-owned
// worktree, so under --require-grants a launch grants --grant Fixer alone. The upstream's
// high-effort diagnosis is the Planner tier; the fix it applied is the Surgeon tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Sweeper: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Finds flaky-test suspects from one evidence source; never edits or runs tests.',
  },
  Diagnostician: {
    ...std.claude.ReadOnly,
    ...std.tiers.Planner,
    description: 'Names the mechanism of one empirically flaky test and proposes a real fix.',
  },
  Fixer: {
    ...std.claude.Edit,
    ...std.tiers.Surgeon,
    description: 'Applies the approved fixes in an isolated checkout; code re-stresses them.',
  },
});

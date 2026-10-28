// Data only. The Surveyor reads; the Ranker and Reviewer work from their prompts alone. Only the
// NetWriter and Refactorer write, and only in runtime-owned worktrees, so under --require-grants a
// launch grants --grant NetWriter --grant Refactorer. The upstream's high-effort net, refactor and
// verify calls are the Surgeon tier for the two writers and the Skeptic tier at high effort for
// the reviewer; its high-effort rank is the Planner tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Surveyor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Finds refactoring targets by measurable pressure; never edits.',
  },
  Ranker: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Ranks the surveyed targets by payoff against risk; uses no tools.',
  },
  NetWriter: {
    ...std.claude.Edit,
    ...std.tiers.Surgeon,
    description: 'Adds characterization tests in an isolated checkout; code runs them.',
  },
  Refactorer: {
    ...std.claude.Edit,
    ...std.tiers.Surgeon,
    description: 'Applies one approved refactoring in an isolated checkout; code runs the nets.',
  },
  Reviewer: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Judges from the diff whether a refactoring is structural; uses no tools.',
  },
});

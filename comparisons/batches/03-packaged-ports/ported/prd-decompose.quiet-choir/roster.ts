// Data only. Code reads the PRD and lists the codebase, so no role needs a tool: every entry is
// std.claude.Text. The upstream's high-effort merge is the Planner tier and its high-effort
// coverage critic the Skeptic tier at high effort. The merger, critic and repairer handle the
// whole backlog, so they borrow the ReadOnly fragment's spend and time limits: Text's suit short
// answers.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const long = {
  maxBudgetUsd: std.claude.ReadOnly.maxBudgetUsd,
  timeoutMs: std.claude.ReadOnly.timeoutMs,
};

export const roster = defineRoster({
  LensReader: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description: 'Extracts anchored work items from the PRD through one lens; uses no tools.',
  },
  Merger: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Merges the lenses into deduplicated tickets in dependency order; uses no tools.',
  },
  Critic: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    ...long,
    effort: 'high',
    description: 'Walks the PRD backwards and reports the backlog coverage gaps; uses no tools.',
  },
  Repairer: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    ...long,
    description: 'Adds or amends tickets for the coverage gaps as a patch; uses no tools.',
  },
});

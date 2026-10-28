// Data only. Code reads the material and renders the PRD, so no role needs a tool: every entry is
// std.claude.Text. The lenses are the Scribe tier (the upstream left their effort unset); the
// upstream's high-effort draft and revision are the Planner tier, and its high-effort critics the
// Skeptic tier at high effort. The writer and the critics handle the whole PRD, so they borrow the
// ReadOnly fragment's spend and time limits: Text's suit short answers.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const long = {
  maxBudgetUsd: std.claude.ReadOnly.maxBudgetUsd,
  timeoutMs: std.claude.ReadOnly.timeoutMs,
};

export const roster = defineRoster({
  Extractor: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description:
      'Extracts quoted findings, unknowns and conflicts through one lens; uses no tools.',
  },
  Writer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Drafts the structured PRD from the findings and revises it once; uses no tools.',
  },
  Critic: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    ...long,
    effort: 'high',
    description:
      'Attacks the draft through one charter with quoted issues and fixes; uses no tools.',
  },
});

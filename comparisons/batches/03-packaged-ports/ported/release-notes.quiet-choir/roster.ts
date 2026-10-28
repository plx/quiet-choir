// Data only. Capability comes from std.claude, model and effort from std.tiers; the upstream's
// per-call effort choices (summarize low, fact-check high) live on the entries, not the call sites.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Summarizer: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    description: 'Summarizes one disjoint slice of commits from its patch; never edits.',
  },
  Drafter: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description: 'Drafts and revises the notes from the summaries alone; uses no tools.',
  },
  FactChecker: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Checks the notes against the range in both directions; never edits.',
  },
});

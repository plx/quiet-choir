// Data only. Nobody edits: the Scoper and Reporter work from their prompts alone, and the Reviewer
// and Skeptic read a snapshot of the pinned head. The upstream's low-effort scope and report are
// the Copyist tier, its high-effort verification the Skeptic tier at high effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Scoper: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description:
      'Summarizes the pinned change and flags risky areas from its patch; uses no tools.',
  },
  Reviewer: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Reviews the patch through one dimension in a snapshot of the head; never edits.',
  },
  Skeptic: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Tries to refute one finding at the head, refuting when unsure; never edits.',
  },
  Reporter: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Writes the markdown report from the verified findings alone; uses no tools.',
  },
});

// Data only. Sweepers and skeptics read; only the Remover writes, and only in a runtime-owned
// worktree, so under --require-grants a launch grants --grant Remover alone. The upstream's
// high-effort cross-check is the Skeptic tier at high effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Sweeper: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Finds dead-code candidates through one search modality; never edits.',
  },
  Skeptic: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Hunts a living reference for one candidate, keeping it when unsure; never edits.',
  },
  Remover: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Deletes the approved list in an isolated checkout; code runs verification.',
  },
});

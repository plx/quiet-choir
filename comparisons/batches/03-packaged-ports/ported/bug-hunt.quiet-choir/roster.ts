// Data only. Both entries read and never edit; the upstream's high-effort skeptic votes are the
// Skeptic tier at high effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Finder: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Hunts concrete runtime bugs through one lens; never edits.',
  },
  Skeptic: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Tries to refute one bug claim by reading the code; never edits.',
  },
});

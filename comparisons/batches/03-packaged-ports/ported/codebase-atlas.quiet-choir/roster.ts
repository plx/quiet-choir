// Data only. Every role reads; nothing edits, because code writes the atlas. The upstream's
// low-effort survey and synthesis are the Copyist tier, the readers the Scribe tier, and its
// high-effort completeness critic is a read-only Codex role, so an independent harness audits what
// Claude readers wrote.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Surveyor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    description: 'Skims the layout and build files to partition the repository; never edits.',
  },
  Reader: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Deep-reads one subsystem, or researches one repair, into a card; never edits.',
  },
  Synthesizer: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Writes the overview and start-here list from the cards alone; uses no tools.',
  },
  Critic: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Audits the assembled atlas against the repository for gaps; never edits.',
  },
});

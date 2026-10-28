// Data only. No agent writes: the test file, the baseline and every mutation are code effects.
// The upstream's high-effort ranking is the Planner tier on a tool-less entry, since it ranks the
// gap list it is given.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  GapFinder: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Finds test gaps in the target through one lens; never edits.',
  },
  Ranker: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Ranks the discovered gaps by blast radius; uses no tools.',
  },
  TestAuthor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Mechanic,
    description: 'Proposes the test file and the mutants it must kill; never edits.',
  },
});

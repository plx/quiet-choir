// Data only. Code reads the corpus and hands every role its items in the prompt, so no role has a
// tool (std.claude.Text) and nothing edits. The upstream's low-effort taggers are the Copyist
// tier, its unspecified-effort calibrator and divers the Scribe tier, and its high-effort report
// writer the Planner tier. The upstream's low-effort inventory agent is gone: code parses the
// corpus.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Calibrator: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description: 'Fixes the theme vocabulary from a code-drawn sample; uses no tools.',
  },
  Tagger: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Tags every item of one shard against the fixed vocabulary; uses no tools.',
  },
  Diver: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description: "Explains one theme's mechanism from its own items; uses no tools.",
  },
  Reporter: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Writes the summary and long-tail prose around code-rendered facts; no tools.',
  },
});

// The prompt index: every agent prompt as a markdown template with typed parameters. Items.md,
// Severity.md and Untrusted.md are fragments under prompts/_fragments/; Items.md reads `items`.
import { definePrompts, z } from 'quiet-choir';
import { PromptItem, RankedTheme, Theme } from './contracts.js';

const focus = z.string().nullable();
const items = z.array(PromptItem).min(1);
const Starter = z.object({ id: z.string(), ref: z.string(), text: z.string() });

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Calibrate: {
    file: 'Calibrate.md',
    description: 'Fix the theme vocabulary from an evenly spread sample before any tagging.',
    params: z.object({ focus, total: z.int().min(1), fields: z.array(z.string()), items }),
  },
  Tag: {
    file: 'Tag.md',
    description: 'Tag every item of one shard against the fixed vocabulary, with verbatim quotes.',
    params: z.object({
      focus,
      vocabulary: z.array(Theme).min(1),
      shard: z.int().min(1),
      shards: z.int().min(1),
      items,
    }),
  },
  Dive: {
    file: 'Dive.md',
    description: 'Deep-dive one ranked theme from its own items: storyline, segments, one action.',
    params: z.object({
      focus,
      theme: RankedTheme,
      items,
      omitted: z.int().min(0),
      starters: z.array(Starter),
    }),
  },
  Report: {
    file: 'Report.md',
    description: 'Write the summary, long-tail and emergent prose; code renders the rest.',
    params: z.object({
      coverage: z.string(),
      weight: z.int().min(0),
      ranked: z.array(RankedTheme).min(1),
      longTail: z.array(RankedTheme),
      emergent: z.array(z.string()),
      moreEmergent: z.int().min(0),
      gaps: z.array(z.string()),
      dives: z.string().describe('The deep dives that ran, as JSON'),
    }),
  },
});

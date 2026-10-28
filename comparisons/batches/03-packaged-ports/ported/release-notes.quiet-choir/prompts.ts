// The prompt index: every agent prompt as a markdown template with typed parameters. Changes.md
// and Evidence.md are fragments under prompts/_fragments/ that the stage templates include.
import { definePrompts, z } from 'quiet-choir';
import { Change } from './contracts.js';

const evidence = { changes: z.array(Change), missing: z.array(z.string()) };

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Summarize: {
    file: 'Summarize.md',
    description: 'Summarize one disjoint slice of the range from its patch.',
    params: z.object({ shas: z.array(z.string()).min(1), patch: z.string() }),
  },
  Draft: {
    file: 'Draft.md',
    description: 'Draft audience-aware notes from the slice summaries.',
    params: z.object({ audience: z.string(), ...evidence }),
  },
  FactCheck: {
    file: 'FactCheck.md',
    description: 'Fact-check the notes in both directions (the critic of reviewRevise).',
    params: z.object({ span: z.string(), log: z.string(), notes: z.string(), ...evidence }),
  },
  Revise: {
    file: 'Revise.md',
    description: 'Revise the notes from fact-check feedback (the actor of reviewRevise).',
    params: z.object({ notes: z.string(), feedback: z.string(), ...evidence }),
  },
});

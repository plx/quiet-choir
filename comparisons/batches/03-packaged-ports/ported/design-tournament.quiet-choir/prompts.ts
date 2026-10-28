// The prompt index: every agent prompt as a markdown template with typed parameters. Proposal.md
// (one proposal under its letter) and Material.md are fragments under prompts/_fragments/.
import { definePrompts, z } from 'quiet-choir';
import { Dissent, Idea, Lettered, Philosophy, Standing, Winner } from './contracts.js';

const task = { brief: z.string(), context: z.string().nullable() };

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Propose: {
    file: 'Propose.md',
    description: 'Design for the brief in character, as one assigned philosophy.',
    params: z.object({ ...task, philosophy: Philosophy }),
  },
  Judge: {
    file: 'Judge.md',
    description: 'Score every anonymized proposal on the fixed rubric as one independent seat.',
    params: z.object({
      ...task,
      seat: z.int().min(1),
      judges: z.int().min(1),
      proposals: z.array(Lettered).min(2),
    }),
  },
  Synthesize: {
    file: 'Synthesize.md',
    description: 'Build the design on the winner and decide every losing idea by its ID.',
    params: z.object({
      ...task,
      judges: z.int().min(1),
      scoreboard: z.array(Standing).min(2),
      winner: Winner,
      proposal: Lettered,
      ideas: z.array(Idea),
      dissent: z.array(Dissent),
    }),
  },
});

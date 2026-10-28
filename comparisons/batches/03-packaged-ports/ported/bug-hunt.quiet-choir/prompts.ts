// The prompt index: the finder and skeptic prompts as markdown templates with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Bug } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Find: {
    file: 'Find.md',
    description: 'Hunt one lens of one round; an empty list is valid.',
    params: z.object({ scope: z.string(), lens: z.string(), round: z.int().min(1) }),
  },
  Refute: {
    file: 'Refute.md',
    description: 'One independent skeptic seat trying to refute a candidate.',
    params: z.object({ bug: Bug, seat: z.int().min(1), votes: z.int().min(1) }),
  },
});

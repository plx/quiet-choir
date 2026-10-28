// The prompt index: every agent prompt as a markdown template with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Candidate, Modality } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Sweep: {
    file: 'Sweep.md',
    description: 'Find candidates through one modality; each is blind to the others.',
    params: z.object({ scope: z.string(), modality: Modality }),
  },
  Alive: {
    file: 'Alive.md',
    description: 'Try to prove one candidate alive, with a default-to-keep bias.',
    params: z.object({ candidate: Candidate, modalities: z.int().min(1) }),
  },
  Remove: {
    file: 'Remove.md',
    description: 'Delete exactly the approved list; the approved JSON comes last.',
    params: z.object({ digest: z.string(), list: z.string() }),
  },
});

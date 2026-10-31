// The prompt index: every agent prompt as a markdown template with typed parameters. ReadOnly.md
// is a fragment under prompts/_fragments/ that the sweep and diagnosis templates include.
import { definePrompts, z } from 'quiet-choir';
import { Artifacts, History, Modality, Stress, Suspect } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Sweep: {
    file: 'Sweep.md',
    description: 'Find suspects from one evidence source; each sweeper is blind to the others.',
    params: z.object({
      scope: z.string(),
      modality: Modality,
      testFiles: z.array(z.string()),
      limit: z.int().positive(),
      history: History,
      artifacts: Artifacts,
    }),
  },
  Diagnose: {
    file: 'Diagnose.md',
    description: 'Name the mechanism of one measured flake and propose a fix that removes it.',
    params: z.object({
      suspect: Suspect,
      stress: Stress,
      command: z.string().describe('The stress argv as one line of JSON'),
      commit: z.string(),
      residue: z.array(z.string()),
    }),
  },
  Fix: {
    file: 'Fix.md',
    description: 'Apply exactly the approved fixes; the approved JSON comes last.',
    params: z.object({
      digest: z.string(),
      plan: z.string(),
      fixRuns: z.int().positive(),
      verifying: z.boolean(),
    }),
  },
});

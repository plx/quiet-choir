// The prompt index: every agent prompt as a markdown template with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Gap, Lens } from './contracts.js';

const target = z.string();
const behavior = z.string();
const source = z.string();

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  FindGaps: {
    file: 'FindGaps.md',
    description: 'Find gaps through the coverage or the risk lens.',
    params: z.object({ lens: Lens, target, behavior, source }),
  },
  Rank: {
    file: 'Rank.md',
    description: 'Rank the merged gaps by blast radius.',
    params: z.object({ gaps: z.array(Gap), maxGaps: z.int().min(1) }),
  },
  PlanTests: {
    file: 'PlanTests.md',
    description: 'Propose the test file and independent single-anchor mutants.',
    params: z.object({ target, testFile: z.string(), behavior, gaps: z.array(Gap), source }),
  },
});

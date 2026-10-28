// The prompt index: every agent prompt as a markdown template with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Concern, Detected, Plan } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Detect: {
    file: 'Detect.md',
    description: 'Choose or detect the stack and inventory existing tooling.',
    params: z.object({ spec: z.string(), stack: z.string().nullable(), inventory: z.string() }),
  },
  Plan: {
    file: 'Plan.md',
    description: 'Plan disjoint concerns and the commands that prove them.',
    params: z.object({ spec: z.string(), allowed: z.array(Concern), detected: Detected }),
  },
  Apply: {
    file: 'Apply.md',
    description: 'Apply one concern of the approved plan; the plan JSON comes last.',
    params: z.object({
      concern: Plan.shape.concerns.element,
      digest: z.string(),
      plan: z.string().describe('The approved plan as indented JSON'),
    }),
  },
});

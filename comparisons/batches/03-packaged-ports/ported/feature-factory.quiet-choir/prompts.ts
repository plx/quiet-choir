// The prompt index: every agent prompt as a markdown template with typed parameters. Ownership.md
// and Checkout.md are the fragments under prompts/_fragments/ that both writer templates include;
// the Build template ends with the approved plan JSON.
import { definePrompts, z } from 'quiet-choir';
import { Module, Ticket } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Plan: {
    file: 'Plan.md',
    description: 'Group the backlog into disjoint modules that build in a fixed order.',
    params: z.object({
      max: z.int().min(1),
      tickets: z.array(Ticket).min(1),
      sequencing: z.string().nullable(),
      openQuestions: z.array(z.string()),
      files: z.array(z.string()),
      omitted: z.int().nonnegative(),
    }),
  },
  Build: {
    file: 'Build.md',
    description: 'Implement one module of the approved plan; the plan JSON comes last.',
    params: z.object({
      module: Module,
      tickets: z.array(Ticket).min(1),
      builtOn: z.array(z.string()),
      digest: z.string(),
      plan: z.string().describe('The approved plan as indented JSON'),
    }),
  },
  Repair: {
    file: 'Repair.md',
    description: 'Fix the confirmed review findings of one module, inside its areas.',
    params: z.object({
      module: Module.pick({ name: true, fileAreas: true }),
      findings: z
        .array(
          z.object({
            title: z.string(),
            severity: z.string(),
            file: z.string(),
            line: z.int().nullable(),
            evidence: z.string(),
            failureScenario: z.string(),
            reasoning: z.string(),
          }),
        )
        .min(1),
    }),
  },
});

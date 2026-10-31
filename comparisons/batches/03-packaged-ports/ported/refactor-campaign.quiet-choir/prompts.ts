// The prompt index: every agent prompt as a markdown template with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Chosen, Target } from './contracts.js';

const goal = z.string();
const behaviors = z.array(z.string());

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Survey: {
    file: 'Survey.md',
    description: 'Find targets by measurable pressure, with evidence and current testability.',
    params: z.object({ scope: z.string(), goal }),
  },
  Rank: {
    file: 'Rank.md',
    description: 'Select the best payoff-for-risk targets and name each refactoring.',
    params: z.object({ targets: z.array(Target), maxTargets: z.int().min(1) }),
  },
  PinNet: {
    file: 'PinNet.md',
    description: 'Write, or rewrite from its red output, one target characterization net.',
    params: z.object({
      target: Chosen,
      command: z.string().describe('The test command, shown as text'),
      previous: z
        .object({
          netFile: z.string(),
          code: z.int().nullable(),
          failure: z.string().nullable().describe('How the run failed when it did not exit'),
          stdout: z.string().describe('The tail of standard output'),
          stderr: z.string().describe('The tail of standard error'),
          files: z.array(
            z.object({ path: z.string(), source: z.string(), shownBytes: z.int().nullable() }),
          ),
        })
        .nullable()
        .describe('The red net of the previous round; null for the first write'),
    }),
  },
  Refactor: {
    file: 'Refactor.md',
    description:
      'Apply one approved refactoring behind the nets; the approved goal and plan JSON come last.',
    params: z.object({
      target: Chosen,
      goal,
      netFile: z.string(),
      behaviors,
      protectedFiles: z.array(z.string()).describe("Every net's test and support files"),
      digest: z.string(),
      approved: z.string().describe('The approved goal and plan as indented JSON'),
    }),
  },
  Review: {
    file: 'Review.md',
    description: 'Judge from the diff and the net whether a refactoring is structural.',
    params: z.object({
      target: Chosen,
      goal,
      netFile: z.string(),
      behaviors,
      netSource: z.string(),
      netShownBytes: z
        .int()
        .nullable()
        .describe('The bytes of a truncated net shown; null if whole'),
      files: z
        .array(z.string())
        .describe('Every path the refactor touched, both sides of a rename'),
      diff: z.string(),
      shownBytes: z.int().nullable().describe('The bytes of a truncated diff shown; null if whole'),
    }),
  },
});

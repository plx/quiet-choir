// The prompt index: every agent prompt as a markdown template with typed parameters. Context.md is
// the fragment every stage template includes: the goal, the prior artifacts and this stage's
// human answer.
import { definePrompts, z } from 'quiet-choir';
import { DocumentStage, Stage } from './contracts.js';

const context = {
  goal: z.string(),
  artifacts: z.record(z.string(), z.string()),
  answer: z.string(),
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Intake: {
    file: 'Intake.md',
    description: 'Tailor the ordered stage plan.',
    params: z.object({
      goal: z.string(),
      artifacts: z.record(z.string(), z.string()),
      allowed: z.array(Stage),
    }),
  },
  Draft: {
    file: 'Draft.md',
    description: 'Write one lifecycle document; the stage commits it.',
    params: z.object({ ...context, stage: DocumentStage }),
  },
  Review: {
    file: 'Review.md',
    description: 'Gate one lifecycle document.',
    params: z.object({ ...context, stage: DocumentStage, content: z.string() }),
  },
  Implement: {
    file: 'Implement.md',
    description: 'Implement the goal in an isolated checkout.',
    params: z.object(context),
  },
});

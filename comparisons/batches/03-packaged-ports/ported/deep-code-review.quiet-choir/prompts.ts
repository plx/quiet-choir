// The prompt index: every agent prompt as a markdown template with typed parameters. Change.md,
// Snapshot.md and Evidence.md are fragments under prompts/_fragments/ that the stage templates
// include; the patch always arrives inside <patch> delimiters.
import { definePrompts, z } from 'quiet-choir';
import { Candidate, ChangedFile, Confirmed, Dimension } from './contracts.js';

const change = { files: z.array(ChangedFile), omitted: z.array(ChangedFile), patch: z.string() };
const range = { base: z.string(), head: z.string() };

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Scope: {
    file: 'Scope.md',
    description: 'Summarize the pinned change and its risks without reviewing it.',
    params: z.object(change),
  },
  Review: {
    file: 'Review.md',
    description: 'Review the patch through one dimension, in a snapshot of the head.',
    params: z.object({
      dimension: Dimension,
      summary: z.string(),
      riskNotes: z.string().nullable(),
      ...range,
      ...change,
    }),
  },
  Refute: {
    file: 'Refute.md',
    description: 'Try to refute one deduplicated finding, refuting when uncertain.',
    params: z.object({ finding: Candidate, patch: z.string(), ...range }),
  },
  Report: {
    file: 'Report.md',
    description: 'Write the report from the confirmed findings and the review gaps.',
    params: z.object({
      summary: z.string(),
      confirmed: z.array(Confirmed).min(1),
      unreviewedDimensions: z.array(Dimension),
      omitted: z.int().nonnegative(),
      unverified: z.int().nonnegative(),
      unchecked: z.int().nonnegative(),
    }),
  },
});

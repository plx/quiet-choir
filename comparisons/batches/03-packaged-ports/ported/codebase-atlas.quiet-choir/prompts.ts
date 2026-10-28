// The prompt index: every agent prompt as a markdown template with typed parameters. Card.md and
// Evidence.md are fragments under prompts/_fragments/ that the stage templates include.
import { definePrompts, z } from 'quiet-choir';

const names = z.array(z.string());
const card = {
  projectSummary: z.string(),
  others: names.describe('Section names a dependency may use'),
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Survey: {
    file: 'Survey.md',
    description: 'Partition the repository into subsystems from a code-built layout.',
    params: z.object({
      layout: z.array(z.object({ path: z.string(), files: z.int().min(1).nullable() })),
      omitted: z.int().min(0),
      fileCount: z.int().min(0),
      maxSubsystems: z.int().min(1),
    }),
  },
  Read: {
    file: 'Read.md',
    description: 'Deep-read one subsystem into a card.',
    params: z.object({
      name: z.string(),
      paths: names,
      hint: z.string().nullable(),
      files: names,
      moreFiles: z.int().min(0),
      ...card,
    }),
  },
  Synthesize: {
    file: 'Synthesize.md',
    description: 'Write the overview and start-here list from every card at once.',
    params: z.object({
      projectSummary: z.string(),
      cards: z.string(),
      unread: names,
      skipped: names,
    }),
  },
  Critique: {
    file: 'Critique.md',
    description: 'Audit the assembled atlas for completeness against the repository.',
    params: z.object({
      commit: z.string(),
      atlas: z.string(),
      sections: names,
      skipped: names,
      unread: names,
      unmatched: names,
      uncovered: z.array(z.object({ area: z.string(), files: z.int().min(1) })),
    }),
  },
  Repair: {
    file: 'Repair.md',
    description: "Research one section's gaps into a corrected or new card.",
    params: z.object({
      section: z.string(),
      gaps: z.array(z.object({ description: z.string(), repairAction: z.string() })),
      card: z.string().nullable(),
      ...card,
    }),
  },
});

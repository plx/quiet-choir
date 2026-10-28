// The prompt index: every agent prompt as a markdown template with typed parameters. Prd.md,
// Codebase.md, Estimates.md and Tickets.md are fragments under prompts/_fragments/.
import { definePrompts, z } from 'quiet-choir';
import { Gap, Item, Lens, Ticket } from './contracts.js';

const prd = z.string();
const tickets = z.array(Ticket).min(1);

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Lens: {
    file: 'Lens.md',
    description: 'Extract anchored work items through one lens; four other readers own the rest.',
    params: z.object({
      lens: Lens,
      prd,
      codebase: z
        .object({ path: z.string(), files: z.array(z.string()), omitted: z.int().min(0) })
        .nullable(),
    }),
  },
  Merge: {
    file: 'Merge.md',
    description: 'Merge the lenses into deduplicated, ordered tickets by judgment.',
    params: z.object({ items: z.array(Item).min(1), questions: z.array(z.string()) }),
  },
  Audit: {
    file: 'Audit.md',
    description: 'Walk the PRD backwards and report every coverage gap in the backlog.',
    params: z.object({ prd, tickets }),
  },
  Repair: {
    file: 'Repair.md',
    description: 'Add or amend tickets for the gaps, quoting the PRD; code applies the patch.',
    params: z.object({
      prd,
      tickets,
      sequencing: z.string(),
      gaps: z.array(Gap).min(1),
      next: z.string(),
    }),
  },
});

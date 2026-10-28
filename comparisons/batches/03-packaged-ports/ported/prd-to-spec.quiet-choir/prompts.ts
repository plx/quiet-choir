// The prompt index: every agent prompt as a markdown template with typed parameters. Brief and
// Context render the design-tournament child's input rather than an agent prompt; Grounding.md,
// Structure.md, Prd.md and Material.md are fragments under prompts/_fragments/.
import { definePrompts, z } from 'quiet-choir';
import { Audit, Contested, Gap, Ground, Lens, Section } from './contracts.js';

const prd = z.string();
const grounding = Ground.nullable();
/** The required headings and the decision IDs the Structure fragment asks for. */
const structure = { headings: z.array(z.string()).min(1), ids: z.array(z.string()) };

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Ground: {
    file: 'Ground.md',
    description: 'Map the existing architecture the spec must fit; design nothing.',
    params: z.object({
      prd,
      codebase: z.object({
        path: z.string(),
        files: z.array(z.string()),
        omitted: z.int().min(0),
      }),
    }),
  },
  Lens: {
    file: 'Lens.md',
    description: 'Draft one technical lens of the spec and record what it cannot settle.',
    params: z.object({ lens: Lens, prd, grounding }),
  },
  Merge: {
    file: 'Merge.md',
    description: 'Merge the lens drafts into one spec and decide every contested item by ID.',
    params: z.object({
      prd,
      grounding,
      ...structure,
      sections: z.array(Section).min(1),
      decisions: z.array(Contested),
      settled: z.object({ id: z.string(), design: z.string() }).nullable(),
    }),
  },
  Audit: {
    file: 'Audit.md',
    description: 'Audit the spec for implementability, or for fidelity to the PRD both ways.',
    params: z.object({ audit: Audit, spec: z.string(), prd: prd.nullable() }),
  },
  Repair: {
    file: 'Repair.md',
    description: 'Fix the audited gaps in place, deferring to open questions.',
    params: z.object({
      prd,
      spec: z.string(),
      ...structure,
      gaps: z.array(Gap.extend({ audit: Audit })).min(1),
      settled: z.string().nullable(),
    }),
  },
  Brief: {
    file: 'Brief.md',
    description: "The design-tournament child's brief: the decision and its options.",
    params: z.object({ decision: Contested }),
  },
  Context: {
    file: 'Context.md',
    description: "The design-tournament child's context: the grounding map and the PRD.",
    params: z.object({ prd, grounding }),
  },
});

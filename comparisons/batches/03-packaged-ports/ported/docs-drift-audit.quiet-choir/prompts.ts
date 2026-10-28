// The prompt index: every agent prompt as a markdown template with typed parameters.
import { definePrompts, z } from 'quiet-choir';
import { Checked, Claim, Listed, Ran } from './contracts.js';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Classify: {
    file: 'Classify.md',
    description: 'Give each listed doc an audience and a priority from its path and headings.',
    params: z.object({ base: z.string(), docs: z.array(Listed) }),
  },
  Extract: {
    file: 'Extract.md',
    description: 'Decompose one doc into atomic, checkable claims, each with a verbatim quote.',
    params: z.object({
      path: z.string(),
      audience: z.string().nullable(),
      maxClaims: z.int().min(1),
      text: z.string(),
    }),
  },
  Check: {
    file: 'Check.md',
    description: "Verify one doc's claims against the code, in order, with the evidence commands.",
    params: z.object({
      path: z.string(),
      base: z.string(),
      claims: z.array(Claim),
      evidence: z.array(Ran),
    }),
  },
  Fix: {
    file: 'Fix.md',
    description: 'Patch one doc where its verified claims drifted, leaving true claims alone.',
    params: z.object({ path: z.string(), drifted: z.array(Checked), kept: z.array(z.string()) }),
  },
});

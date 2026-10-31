// The prompt index: every agent prompt as a markdown template with typed parameters. Attack and
// Revise include the draft through prompts/_fragments/Prd.md, and Draft and Revise state the PRD's
// caps through prompts/_fragments/Caps.md; the caps the schemas enforce come in as parameters, so
// the prose states the same numbers.
import { definePrompts, z } from 'quiet-choir';
import { Charter, Finding, Issue, Lens } from './contracts.js';

const product = z.string().nullable();
const prd = z.string();
const count = z.number().int().nonnegative();
const caps = z.object({
  title: count,
  goals: count,
  users: count,
  requirements: count,
  nonFunctional: count,
  outOfScope: count,
  openQuestions: count,
  assumptions: count,
  cites: count,
});

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Extract: {
    file: 'Extract.md',
    description: 'Extract quoted findings through one lens; three other readers own the rest.',
    params: z.object({
      lens: Lens,
      product,
      answers: z.array(z.string()),
      documents: z.array(z.object({ label: z.string(), text: z.string() })).min(1),
      caps: z.object({
        findings: z.number().int(),
        unknowns: z.number().int(),
        conflicts: z.number().int(),
        quoteChars: z.number().int(),
        quoteWords: z.number().int(),
      }),
    }),
  },
  Draft: {
    file: 'Draft.md',
    description: 'Draft the PRD sections from the findings, presenting conflicts as decisions.',
    params: z.object({
      product,
      findings: z.array(Finding).min(1),
      conflicts: z.array(z.string()),
      unknowns: z.array(z.string()),
      unlisted: count.describe('How many more conflicts and unknowns code did not list'),
      caps,
    }),
  },
  Attack: {
    file: 'Attack.md',
    description: 'Attack the draft through one charter with quoted issues and concrete fixes.',
    params: z.object({ critic: Charter, product, prd, maxIssues: z.number().int() }),
  },
  Revise: {
    file: 'Revise.md',
    description: 'Apply the fixes; a fix that needs the product owner becomes an open question.',
    params: z.object({ prd, issues: z.array(Issue).min(1), caps }),
  },
});

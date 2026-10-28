// The prompt index: every agent prompt as a markdown template with typed parameters. Delivered.md
// and Commands.md are fragments under prompts/_fragments/ that the checker and challenger include.
import { definePrompts, z } from 'quiet-choir';
import {
  ChangedFile,
  Graded,
  Kind,
  MustFix,
  Pending,
  Ran,
  SubCheck,
  Verdict,
} from './contracts.js';

/** What the checker and the challenger are told about the pinned snapshot. */
const delivered = {
  snapshot: z.string(),
  base: z.string(),
  uncommitted: z.boolean(),
  paths: z.array(z.string()),
  files: z.array(ChangedFile),
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Decompose: {
    file: 'Decompose.md',
    description: 'Break each criterion into binary sub-checks and surface the implied criteria.',
    params: z.object({
      criteria: z.string(),
      source: z.string().nullable(),
      ticket: z.string().nullable(),
      files: z.array(ChangedFile),
      limits: z.object({ criteria: z.number(), implied: z.number(), checks: z.number() }),
    }),
  },
  Check: {
    file: 'Check.md',
    description: "Answer each of one criterion's sub-checks from the snapshot and command output.",
    params: z.object({
      ...delivered,
      criterion: z.string(),
      kind: Kind,
      implied: z.boolean(),
      checks: z.array(z.string()),
      commands: z.array(Ran),
      patch: z.string(),
      patchTruncated: z.boolean(),
    }),
  },
  Challenge: {
    file: 'Challenge.md',
    description: 'Look for the narrow pass: letter satisfied, intent missed.',
    params: z.object({
      ...delivered,
      criterion: z.string(),
      checks: z.array(SubCheck),
      commands: z.array(Ran),
    }),
  },
  Summarize: {
    file: 'Summarize.md',
    description: 'One stakeholder paragraph around the verdict the workflow computed.',
    params: z.object({
      verdict: Verdict,
      graded: z.array(Graded),
      mustFix: z.array(MustFix),
      pendingManual: z.array(Pending),
    }),
  },
});

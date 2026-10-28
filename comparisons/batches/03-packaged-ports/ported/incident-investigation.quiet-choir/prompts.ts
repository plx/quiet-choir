// The prompt index: every agent prompt as a markdown template with typed parameters. ReadOnly.md
// and Facts.md are fragments under prompts/_fragments/ that the stage templates include.
import { definePrompts, z } from 'quiet-choir';
import { Confidence, Domain, Evidence, Hypothesis, Judged } from './contracts.js';

const incident = z.string();
const evidence = z.array(Evidence);

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Collect: {
    file: 'Collect.md',
    description: 'Collect facts for one domain before any hypothesis exists.',
    params: z.object({ incident, domain: Domain, artifacts: z.array(z.string()), log: z.string() }),
  },
  Hypothesize: {
    file: 'Hypothesize.md',
    description: 'Generate three to five mechanically distinct, falsifiable hypotheses.',
    params: z.object({ incident, evidence }),
  },
  Falsify: {
    file: 'Falsify.md',
    description: 'Attack the predictions of exactly one hypothesis.',
    params: z.object({ incident, hypothesis: Hypothesis, rivals: z.array(z.string()), evidence }),
  },
  Report: {
    file: 'Report.md',
    description: 'Write the report around the confidence the workflow derived.',
    params: z.object({ incident, evidence, judged: z.array(Judged), confidence: Confidence }),
  },
});

// The prompt index: every agent prompt as a markdown template with typed parameters. Question.md,
// Credibility.md, Findings.md, Sources.md and Untrusted.md are fragments under prompts/_fragments/.
import { definePrompts, z } from 'quiet-choir';
import { Gap, Modality, Ranked, Source, TrackedGap } from './contracts.js';

const question = z.string();
const context = z.string().nullable();
const sources = z.array(Source);
/** The pinned commit for a local role's call, null for a web role's. */
const commit = z.string().nullable();
const cap = z.number().int().min(1);

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Sweep: {
    file: 'Sweep.md',
    description:
      'Find leads, not answers, through one modality whose charter names its blind spot.',
    params: z.object({ question, context, modality: Modality, commit, maxLeads: cap }),
  },
  Read: {
    file: 'Read.md',
    description: 'Deep-read one ranked lead, remote or local, into claim and support pairs.',
    params: z.object({ question, context, lead: Ranked, commit, maxFindings: cap }),
  },
  Synthesize: {
    file: 'Synthesize.md',
    description: 'Write the cited answer from keyed sources; a revision also addresses the gaps.',
    params: z.object({ question, context, sources, gaps: z.array(TrackedGap).nullable() }),
  },
  Critique: {
    file: 'Critique.md',
    description: 'Find gaps with targeted hunt instructions, given the facts code checked.',
    params: z.object({
      question,
      context,
      answer: z.string(),
      sources,
      unknown: z.array(z.string()),
      unswept: z.array(Modality),
      deferred: z.array(Ranked),
      huntCap: cap,
      maxGaps: cap,
    }),
  },
  Hunt: {
    file: 'Hunt.md',
    description: 'Run one targeted hunt for one critic gap, on the web or in the repository.',
    params: z.object({
      question,
      context,
      gap: Gap,
      known: z.array(z.string()),
      commit,
      maxFindings: cap,
    }),
  },
});

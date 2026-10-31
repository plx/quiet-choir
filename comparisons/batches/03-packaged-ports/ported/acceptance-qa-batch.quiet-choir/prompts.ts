// The prompt index: every agent prompt as a markdown template with typed parameters. Ticket.md
// and Probe.md are fragments under prompts/_fragments/ that the per-ticket templates include.
import { definePrompts, z } from 'quiet-choir';
import { CriterionResult, Ticket } from './contracts.js';

const argv = z.array(z.string());
/** How each probe runs: the argv, the prepare commands before it, and its checkout. */
const how = { argv, prepare: z.array(argv) };
const brief = {
  ...how,
  ticket: Ticket,
  scope: z.string(),
  runContext: z.string(),
  variables: z.array(z.string()).describe('The only environment variables a probe receives'),
  seconds: z.number().positive().describe("A probe's time limit"),
  base: z.string(),
  failCode: z.int().min(2).max(125),
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Ingest: {
    file: 'Ingest.md',
    description: 'Copy the tickets and criteria verbatim and describe how probes can run.',
    params: z.object({
      ...how,
      backlog: z.string(),
      scope: z.string(),
      maxCriteria: z.int().min(1),
      maxTranscribed: z.int().min(1),
    }),
  },
  Demonstrate: {
    file: 'Demonstrate.md',
    description: 'Write one probe per acceptance criterion, or say why it cannot be shown here.',
    params: z.object(brief),
  },
  Break: {
    file: 'Break.md',
    description: 'Write attack probes against a feature whose criteria were demonstrated.',
    params: z.object({
      ...brief,
      criteria: z.array(CriterionResult),
      maxAttacks: z.int().min(1),
    }),
  },
});

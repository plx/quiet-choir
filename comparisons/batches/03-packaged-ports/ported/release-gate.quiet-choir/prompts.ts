// The prompt index: every agent prompt as a markdown template with typed parameters. Range.md,
// Evidence.md and Commands.md are fragments under prompts/_fragments/ that the templates include.
import { definePrompts, z } from 'quiet-choir';
import { Assessed, Dimension, Excerpt, Row, Rule } from './contracts.js';

/** The pinned range every assessor and confirmer reads: its span, log and patch excerpts. */
const range = { span: z.string(), count: z.int().min(1), log: Excerpt, patch: Excerpt };
const policy = z.string();
/** One command run for a dimension: how it ended and the end of each output stream. */
const Command = z.object({
  argv: z.array(z.string()),
  outcome: z.string(),
  error: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  clipped: z.boolean(),
});

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Assess: {
    file: 'Assess.md',
    description: 'Judge one readiness dimension from the range and its command output.',
    params: z.object({ dimension: Assessed, policy, commands: z.array(Command), ...range }),
  },
  Confirm: {
    file: 'Confirm.md',
    description:
      'Try to downgrade one reported blocker against the code, the range and its output.',
    params: z.object({
      dimension: Dimension,
      evidence: z.string(),
      findings: z.array(z.string()),
      commands: z.array(Command),
      policy,
      ...range,
    }),
  },
  Decide: {
    file: 'Decide.md',
    description: 'Choose among the decisions code allows and write a forwardable rationale.',
    params: z.object({
      span: z.string(),
      policy,
      blockOn: z.array(Dimension),
      rule: Rule,
      blockers: z.array(Row.extend({ hard: z.boolean() })),
      concerns: z.array(Row),
      others: z.array(Row),
      unverified: z.array(Dimension),
    }),
  },
});

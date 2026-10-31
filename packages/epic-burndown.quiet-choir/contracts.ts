// Data contracts of epic-burndown: the input (one execute-epic-ticket input for every run, plus the
// loop bound) and the record of what each run did.
import { z } from 'quiet-choir';

/** The execute-epic-ticket statuses after which the next run can pick another ticket. */
export const CONTINUE = ['landed', 'closed-obsolete', 'closed-split', 'split'] as const;

/** Input. */
export const BurndownInput = z.object({
  ticketInput: z
    .json()
    .describe(
      'The execute-epic-ticket input every run gets (epic, repo, toolchain, mergeDown, …); not ticket or decision.',
    ),
  maxTickets: z
    .int()
    .positive()
    .default(25)
    .describe('Runs at most this many execute-epic-ticket children.'),
});
/** Parsed input. */
export type BurndownInput = z.output<typeof BurndownInput>;

/** One execute-epic-ticket run, as the burn-down records it. */
const Run = z.object({
  run: z.int(),
  ticket: z.int().nullable(),
  title: z.string().nullable(),
  status: z.string(),
  pr: z.int().nullable(),
  mergeCommit: z.string().nullable(),
  headline: z.string().nullable(),
  blocked: z.object({ stage: z.string(), reason: z.string() }).nullable(),
});

/** The record. */
export const BurndownResult = z.object({
  epic: z.int(),
  status: z.enum(['epic-done', 'stopped', 'max-tickets']),
  runs: z.array(Run),
  stoppedBy: z.string().nullable(),
  followupEpic: z.int().nullable(),
  remaining: z.json().nullable(),
  headline: z.string(),
});
/** Parsed record. */
export type BurndownResult = z.output<typeof BurndownResult>;

// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

export const Ticket = z.object({
  id: z.string().min(1).max(80).describe('The backlog ID, or T1, T2 and so on when it has none'),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  acceptanceCriteria: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(20)
    .describe('Each criterion exactly as the backlog writes it'),
});
export type Ticket = z.infer<typeof Ticket>;
export const Skipped = z.object({ id: z.string().min(1), reason: z.string().min(1) });
export type Skipped = z.infer<typeof Skipped>;
export const Backlog = z.object({
  tickets: z.array(Ticket).max(100),
  skipped: z.array(Skipped).max(100).describe('Tickets with no checkable criteria, and why'),
  runContext: z.string().min(1).describe('How a probe program can exercise this project'),
});

/** A program the workflow feeds to the operator's probe command on standard input. */
export const Probe = z.string().min(1).max(8000);
/** One plan entry per criterion, in order; the schema is built for each ticket's criteria. */
export const PlanFor = (criteria: number) =>
  z.object({
    criteria: z
      .array(
        z.object({
          claim: z.string().min(1).describe('What the probe checks, or what a human must check'),
          probe: Probe.nullable().describe(
            'Exits 0 only if the criterion holds; null when this checkout cannot demonstrate it',
          ),
        }),
      )
      .length(criteria),
  });
export type Plan = z.infer<ReturnType<typeof PlanFor>>;
export const Severity = z.enum(['breaks-criterion', 'degrades', 'cosmetic']);
export const AttacksFor = (max: number) =>
  z.object({
    attacks: z
      .array(
        z.object({
          description: z.string().min(1),
          severity: Severity.describe('What a reproduced break would mean'),
          probe: Probe.describe(
            'Exits 0 if the feature withstands the attack, nonzero if it breaks',
          ),
        }),
      )
      .max(max),
  });
export type Attacks = z.infer<ReturnType<typeof AttacksFor>>;
export type Attack = Attacks['attacks'][number];

/** What code observed when it ran one probe in its own pinned checkout. */
export const Run = z.object({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  failure: z.string().nullable().describe('Why no exit code was observed: timeout, signal, spawn'),
  stdout: z.string().describe('The last 1000 characters'),
  stderr: z.string().describe('The last 1000 characters'),
});
export type Run = z.infer<typeof Run>;
export const CriterionStatus = z.enum([
  'demonstrated',
  'failed',
  'inconclusive',
  'undemonstrable',
  'unrun',
]);
export type CriterionStatus = z.infer<typeof CriterionStatus>;
export const CriterionResult = z.object({
  criterion: z.string(),
  status: CriterionStatus,
  claim: z.string().nullable(),
  probe: z.string().nullable(),
  run: Run.nullable(),
});
export type CriterionResult = z.infer<typeof CriterionResult>;
export const AttackResult = z.object({
  description: z.string(),
  severity: Severity,
  probe: z.string(),
  outcome: z.enum(['broke', 'held', 'inconclusive', 'unrun']),
  run: Run.nullable(),
});
export type AttackResult = z.infer<typeof AttackResult>;
export const Graded = z.object({
  id: z.string(),
  title: z.string(),
  verdict: z.enum(['pass', 'pass-pending-manual', 'fail', 'unverified']),
  criteria: z.array(CriterionResult),
  attacks: z.array(AttackResult),
  demonstrator: z.enum(['answered', 'failed']),
  breaker: z.enum(['answered', 'failed', 'declined', 'skipped']),
  manual: z.array(z.string()).describe('What a human still has to check'),
});
export type Graded = z.infer<typeof Graded>;

export const AcceptanceInput = z.object({
  tickets: z
    .string()
    .min(1)
    .describe('A backlog file path under the workflow directory, or the ticket text itself'),
  scope: z.string().min(1).default('.').describe('Where the implementation lives'),
  probeCommand: Argv.describe(
    'Operator-selected argv that runs one probe program from stdin, e.g. ["node", "--input-type=module"]',
  ),
  maxTickets: z.number().int().min(1).max(30).default(8),
  maxAttacks: z.number().int().min(1).max(8).default(4).describe('Attack probes per ticket'),
  probeTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});

export const AcceptanceOutput = z.object({
  status: z.enum(['refused', 'empty', 'declined', 'degraded', 'limited', 'complete']),
  dirty: z.array(z.string()).describe('Uncommitted paths that refused the run'),
  base: Sha.nullable().describe('The commit every agent read and every probe ran against'),
  runContext: z.string().nullable(),
  tickets: z.array(Graded),
  passed: z.number().int().nonnegative().describe('pass and pass-pending-manual, as upstream'),
  failed: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
  deferred: z.array(z.object({ id: z.string(), title: z.string() })),
  skipped: z.array(Skipped).describe('Tickets the ingester found no checkable criteria for'),
  rejected: z
    .array(Skipped)
    .describe('Tickets code refused: a duplicate ID or a reworded criterion'),
  probeDigest: Digest.nullable(),
  attackDigest: Digest.nullable(),
});
export type AcceptanceOutput = z.infer<typeof AcceptanceOutput>;

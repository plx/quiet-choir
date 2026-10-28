// Data contracts: the input and output schemas and the structured agent results. The plan schema
// is built from the backlog it groups, so a reply cannot cite an unknown ticket, and its
// refinement (lib/plan.ts) refuses overlapping file areas, a dropped ticket or a dependency that
// builds later, so the planner is asked again with the problems.
import { z } from 'quiet-choir';
import { moduleLimit, planProblems } from './lib/plan.js';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const isPath = (value: string) =>
  value.length > 0 &&
  value.length <= 500 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value
    .split('/')
    .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
  !value.includes('\0');
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(isPath, 'Use a repository-relative path without dot segments or .git');
/** A file area is a plain directory or file path, so ownership is a prefix rule code can check. */
export const Area = Path.refine(
  (value) => !/[*?[\]{}]/u.test(value) && !value.startsWith(':'),
  'A file area is a plain repository path: no glob characters or pathspec magic',
);
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

export const Dimension = z.enum(['correctness', 'security', 'performance', 'tests', 'api-design']);
export const TicketId = z.string().regex(/^T[1-9][0-9]{0,2}$/u);

/** The fields of a prd-decompose ticket this package reads. */
export const Ticket = z.object({
  id: TicketId,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  estimate: z.string(),
  lane: z.string(),
  dependsOn: z.array(z.string()),
});
export type Ticket = z.infer<typeof Ticket>;

const moduleShape = {
  name: z.string().min(1).max(60).describe('A short module name, unique in the plan'),
  isFoundation: z
    .boolean()
    .describe('True if other modules build on it: schema, scaffolding, shared types'),
  fileAreas: z
    .array(Area)
    .min(1)
    .max(20)
    .describe('Repository directories or files this module alone may change'),
  notes: z.string().min(1).nullable().describe('Guidance for the builder, or null'),
};
export const Module = z.object({ ...moduleShape, ticketIds: z.array(TicketId).min(1).max(30) });
export type Module = z.infer<typeof Module>;
export const Deferral = z.object({ ticket: TicketId, reason: z.string().min(1) });
export const Plan = z.object({ modules: z.array(Module).min(1), deferred: z.array(Deferral) });
export type Plan = z.infer<typeof Plan>;
const report = (check: z.RefinementCtx, problems: string[]) => {
  for (const message of problems) check.addIssue({ code: 'custom', message });
};
/** The planner's reply: at most `max` modules, citing only these tickets, each exactly once. */
export const PlanFor = (tickets: readonly Ticket[], max: number) => {
  const ids = tickets.map((ticket) => ticket.id) as [string, ...string[]];
  return z
    .object({
      modules: z
        .array(z.object({ ...moduleShape, ticketIds: z.array(z.enum(ids)).min(1).max(30) }))
        .min(1)
        .max(max),
      deferred: z
        .array(z.object({ ticket: z.enum(ids), reason: z.string().min(1) }))
        .max(ids.length)
        .describe('Tickets that fit no module this run, each with the reason'),
    })
    .superRefine((plan, check) => report(check, planProblems(plan, tickets)));
};

export const Implemented = z.object({
  status: z.enum(['done', 'partial', 'blocked']),
  summary: z.string().min(1),
  blockers: z.array(z.string().min(1)).max(10),
});
export const Repaired = z.object({
  summary: z.string().min(1),
  unresolved: z
    .array(z.string().min(1))
    .max(20)
    .describe('Titles of the findings you could not fix'),
});

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
  tail: z.string().nullable().describe("A failed command's last output"),
});
export type Check = z.infer<typeof Check>;

export const FeatureFactoryInput = z
  .object({
    prd: z
      .string()
      .min(1)
      .describe(
        'The PRD text itself when it spans lines, else the repository-relative path of the PRD file; prd-decompose reads it',
      ),
    codebase: z
      .union([z.literal('.'), Path])
      .nullable()
      .default(null)
      .describe(
        'Repository directory prd-decompose lists to ground tickets in real modules, or null',
      ),
    maxModules: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(4)
      .describe('Implementation modules the planner may use; tickets that fit none are deferred'),
    verifyCommands: z
      .array(Argv)
      .min(1)
      .max(8)
      .describe(
        'Operator-selected argv commands that must pass on the integrated tree before it is published',
      ),
    dimensions: z
      .array(Dimension)
      .min(1)
      .max(5)
      .default([...Dimension.options])
      .describe('Review dimensions of each module’s deep-code-review'),
    maxFindings: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .describe('Findings per module review that get a skeptic; the rest are unchecked'),
    maxCalls: z
      .number()
      .int()
      .min(20)
      .max(400)
      .default(120)
      .describe(
        'Logical agent-call admissions, counted at each stage’s upper bound; also set --max-run-cost-usd for reported spend',
      ),
  })
  .refine(
    (input) => moduleLimit(input) >= 1,
    'maxCalls admits no module after the decomposition and the plan; raise it or lower dimensions or maxFindings',
  );
export type FeatureFactoryInput = z.infer<typeof FeatureFactoryInput>;

const Count = z.number().int().nonnegative();
export const Review = z.object({
  status: z.enum(['nothing-to-review', 'complete', 'degraded', 'limited', 'failed']),
  confirmed: Count,
  rejected: Count,
  unverified: Count,
  unchecked: Count,
  report: z.string().nullable().describe('The child’s report, or the failure when it failed'),
});
export const RepairRecord = z.object({
  status: z.enum(['repaired', 'unchanged', 'refused', 'failed']),
  summary: z.string(),
  unresolved: z.array(z.string()),
  outside: z.array(z.string()),
  commit: Sha.nullable(),
});
export const ModuleRecord = z.object({
  name: z.string(),
  foundation: z.boolean(),
  fileAreas: z.array(Area),
  tickets: z.array(TicketId),
  build: z.enum(['done', 'partial', 'blocked', 'failed', 'refused', 'unchanged', 'skipped']),
  summary: z.string().nullable(),
  blockers: z.array(z.string()),
  outside: z
    .array(z.string())
    .describe('Files the builder changed outside its areas, so its change was refused'),
  base: Sha.nullable().describe('The commit the builder started from'),
  commit: Sha.nullable().describe('The builder’s snapshot, integrated only when accepted'),
  files: z.array(z.string()),
  review: Review.nullable(),
  repair: RepairRecord.nullable(),
});
export type ModuleRecord = z.infer<typeof ModuleRecord>;

export const FeatureFactoryOutput = z.object({
  status: z
    .enum([
      'no-tickets',
      'declined',
      'nothing-built',
      'verification-failed',
      'degraded',
      'limited',
      'applied',
    ])
    .describe(
      'applied: every module built, reviewed and repaired, and the verified integration published; limited: published with deferred tickets or a capped review; degraded: published, but the backlog is not covered or a module, review or repair fell short; verification-failed: nothing published',
    ),
  backlog: z.object({
    status: z.string().describe('prd-decompose’s status'),
    tickets: z.array(z.object({ id: TicketId, title: z.string(), dependsOn: z.array(z.string()) })),
    sequencing: z.string().nullable(),
    openQuestions: z.array(z.string()),
    gaps: Count.describe('Coverage gaps of its last audit'),
  }),
  limits: z.object({
    modules: z.number().int().min(1).describe('Modules the call cap and maxModules admit'),
    callsAdmitted: Count.describe('Upper bound of the agent calls admitted so far'),
  }),
  plan: Plan.extend({ digest: Digest }).nullable(),
  modules: z.array(ModuleRecord),
  integrated: Sha.nullable().describe('The integration commit, kept on a run-owned ref'),
  commit: Sha.nullable().describe('The commit published to the checkout'),
  verification: z.array(Check),
});
export type FeatureFactoryOutput = z.infer<typeof FeatureFactoryOutput>;

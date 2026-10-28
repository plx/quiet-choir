// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

/**
 * The delivered work, pinned in code: the snapshot every checker reads and the base it is judged
 * from. A snapshot commit has no ref of its own; the workflow's 'snapshot' worktree handle pins it
 * under the run's refs/quiet-choir namespace as soon as it exists.
 */
export const Pinned = z.object({
  head: Sha,
  snapshot: Sha.describe(
    'HEAD, or a commit of the working tree with its uncommitted changes, pinned by the run',
  ),
  base: Sha.describe('The commit (or empty tree) the delivered change is measured from'),
  uncommitted: z.boolean(),
});
export type Pinned = z.infer<typeof Pinned>;
export const ChangedFile = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/**
 * Schema bounds on one decomposition, well above maxCriteria's ceiling so that the input cap, which
 * is reported, does the capping; the decompose prompt states them.
 */
export const limits = { criteria: 60, implied: 30, checks: 12 } as const;
export const Kind = z.enum(['behavior', 'ui', 'api', 'data', 'performance', 'error-handling']);
export const Criterion = z.object({
  criterion: z.string().min(1).describe('One acceptance criterion, verbatim or normalized'),
  checks: z
    .array(z.string().min(1))
    .min(1)
    .max(limits.checks)
    .describe('Binary, verifiable sub-checks that together prove the criterion'),
  kind: Kind,
});
export const Decomposition = z.object({
  criteria: z.array(Criterion).max(limits.criteria),
  impliedCriteria: z
    .array(z.string().min(1))
    .max(limits.implied)
    .describe(
      'Criteria the ticket clearly intends but did not spell out (empty states, error paths, permissions)',
    ),
});
export type Decomposition = z.infer<typeof Decomposition>;
/** A criterion on the checklist: stated, or implied and flagged. */
export const Planned = Criterion.extend({ implied: z.boolean() });
export type Planned = z.infer<typeof Planned>;

export const Outcome = z.enum(['holds', 'fails', 'cannot-verify']);
const SubResult = z.object({
  outcome: Outcome,
  evidence: z
    .string()
    .min(1)
    .describe('What in the actual code or command output shows it: file:line or quoted output'),
});
/** One result per sub-check, in the order given; the criterion's status is computed in code. */
export const CheckReport = (count: number) =>
  z.object({ results: z.array(SubResult).length(count) });
export const SubCheck = SubResult.extend({ check: z.string() });
export type SubCheck = z.infer<typeof SubCheck>;

export const Challenge = z.object({
  honest: z
    .boolean()
    .describe("True if the pass satisfies the criterion's intent, not just its letter"),
  reasoning: z.string().min(1),
  gotcha: z.string().nullable().describe('The narrow or cheating way it passes, when not honest'),
});
export type Challenge = z.infer<typeof Challenge>;
/** One criterion's pipeline result: its checked sub-checks and, for a pass, the challenge. */
export const Checked = z.object({
  checks: z.array(SubCheck),
  challenge: Challenge.nullable(),
  challengeFailed: z.boolean(),
});
export type Checked = z.infer<typeof Checked>;

export const Status = z.enum([
  'pass',
  'fail',
  'partial',
  'cannot-verify',
  'fail-spirit',
  'unchallenged',
  'unchecked',
  'skipped',
]);
export type Status = z.infer<typeof Status>;
export const Graded = z.object({
  criterion: z.string(),
  kind: Kind,
  implied: z.boolean(),
  status: Status,
  checks: z.array(SubCheck).describe('Empty when the criterion was unchecked or skipped'),
  gotcha: z.string().nullable(),
});
export type Graded = z.infer<typeof Graded>;
export const Verdict = z.enum(['done', 'done-pending-manual', 'not-done', 'no-criteria']);
export type Verdict = z.infer<typeof Verdict>;
export const MustFix = z.object({ criterion: z.string(), why: z.string(), evidence: z.string() });
export const Pending = z.object({ criterion: z.string(), why: z.string() });

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;
/** A command's result as the checkers see it, its retained output included. */
export const Ran = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  failure: z.string().nullable(),
  truncated: z.boolean(),
  output: z.string(),
});
export type Ran = z.infer<typeof Ran>;

export const AcceptanceInput = z
  .object({
    criteria: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('The acceptance criteria as text; give this or criteriaFile'),
    criteriaFile: Path.nullable()
      .default(null)
      .describe('A repository-relative ticket file holding the criteria, read by the workflow'),
    ticket: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Fuller ticket context: the goal and non-goals'),
    base: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        'Revision the delivered work started from; default HEAD when the tree has uncommitted changes, else the latest commit',
      ),
    paths: z.array(Path).max(50).default([]).describe('Limit the delivered change to these paths'),
    checkCommands: z
      .array(Argv)
      .max(8)
      .default([])
      .describe(
        'Operator-selected argv commands run on the snapshot; every checker sees the output',
      ),
    maxCriteria: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(12)
      .describe('Stated, then implied, criteria to check; the rest are reported as skipped'),
    maxPatchBytes: z.number().int().min(4096).max(1_000_000).default(100_000),
  })
  .refine(
    (input) => (input.criteria === null) !== (input.criteriaFile === null),
    'Give exactly one of criteria or criteriaFile',
  );

export const AcceptanceOutput = Pinned.extend({
  status: z
    .enum(['complete', 'degraded', 'limited', 'no-criteria'])
    .describe('degraded: a checker or challenger failed; limited: criteria past maxCriteria'),
  verdict: Verdict,
  files: z.array(ChangedFile),
  patchTruncated: z.boolean(),
  commands: z.array(Check),
  criteria: z.array(Graded),
  mustFix: z.array(MustFix),
  pendingManual: z.array(Pending).describe('What needs a human or a running environment, and why'),
  summary: z.string(),
  summarySource: z
    .enum(['narrator', 'code'])
    .describe('code: the narrator failed (or had nothing to narrate) and code wrote the summary'),
});

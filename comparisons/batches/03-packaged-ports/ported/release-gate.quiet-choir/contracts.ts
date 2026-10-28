// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

/** The six readiness dimensions; code owns `tests`, read-only assessors the other five. */
export const Dimension = z.enum([
  'tests',
  'coverage-on-diff',
  'breaking-changes',
  'security',
  'migrations-rollback',
  'performance',
]);
export type Dimension = z.infer<typeof Dimension>;
export const Assessed = Dimension.exclude(['tests']);
export type Assessed = z.infer<typeof Assessed>;

export const Assessment = z.object({
  status: z.enum(['pass', 'concern', 'blocker', 'not-applicable', 'cannot-check']),
  evidence: z
    .string()
    .min(1)
    .describe('What was read and what it showed: diff facts, files and lines, quoted output'),
  findings: z.array(z.string().min(1)).max(10),
});
export const Confirmation = z.object({
  verdict: z
    .enum(['confirmed', 'concern', 'not-a-problem'])
    .describe('confirmed only if shipping with this is genuinely wrong'),
  reasoning: z.string().min(1),
});

export const Decision = z.enum(['go', 'conditional-go', 'no-go']);
export type Decision = z.infer<typeof Decision>;
export type Allowed = readonly [Decision, ...Decision[]];
/** The gatekeeper may only choose a decision the code-owned gate rule allows. */
export const DecisionFor = (allowed: Allowed) =>
  z
    .object({
      decision: z.enum(allowed),
      conditions: z
        .array(z.string().min(1))
        .max(8)
        .describe('What must be true before shipping; required for conditional-go'),
      rationale: z.string().min(1).describe('A rationale a release manager can forward'),
    })
    .refine(
      (value) => value.decision !== 'conditional-go' || value.conditions.length > 0,
      'conditional-go needs at least one condition',
    );

/** One operator command's outcome; output text stays in the run record, not the result. */
export const Run = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  failure: z
    .string()
    .nullable()
    .describe('The settled failure kind (timeout, process); null when it exited'),
  error: z.string().nullable().describe('The settled failure message; null when it exited'),
  truncated: z
    .boolean()
    .describe('Output was cut before code saw it: the capture overflowed, or only a tail was kept'),
});
export type Run = z.infer<typeof Run>;
export const TestCheck = Run.extend({
  rerun: Run.nullable().describe('The one rerun of a command that started and did not pass'),
  verdict: z
    .enum(['pass', 'flaky', 'failed', 'unfinished', 'not-run'])
    .describe(
      'failed: failed on a run (a nonzero exit or a crash) and never passed; flaky: failed, then passed on its rerun; unfinished: it timed out and its rerun neither passed nor failed; not-run: it could not start',
    ),
});
export type TestCheck = z.infer<typeof TestCheck>;
export const EvidenceRun = Run.extend({
  dimension: Assessed,
  clipped: z.boolean().describe('Output past the prompt excerpt was not shown to the assessor'),
});

export const Status = z.enum([
  'pass',
  'concern',
  'blocker',
  'not-applicable',
  'cannot-check',
  'unassessed',
]);
export const Row = z.object({
  dimension: Dimension,
  source: z.enum(['code', 'assessor']),
  reported: Status.describe('What code or the assessor reported; unassessed when it failed'),
  status: Status.describe('What the gate used, after confirmation'),
  confirmation: z.enum(['confirmed', 'concern', 'not-a-problem', 'unconfirmed']).nullable(),
  evidence: z.string(),
  findings: z.array(z.string()),
  reasoning: z.string().nullable().describe("The confirmer's reasoning"),
});
export type Row = z.infer<typeof Row>;
export const Excerpt = z.object({
  text: z.string(),
  chars: z.int().nonnegative(),
  clipped: z.boolean(),
});
export type Excerpt = z.infer<typeof Excerpt>;
export const Rule = z.enum(['hard-block', 'held', 'clear']);
export type Rule = z.infer<typeof Rule>;

export const defaultPolicy =
  'Tests must pass; no unaddressed high-severity security findings; breaking changes must be documented; migrations must have a rollback.';

export const ReleaseGateInput = z.object({
  since: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exclusive starting revision; omitted, the nearest tag matching tagPattern that is not HEAD's own",
    ),
  tagPattern: z.string().min(1).default('*').describe('git describe --match glob for release tags'),
  policy: z.string().min(1).default(defaultPolicy).describe('House rules every role applies'),
  blockOn: z
    .array(Dimension)
    .max(6)
    .default(['tests', 'security'])
    .describe('Dimensions whose blocker is a hard no-go'),
  testCommands: z
    .array(Argv)
    .max(8)
    .default([])
    .describe(
      'Operator-selected argv test commands run in the checkout; a failure is rerun once. Without one, tests is cannot-check, which rules out go while tests is in blockOn',
    ),
  evidenceCommands: z
    .array(z.object({ dimension: Assessed, argv: Argv }))
    .max(12)
    .default([])
    .describe(
      "Operator-selected argv commands whose output code hands to that dimension's assessor",
    ),
  commandTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(900_000)
    .describe('Deadline of each test or evidence command; a timeout is a recorded failure'),
  maxPatchChars: z
    .number()
    .int()
    .min(1000)
    .max(400_000)
    .default(100_000)
    .describe('Characters of the range log and of its patch each assessor and confirmer receives'),
});
export type ReleaseGateInput = z.infer<typeof ReleaseGateInput>;

export const ReleaseGateOutput = z.object({
  status: z.enum(['complete', 'limited', 'degraded', 'refused']),
  reason: z.string().nullable().describe('Why the gate refused to assess'),
  decision: Decision,
  decidedBy: z.enum(['gatekeeper', 'code']),
  allowed: z.array(Decision).min(1).describe('The decisions the code-owned gate rule allowed'),
  since: z.string().nullable(),
  start: Sha.nullable(),
  end: Sha.nullable(),
  manifest: z.array(Sha),
  blockOn: z.array(Dimension),
  dimensions: z.array(Row),
  blockers: z.array(
    z.object({
      dimension: Dimension,
      evidence: z.string(),
      findings: z.array(z.string()),
      hard: z.boolean(),
      confirmation: z.enum(['confirmed', 'unconfirmed']).nullable(),
    }),
  ),
  warnings: z.array(
    z.object({ dimension: Dimension, findings: z.array(z.string()), downgraded: z.boolean() }),
  ),
  unverified: z.array(Dimension).describe('Hard-block dimensions nobody could check'),
  tests: z.array(TestCheck),
  evidence: z.array(EvidenceRun),
  log: Excerpt.omit({ text: true }),
  patch: Excerpt.omit({ text: true }),
  rationale: z.string(),
  conditions: z.array(z.string()),
});
export type ReleaseGateOutput = z.infer<typeof ReleaseGateOutput>;

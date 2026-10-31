// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
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

export const Pressure = z.enum([
  'complexity',
  'duplication',
  'coupling',
  'long-method',
  'primitive-obsession',
  'god-object',
]);
export const Level = z.enum(['high', 'medium', 'low']);
export const Target = z.object({
  location: z.string().min(1).max(300).describe('A file, or file:function'),
  pressure: Pressure,
  evidence: z
    .string()
    .min(1)
    .describe('The measurable signal: a cyclomatic count, N duplicate sites, fan-in/out'),
  testability: z
    .enum(['well-tested', 'thinly-tested', 'untested'])
    .describe('How well the existing tests exercise this code'),
});
export type Target = z.infer<typeof Target>;
export const Survey = z.object({ targets: z.array(Target).max(12) });

const RankedFields = {
  refactoring: z
    .string()
    .min(1)
    .describe('The specific named refactoring: extract function, replace conditional with ...'),
  payoff: Level,
  risk: Level,
};
/** The ranker may only select surveyed locations; an empty selection means none is worth it. */
export const RankingFor = (targets: Target[], maxTargets: number) =>
  z.object({
    ranked: z
      .array(
        z.object({
          location: z.enum(targets.map((target) => target.location)),
          ...RankedFields,
        }),
      )
      .max(Math.min(maxTargets, targets.length)),
  });
/** A chosen target: the survey's evidence with the ranker's refactoring, payoff and risk. */
export const Chosen = Target.extend(RankedFields);
export type Chosen = z.infer<typeof Chosen>;

export const Net = z.object({
  status: z.enum(['pinned', 'cannot-pin']),
  netFile: Path.nullable().describe(
    'The new test file that pins the behavior; null for cannot-pin',
  ),
  supportFiles: z
    .array(Path)
    .max(10)
    .describe('Other new files the net reads, such as fixtures or golden files; often empty'),
  behaviorsPinned: z
    .array(z.string().min(1))
    .max(30)
    .describe('Observable behaviors the net now locks; at least one for a pinned net'),
  notes: z.string().describe('Why the behavior cannot be pinned, or anything the net leaves out'),
});
export type NetClaim = z.infer<typeof Net>;
export const Refactored = z.object({
  status: z.enum(['refactored', 'declined']),
  summary: z.string().min(1),
});
export const Review = z.object({
  structural: z.boolean().describe('True only if no change can alter observable behavior'),
  reasoning: z.string().min(1),
});

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;

export const RefactorInput = z
  .object({
    scope: z.string().min(1).default('the repository').describe('Repository area to survey'),
    goal: z
      .string()
      .min(1)
      .default('reduce complexity and duplication without changing behavior')
      .describe('What "better" means here: reduce coupling, kill duplication'),
    maxTargets: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(4)
      .describe('Ranked targets to pin and refactor; each costs a net and a refactor'),
    testCommand: Argv.describe(
      'Operator-selected argv that runs one test file when its repository-relative path is appended',
    ),
    netRounds: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(2)
      .describe('Net writes per target: the first, then repairs from the red output'),
    apply: z
      .boolean()
      .default(false)
      .describe(
        'Refactor behind green nets after a human approves the plan; report only otherwise',
      ),
    verifyCommands: z
      .array(Argv)
      .max(8)
      .default([])
      .describe(
        'Operator-selected argv commands that must pass on the nets commit before any refactor, after each refactor and on the integrated tree; at least one with apply',
      ),
  })
  .refine(
    (input) => !input.apply || input.verifyCommands.length > 0,
    'apply needs at least one verification command',
  );

/** One approved plan entry: the target, its refactoring and every file its net protects. */
const Planned = z.object({
  location: z.string(),
  refactoring: z.string(),
  netFile: z.string(),
  supportFiles: z.array(z.string()),
  behaviorsPinned: z.array(z.string()),
});
export const RefactorOutput = z.object({
  status: z.enum([
    'dirty-checkout',
    'no-targets',
    'no-nets',
    'baseline-red',
    'report',
    'declined',
    'verification-failed',
    'checkout-moved',
    'merge-refused',
    'nets-only',
    'applied',
  ]),
  refactored: z.array(
    Planned.extend({
      commit: Sha.describe('The run-owned snapshot of this refactor'),
      files: z.array(z.string()),
      review: z.string(),
      reviewedWhole: z
        .boolean()
        .describe('False when the reviewer saw a truncated diff or net source'),
    }),
  ),
  netOnly: z.array(Planned.extend({ why: z.string() })),
  skipped: z.array(
    z.object({
      location: z.string(),
      refactoring: z.string(),
      why: z.string(),
      failed: z.boolean(),
    }),
  ),
  deferred: z.array(Target).describe('Surveyed targets the ranker did not choose'),
  duplicateTargets: z
    .number()
    .int()
    .nonnegative()
    .describe('Surveyed targets dropped because an earlier one had the same location'),
  failedNets: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative().describe('Refactor or review calls that failed'),
  truncatedRepairFiles: z
    .number()
    .int()
    .nonnegative()
    .describe('Previous net files a repair round was shown only in part'),
  netsCommit: Sha.nullable().describe('A run-owned commit holding every green net'),
  approvedDigest: Digest.nullable(),
  commit: Sha.nullable().describe(
    'The published HEAD; otherwise the unpublished run-owned commit to merge, on which every net and verify command passed (verification-failed: the red integration)',
  ),
  refusal: z
    .object({
      step: z.enum(['clean', 'integrate-nets', 'integrate', 'publish']),
      message: z.string(),
    })
    .nullable()
    .describe('What refused and why: a dirty checkout at the start, or a merge that failed'),
  baseline: z
    .array(Check)
    .describe('Every net and verify command on the nets commit, before any approval or refactor'),
  verification: z
    .array(Check)
    .describe('The publish gate: every net and verify command on the integrated tree'),
  summary: z.string(),
});
export type RefactorOutput = z.infer<typeof RefactorOutput>;

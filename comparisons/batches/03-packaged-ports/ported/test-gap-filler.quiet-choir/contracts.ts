// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

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
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});

export const Lens = z.enum(['coverage', 'risk']);
export const Gap = z.object({ key: z.string().min(1).max(80), reason: z.string().min(1) });
export type Gap = z.infer<typeof Gap>;
export const Gaps = z.object({ gaps: z.array(Gap).max(12) });
/** The ranker may only select discovered gap keys. */
export const RankingFor = (gaps: Gap[], maxGaps: number) =>
  z.object({
    selected: z
      .array(z.enum(gaps.map((gap) => gap.key)))
      .min(1)
      .max(Math.min(maxGaps, gaps.length)),
  });

export const Mutant = z.object({
  id: z.string().min(1).max(80),
  before: z.string().min(1),
  after: z.string(),
  reason: z.string().min(1),
});
export type Mutant = z.infer<typeof Mutant>;
export const TestPlanFor = (maxMutants: number) =>
  z.object({ test: z.string().min(1), mutants: z.array(Mutant).min(1).max(maxMutants) });
export const MutationResult = z.object({
  id: z.string(),
  killed: z.boolean(),
  code: z.number().int(),
  restoredSha256: Digest,
});

export const TestGapInput = z.object({
  target: Path.describe('Existing UTF-8 source file whose behavior needs tests'),
  testFile: Path.describe('New test file; existing unrelated content is never overwritten'),
  testCommand: Argv.describe('Operator-selected argv command that must pass before mutation'),
  behavior: z.string().min(1).describe('Behavior or coverage gap to exercise'),
  maxGaps: z.number().int().min(1).max(6).default(3),
  maxMutants: z.number().int().min(1).max(12).default(4),
});

export const TestGapOutput = z.object({
  status: z.enum(['no-gaps', 'baseline-failed', 'covered', 'gaps-remain']),
  baselineCode: z.number().int().nullable(),
  pristineSha256: Digest,
  test: Receipt.nullable(),
  selected: z.array(z.string()),
  mutations: z.array(MutationResult),
  surviving: z.array(z.string()),
});

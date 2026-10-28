// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

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

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export const Bug = z.object({
  title: z.string().min(1),
  file: Path,
  line: z.number().int().min(1).optional(),
  severity: Severity,
  evidence: z.string().min(1),
  failureScenario: z.string().min(1),
});
export type Bug = z.infer<typeof Bug>;
export const BugList = z.object({ bugs: z.array(Bug).max(20) });
export const Verdict = z.object({ refuted: z.boolean(), reasoning: z.string().min(1) });
export type Verdict = z.infer<typeof Verdict>;

export const Finding = z.object({
  bug: Bug,
  outcome: z.enum(['confirmed', 'refuted', 'undecided']),
  upheld: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
});
export type Finding = z.infer<typeof Finding>;

export const BugHuntInput = z.object({
  scope: z.string().min(1).describe('Repository area to inspect'),
  maxRounds: z.number().int().min(1).max(8).default(4),
  votes: z.number().int().min(1).max(7).default(3),
  maxCalls: z
    .number()
    .int()
    .min(3)
    .max(200)
    .default(60)
    .describe(
      'Logical call admissions; also set --max-run-cost-usd for reported spend including failed attempts',
    ),
});

export const BugHuntOutput = z.object({
  status: z.enum(['complete', 'degraded', 'call-limit']),
  rounds: z.number().int().nonnegative(),
  dryRounds: z.number().int().nonnegative(),
  callsAdmitted: z.number().int().nonnegative(),
  failedFinders: z.number().int().nonnegative(),
  failedSkeptics: z.number().int().nonnegative(),
  skippedSkeptics: z.number().int().nonnegative(),
  undecided: z.number().int().nonnegative(),
  findings: z.array(Finding),
});

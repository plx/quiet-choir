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
/** A Git glob pathspec without magic, relative to the working directory. */
export const Glob = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => !value.startsWith(':') && !value.startsWith('/') && !value.includes('\0'),
    'Use a glob relative to the working directory, without pathspec magic',
  );

/** The three blind evidence sources; each sweeper sees one. */
export const Modality = z.enum(['history', 'smells', 'ci']);
export type Modality = z.infer<typeof Modality>;
export const Found = z.object({
  test: z.string().min(1).max(200).describe('Test name as the runner sees it'),
  file: Path.describe('Test file, relative to the working directory'),
  evidence: z
    .string()
    .min(1)
    .describe('The specific smell, commit or artifact behind the suspicion'),
});
export type Found = z.infer<typeof Found>;
export const maxFound = 20;
export const Suspects = z.object({ suspects: z.array(Found).max(maxFound) });

/** The history facts code reads for the history sweeper: flake mentions and test-file churn. */
export const History = z.object({
  scanned: z.int().nonnegative(),
  mentions: z.array(
    z.object({
      sha: z.string(),
      date: z.string(),
      subject: z.string(),
      body: z.string().nullable().describe('The message body on one line, cut short'),
      files: z.array(z.string()),
      unlistedFiles: z.int().nonnegative(),
      patch: z.string().nullable().describe("The commit's test-file diff, cut short"),
    }),
  ),
  unlistedMentions: z.int().nonnegative(),
  churn: z.array(z.object({ path: z.string(), changes: z.int().positive() })),
});
export type History = z.infer<typeof History>;
export const Artifacts = z.object({ paths: z.array(z.string()), unlisted: z.int().nonnegative() });

/** A suspect merged across modalities, with each modality's evidence kept apart. */
export const Suspect = z.object({
  test: z.string(),
  file: z.string(),
  evidence: z.array(z.object({ modality: Modality, evidence: z.string() })).min(1),
  corroboration: z.number().int().min(1).max(3),
});
export type Suspect = z.infer<typeof Suspect>;
export const Rejected = Suspect.extend({
  reason: z.enum(['untracked-file', 'not-a-test-file', 'unsafe-test-name']),
});
export type Rejected = z.infer<typeof Rejected>;

/** One stress run as code observed it: the exit code, or the settled failure's kind. */
export const Run = z.object({
  outcome: z.enum(['pass', 'fail', 'timeout', 'signal', 'error']),
  code: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type Run = z.infer<typeof Run>;
export const Verdict = z.enum(['flaky', 'stable', 'always-fails', 'could-not-run']);
export const Stress = z.object({
  argv: Argv,
  runs: z.number().int().nonnegative().describe('Runs made; an unrunnable command stops at one'),
  failures: z.number().int().nonnegative(),
  verdict: Verdict,
  outcomes: z.array(Run),
  sample: z.string().nullable().describe('Output tail of the first failing run'),
  medianPassMs: z.number().int().nullable(),
  medianFailMs: z.number().int().nullable(),
});
export type Stress = z.infer<typeof Stress>;
export const Stressed = Suspect.extend({ stress: Stress });
export type Stressed = z.infer<typeof Stressed>;

export const Mechanism = z.enum([
  'shared-state',
  'timing-timeout',
  'async-race',
  'external-dependency',
  'random-data',
  'resource-exhaustion',
  'test-order-dependence',
  'clock-dependence',
  'unknown',
]);
export const Diagnosis = z.object({
  mechanism: Mechanism,
  explanation: z.string().min(1).describe('The causal story: why it fails only sometimes'),
  proposedFix: z
    .string()
    .min(1)
    .describe('A real fix; retry-wrapping only if the flake is genuinely external'),
  confidence: z.enum(['high', 'medium', 'low']),
  files: z.array(Path).min(1).max(6).describe('Every file the proposed fix changes'),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
export const Flake = Stressed.extend({ diagnosis: Diagnosis.nullable() });
export type Flake = z.infer<typeof Flake>;

/** One approved fix, in the order the fixer receives it. */
export const PlanItem = z.object({
  test: z.string(),
  file: z.string(),
  mechanism: Mechanism,
  proposedFix: z.string(),
  files: z.array(z.string()),
});
export type PlanItem = z.infer<typeof PlanItem>;
export const Fixed = z.object({ summary: z.string() });
export const Untouched = z.object({ test: z.string(), file: z.string() });
export const Restressed = z.object({ test: z.string(), file: z.string(), stress: Stress });
export type Restressed = z.infer<typeof Restressed>;

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;

/** Test files by the common naming conventions; an operator narrows them with testFiles. */
export const defaultTestFiles = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  '**/test_*.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
] as const;

export const FlakyInput = z
  .object({
    scope: z
      .string()
      .min(1)
      .default('the test suite of this repository')
      .describe('Test area the sweepers search'),
    testCommand: Argv.describe(
      'Operator-selected argv that runs one test without a shell; {file} and {test} in any argument become the suspect file and test name',
    ),
    runs: z.number().int().min(2).max(50).default(8).describe('Stress runs per suspect'),
    maxSuspects: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe('Suspects stress-run, corroborated first; the rest are reported as skipped'),
    fix: z
      .boolean()
      .default(false)
      .describe('Apply the diagnosed fixes after a human approves them; report only otherwise'),
    fixRuns: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe('Re-stress runs per fixed test, all of which must pass'),
    verifyCommands: z
      .array(Argv)
      .max(8)
      .default([])
      .describe('Operator-selected argv commands that must also pass before fixes are published'),
    testFiles: z
      .array(Glob)
      .min(1)
      .max(20)
      .default([...defaultTestFiles])
      .describe(
        "Git globs a suspect's file must match before the test command runs it; they also pick the test files whose churn and diffs the history sweeper sees",
      ),
    runTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(1_800_000)
      .default(120_000)
      .describe('Deadline of one stress run; a run past it counts as a timeout failure'),
    historyDepth: z
      .number()
      .int()
      .min(10)
      .max(2_000)
      .default(300)
      .describe('Commits of history scanned for flake mentions and test churn'),
  })
  .refine(
    (input) => input.testCommand.some((arg) => arg.includes('{file}') || arg.includes('{test}')),
    'testCommand needs a {file} or {test} placeholder, or every suspect runs the same command',
  );

export const FlakyOutput = z.object({
  status: z.enum([
    'sweeps-failed',
    'no-suspects',
    'no-flakes',
    'report',
    'declined',
    'refused',
    'incomplete',
    'fix-failed',
    'fixed',
  ]),
  commit: Sha.describe('The commit every flake rate was measured at'),
  noEvidence: z
    .array(Modality)
    .describe('Sources code found no evidence in, so no sweeper was asked'),
  failedSweeps: z.array(Modality),
  rejected: z.array(Rejected),
  skipped: z.array(Suspect).describe('Suspects past maxSuspects, never stress-run'),
  confirmed: z.array(Flake),
  cleared: z.array(Stressed),
  broken: z.array(Stressed),
  unrunnable: z.array(Stressed),
  undiagnosed: z.number().int().nonnegative(),
  residue: z.array(z.string()).describe('git status lines the stress runs left behind'),
  approvedDigest: Digest.nullable(),
  fixCommit: Sha.nullable(),
  refusedFiles: z.array(z.string()),
  untouched: z.array(Untouched).describe('Approved fixes whose files the fixer did not change'),
  restress: z.array(Restressed),
  verification: z.array(Check),
});
export type FlakyOutput = z.infer<typeof FlakyOutput>;

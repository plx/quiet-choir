// Data contracts: the input and output schemas and the structured agent results. The input is a
// pinned revision range and a pathspec list, and the output is typed findings, so feature-factory
// can run this workflow per module as a typed inline child.
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
/** A plain Git pathspec: a directory, file or glob, never pathspec magic such as `:(exclude)`. */
export const Pathspec = Path.refine((value) => !value.startsWith(':'), 'Pathspec magic is refused');

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;
export const Dimension = z.enum(['correctness', 'security', 'performance', 'tests', 'api-design']);
export type Dimension = z.infer<typeof Dimension>;

/** A changed file with its added and deleted line counts; both are null for a binary file. */
export const ChangedFile = z.object({
  path: z.string().min(1),
  added: z.number().int().nonnegative().nullable(),
  deleted: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const ScopeSummary = z.object({
  summary: z.string().min(1).describe('Two to four sentences on what the change does'),
  riskNotes: z
    .string()
    .min(1)
    .nullable()
    .describe('Anything unusually risky a reviewer should weight, or null'),
});

export const Finding = z.object({
  title: z.string().min(1),
  file: Path,
  line: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('The line at the reviewed head, or null for a whole-file finding'),
  severity: Severity,
  evidence: z.string().min(1).describe('The exact code and reasoning that support the claim'),
  failureScenario: z.string().min(1).describe('Concrete inputs or state, then the wrong outcome'),
});
export type Finding = z.infer<typeof Finding>;
export const Findings = z.object({ findings: z.array(Finding).max(20) });

/** A deduplicated finding: every dimension that reported it, the kept copy's first. */
export const Candidate = Finding.extend({
  dimensions: z.array(Dimension).min(1),
  absorbed: z.array(z.string()).describe('Titles of nearby findings merged into this one'),
});
export type Candidate = z.infer<typeof Candidate>;

export const Verdict = z.object({
  refuted: z.boolean(),
  reasoning: z.string().min(1),
  adjustedSeverity: Severity.nullable().describe('A new severity for a surviving claim, or null'),
});
export type Verdict = z.infer<typeof Verdict>;

/** A finding that survived its skeptic, at the skeptic's severity. */
export const Confirmed = Candidate.extend({ reportedSeverity: Severity, reasoning: z.string() });
export type Confirmed = z.infer<typeof Confirmed>;
/** A finding that was refuted, or whose skeptic failed; neither reaches the report. */
export const Dismissed = Candidate.extend({ why: z.string() });
export type Dismissed = z.infer<typeof Dismissed>;

export const DeepCodeReviewInput = z.object({
  base: z
    .string()
    .min(1)
    .default('HEAD~1')
    .describe('Revision to review against; the review covers merge-base(base, head)..head'),
  head: z
    .string()
    .min(1)
    .default('HEAD')
    .describe('Committed revision under review; reviewers read a pinned snapshot of it'),
  paths: z
    .array(Pathspec)
    .max(50)
    .default([])
    .describe('Pathspecs limiting the review, such as a module; empty reviews every changed file'),
  dimensions: z
    .array(Dimension)
    .min(1)
    .max(5)
    .default([...Dimension.options])
    .describe('Review dimensions to run, one dedicated reviewer each'),
  maxChangedLines: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(3_000)
    .describe('Changed-line budget of the patch reviewers read; files past it are unreviewedFiles'),
  maxFindings: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Deduplicated findings that get a skeptic; the rest are reported as unchecked'),
});
export type DeepCodeReviewInput = z.infer<typeof DeepCodeReviewInput>;

export const DeepCodeReviewOutput = z.object({
  status: z.enum(['nothing-to-review', 'complete', 'degraded', 'limited']),
  base: Sha.describe('The merge base the patch starts from'),
  head: Sha,
  files: z.array(ChangedFile).describe('Changed files the reviewers read'),
  unreviewedFiles: z.array(ChangedFile).describe('Changed files left out by maxChangedLines'),
  dimensions: z.array(Dimension).describe('Dimensions whose reviewer answered'),
  unreviewedDimensions: z.array(Dimension).describe('Dimensions whose reviewer failed'),
  rawFindings: z.number().int().nonnegative(),
  confirmed: z.array(Confirmed).describe('Verified findings, most severe first'),
  rejected: z.array(Dismissed),
  unverified: z.array(Dismissed).describe('Findings whose skeptic failed; never confirmed'),
  unchecked: z.array(Candidate).describe('Findings past maxFindings, never verified'),
  report: z.string(),
});
export type DeepCodeReviewOutput = z.infer<typeof DeepCodeReviewOutput>;

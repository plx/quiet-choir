// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
/** A repository-relative file path; one line, since code checks it with a line-based Git batch. */
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
      !/[\0\n\r]/u.test(value),
    'Use a repository-relative path without dot segments, .git or line breaks',
  );

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;
export const Lens = z.enum([
  'injection',
  'auth',
  'secrets',
  'supply-chain',
  'crypto-storage',
  'request-forgery',
]);
export type Lens = z.infer<typeof Lens>;
export const Harness = z.enum(['claude', 'codex']);

export const Surface = z.object({
  entryPoints: z
    .array(z.string().min(1))
    .max(60)
    .describe('HTTP routes, CLI arguments, file and queue consumers, webhooks: where data enters'),
  trustBoundaries: z
    .array(z.string().min(1))
    .max(40)
    .describe('Where authentication and authorization decisions happen, and what each protects'),
  secretsHandling: z
    .array(z.string().min(1))
    .max(40)
    .describe('Where credentials, tokens or keys are read, stored or transmitted'),
  dependencies: z
    .array(z.string().min(1))
    .max(40)
    .describe('Security-relevant third-party dependencies (crypto, auth, parsers) with versions'),
  summary: z.string().min(1),
});
export type Surface = z.infer<typeof Surface>;

export const Finding = z.object({
  title: z.string().min(1),
  file: Path,
  line: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('The line at the audited revision, or null for a whole-file finding'),
  severity: Severity,
  evidence: z.string().min(1).describe('The exact code and reasoning that support the claim'),
  attackScenario: z
    .string()
    .min(1)
    .describe('Who can trigger it, from where, with what preconditions'),
  remediation: z.string().min(1).describe('A concrete fix, not "validate input"'),
});
export const Findings = z.object({ findings: z.array(Finding).max(20) });
/** A finding with the lens whose auditor reported it. */
export const LensFinding = Finding.extend({ lens: Lens });
export type LensFinding = z.infer<typeof LensFinding>;

export const Verdict = z.object({ refuted: z.boolean(), reasoning: z.string().min(1) });
export type Verdict = z.infer<typeof Verdict>;
/** One seat of a refutation panel and the harness that fills it. */
export const Seat = z.object({ seat: z.number().int().min(1).max(3), harness: Harness });
export type Seat = z.infer<typeof Seat>;

/** A finding after its panel: the seats it was owed, how many upheld it, and every answer. */
export const Judged = LensFinding.extend({
  outcome: z.enum(['confirmed', 'refuted', 'undecided']),
  seats: z.number().int().min(1).max(3),
  upheld: z.number().int().nonnegative(),
  failedSeats: z.number().int().nonnegative(),
  verdicts: z.array(Seat.extend(Verdict.shape)),
});
export type Judged = z.infer<typeof Judged>;
/** A finding code dismissed before any skeptic, because its file or line is absent. */
export const Unlocated = LensFinding.extend({ why: z.string() });
export type Unlocated = z.infer<typeof Unlocated>;
/** A lens whose pipeline item failed, with the failure kind and message. */
export const FailedLens = z.object({ lens: Lens, why: z.string() });
export type FailedLens = z.infer<typeof FailedLens>;

export const SecurityAuditInput = z.object({
  scope: z
    .string()
    .min(1)
    .max(500)
    .default('the entire repository')
    .describe(
      'What to audit, in the words auditors read: a service, a directory or the repository',
    ),
  lenses: z
    .array(Lens)
    .min(1)
    .max(6)
    .default([...Lens.options])
    .describe('Specialist lenses to run, one auditor each; they always run in their fixed order'),
  revision: z
    .string()
    .min(1)
    .default('HEAD')
    .describe('Committed revision to audit; every reader works in a snapshot of it'),
  maxFindingsPerLens: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe(
      'Located findings per lens that get a panel, most severe first; the rest are unchecked',
    ),
  crossHarness: z
    .boolean()
    .default(false)
    .describe('Seat a Codex skeptic second in every three-seat panel'),
});
export type SecurityAuditInput = z.infer<typeof SecurityAuditInput>;

export const SecurityAuditOutput = z.object({
  status: z.enum(['complete', 'degraded', 'limited']),
  revision: Sha.describe('The commit every reader audited'),
  surface: Surface,
  lenses: z.array(Lens).describe('Lenses whose pipeline item completed'),
  failedLenses: z.array(FailedLens).describe('Lenses whose sweep failed; their area is unaudited'),
  rawFindings: z.number().int().nonnegative(),
  confirmed: z
    .array(Judged)
    .describe('Findings a majority of their panel upheld, most severe first'),
  refuted: z.array(Judged),
  undecided: z
    .array(Judged)
    .describe('Findings whose failed seats left the majority open; never confirmed'),
  unlocated: z
    .array(Unlocated)
    .describe('Findings naming a file or line absent at the revision; never sent to a panel'),
  unchecked: z
    .array(LensFinding)
    .describe('Located findings past maxFindingsPerLens; never sent to a panel'),
  report: z.string(),
});
export type SecurityAuditOutput = z.infer<typeof SecurityAuditOutput>;

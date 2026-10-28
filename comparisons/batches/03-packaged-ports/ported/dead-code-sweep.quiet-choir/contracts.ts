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

export const Modality = z.enum(['exports', 'reachability', 'staleness']);
export const Candidate = z.object({
  identifier: z.string().min(1).describe('Function, class, file or dependency name'),
  file: Path,
  kind: z.enum(['function', 'class', 'file', 'dependency', 'branch', 'config']),
  evidence: z.string().min(1).describe('Why this looks dead'),
});
export type Candidate = z.infer<typeof Candidate>;
export const Candidates = z.object({ candidates: z.array(Candidate).max(30) });
/** A candidate with the number of modalities that found it. */
export const Swept = Candidate.extend({ modalities: z.number().int().min(1).max(3) });
export type Swept = z.infer<typeof Swept>;

export const Verdict = z.object({
  alive: z.boolean().describe('True if any plausible living reference exists'),
  reasoning: z.string().min(1),
  referenceFound: z.string().nullable().describe('Where the living reference is, if alive'),
});
export const Removed = z.object({ summary: z.string() });

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;

export const DeadCodeInput = z
  .object({
    scope: z.string().min(1).default('.').describe('Repository area to sweep'),
    apply: z
      .boolean()
      .default(false)
      .describe('Remove the confirmed-dead list after a human approves it; report only otherwise'),
    verifyCommands: z
      .array(Argv)
      .max(8)
      .default([])
      .describe('Operator-selected argv commands that must pass before a removal is published'),
    maxCandidates: z.number().int().min(1).max(50).default(20),
  })
  .refine(
    (input) => !input.apply || input.verifyCommands.length > 0,
    'apply needs at least one verification command',
  );

export const DeadCodeOutput = z.object({
  status: z.enum(['nothing-dead', 'report', 'declined', 'verification-failed', 'applied']),
  failedSweeps: z.number().int().nonnegative(),
  unchecked: z.array(Swept).describe('Candidates past maxCandidates, never cross-checked'),
  confirmedDead: z.array(Swept),
  kept: z.array(
    z.object({ identifier: z.string(), file: z.string(), why: z.string(), checked: z.boolean() }),
  ),
  approvedDigest: Digest.nullable(),
  commit: Sha.nullable(),
  verification: z.array(Check),
});

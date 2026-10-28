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

/** One discovered group, bounded for the discoverer. */
const Group = z.object({
  files: z
    .array(Path)
    .min(1)
    .max(10)
    .describe('Files migrated together: usually one, more only when they must change atomically'),
  siteCount: z.number().int().min(1).max(1000),
  notes: z.string().max(2000).nullable().describe('Anything unusual about these sites'),
});
export const Sites = z.object({
  groups: z.array(Group).max(300).describe('Disjoint file groups; no file in two groups'),
  unchanged: z
    .array(z.object({ file: Path, why: z.string().min(1).max(500) }))
    .max(500)
    .describe('Files that mention the old API but must keep it, each with why'),
});
export type Sites = z.infer<typeof Sites>;
/** A planned group: discovery's group after code coalesced overlaps, so it is unbounded. */
export const Planned = z.object({
  files: z.array(Path).min(1),
  siteCount: z.number().int().min(1),
  notes: z.string().nullable(),
});
export type Planned = z.infer<typeof Planned>;

export const Transformed = z.object({
  status: z.enum(['migrated', 'partial', 'blocked']),
  summary: z.string().min(1).max(2000),
  blockers: z
    .array(z.string().min(1).max(500))
    .max(50)
    .describe('Sites left on the old API, each with why'),
});
export const Cluster = z.object({
  description: z.string().min(1).max(2000).describe('One root cause and how it shows'),
  files: z.array(Path).max(20).describe('The files the cluster involves'),
});
export type Cluster = z.infer<typeof Cluster>;
export const Clusters = z.object({
  clusters: z.array(Cluster).max(10).describe('Distinct root causes, not one per failing test'),
});
export const Repaired = z.object({ summary: z.string().min(1).max(2000) });

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;
/** One verification pass over an integrated commit: the commands and the code search. */
export const Round = z.object({
  commit: Sha,
  checks: z.array(Check),
  leftovers: z.array(Path).describe('Files reported fully migrated that still mention the old API'),
  passed: z.boolean(),
});
export type Round = z.infer<typeof Round>;
/** A failing command as the triager and the repairers see it. */
export const Failure = z.object({
  command: z.string(),
  outcome: z.string().describe('exit 3, timeout, signal or truncated output'),
  output: z.string(),
});
export type Failure = z.infer<typeof Failure>;

export const MigrationInput = z.object({
  from: z.string().min(1).max(2000).describe('The old API, in plain language or as a signature'),
  to: z.string().min(1).max(2000).describe('The new API, in plain language or as a signature'),
  notes: z
    .string()
    .min(1)
    .max(20_000)
    .optional()
    .describe('Migration guide content, gotchas and edge-case rules'),
  paths: z
    .array(Path)
    .max(20)
    .default([])
    .describe('Repository-relative files or directories to limit discovery to; empty is all'),
  searchTerms: z
    .array(z.string().regex(/^[^\n\r\0]{1,200}$/u))
    .max(20)
    .default([])
    .describe(
      'Fixed strings that name the old API; code searches the base and the migrated files for them',
    ),
  verifyCommands: z
    .array(Argv)
    .min(1)
    .max(8)
    .describe(
      'Operator-selected argv commands (build, typecheck, tests) that must pass before publishing',
    ),
  batchSize: z.number().int().min(1).max(16).default(8).describe('Most migrators per wave'),
  maxGroups: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(40)
    .describe('Most file groups to plan; the rest are reported as deferred'),
});
export type MigrationInput = z.infer<typeof MigrationInput>;

export const GroupOutcome = z.object({
  files: z.array(Path),
  status: z.enum(['migrated', 'partial', 'blocked', 'refused', 'unchanged', 'failed']),
  summary: z.string(),
  blockers: z.array(z.string()),
});
export type GroupOutcome = z.infer<typeof GroupOutcome>;
export const ClusterOutcome = Cluster.extend({
  repair: z.enum(['applied', 'unchanged', 'refused', 'conflict', 'failed', 'skipped']),
  summary: z.string(),
});
export type ClusterOutcome = z.infer<typeof ClusterOutcome>;

export const MigrationOutput = z.object({
  status: z.enum([
    'nothing-to-migrate',
    'declined',
    'nothing-migrated',
    'verification-failed',
    'publish-failed',
    'unverified-publish',
    'partial',
    'migrated',
  ]),
  totalSites: z.number().int().nonnegative().describe('Expected sites across the planned groups'),
  coalesced: z.number().int().nonnegative().describe('Discovered groups merged for sharing a file'),
  stray: z.array(Path).describe('Paths discovery named that are not tracked in scope at the base'),
  deferred: z.array(z.array(Path)).describe('Groups past maxGroups, never approved or migrated'),
  unassigned: z.array(Path).describe('Search hits in no group and not excused'),
  excused: z.array(z.object({ file: Path, why: z.string() })),
  approvedDigest: Digest.nullable(),
  migrated: z.array(GroupOutcome),
  failed: z.array(GroupOutcome),
  unattempted: z.array(z.array(Path)).describe('Groups after an all-blocked wave stopped the run'),
  verification: z.array(Round).describe('The first pass and, after applied repairs, the second'),
  clusters: z.array(ClusterOutcome),
  commit: Sha.nullable().describe('The published commit, or the last integrated run-owned commit'),
  notes: z.string(),
});
export type MigrationOutput = z.infer<typeof MigrationOutput>;

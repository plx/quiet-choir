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

const Breaking = z.object({
  change: z.string().min(1).max(1000),
  affects: z.string().min(1).max(1000).describe('Which APIs or patterns this breaks'),
  migrationHint: z.string().max(2000).nullable().describe('The official migration hint, if any'),
});
export const Research = z.object({
  currentMajor: z
    .string()
    .min(1)
    .max(50)
    .describe('The installed major version, from the evidence'),
  targetVersion: z.string().min(1).max(100).describe('The exact version the upgrade targets'),
  breakingChanges: z.array(Breaking).max(60),
  migrationGuideUrl: z.string().max(500).nullable(),
  notes: z.string().max(4000).nullable(),
});
export type Research = z.infer<typeof Research>;

const UsageSite = z.object({
  file: Path,
  apis: z.array(z.string().min(1).max(200)).max(50).describe("Which of the package's APIs it uses"),
  heaviness: z.enum(['light', 'moderate', 'heavy']),
});
export const Impact = z.object({
  currentVersion: z
    .string()
    .min(1)
    .max(100)
    .describe('The exact installed version, from the lockfile'),
  usageSites: z.array(UsageSite).max(500),
  unrelated: z
    .array(z.object({ file: Path, why: z.string().min(1).max(500) }))
    .max(500)
    .describe('Listed files that mention the name without using the package'),
  indirectExposure: z
    .string()
    .max(2000)
    .nullable()
    .describe('Wrappers, adapters or re-exports that concentrate usage'),
});
export type Impact = z.infer<typeof Impact>;

export const RiskLevel = z.enum(['trivial', 'moderate', 'risky', 'reconsider']);
export const Plan = z.object({
  riskLevel: RiskLevel,
  steps: z.array(z.string().min(1).max(1000)).min(1).max(30).describe('Ordered, concrete steps'),
  riskNotes: z.string().min(1).max(4000).describe('Where this upgrade is most likely to break'),
  testFocus: z.array(z.string().min(1).max(500)).max(10).describe('Areas to scrutinize hardest'),
  files: z.array(Path).min(1).max(100).describe('Every file the upgrade may change'),
});
export type Plan = z.infer<typeof Plan>;

export const Applied = z.object({ summary: z.string().min(1).max(4000) });

export const Cluster = z.object({
  description: z.string().min(1).max(2000).describe('One root cause and how it shows'),
  files: z.array(Path).min(1).max(20).describe('The files a fix must change'),
});
export type Cluster = z.infer<typeof Cluster>;
export const Clusters = z.object({
  clusters: z.array(Cluster).max(10).describe('Distinct root causes, not one per failing test'),
});
export const Fixed = z.object({ summary: z.string().min(1).max(2000) });

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;
/** A failing command as the triager and the fixers read it. */
export const Failure = z.object({ command: z.string(), outcome: z.string(), output: z.string() });
export type Failure = z.infer<typeof Failure>;

export const ClusterOutcome = z.object({
  description: z.string(),
  files: z.array(Path).describe('The files its fixer owned, or the files it named'),
  fix: z.enum([
    'applied',
    'unchanged',
    'refused',
    'failed',
    'unowned',
    'deferred',
    'not-attempted',
  ]),
  summary: z.string(),
});
export type ClusterOutcome = z.infer<typeof ClusterOutcome>;
/** One verification of an integrated commit, and the triage and repair that followed it. */
export const Round = z.object({
  commit: Sha,
  install: Check.nullable(),
  checks: z.array(Check),
  passed: z.boolean(),
  triage: z
    .enum(['none', 'repair', 'report', 'failed'])
    .describe('none when green; report at the fix-round cap, with no fixers; failed if it failed'),
  clusters: z.array(ClusterOutcome),
});
export type Round = z.infer<typeof Round>;

export const UpgradeInput = z.object({
  package: z
    .string()
    .min(1)
    .max(214)
    .regex(/^\S+$/u)
    .describe('The dependency to upgrade, as the manifest names it'),
  toVersion: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .default(null)
    .describe('Target version or range; null researches the latest stable release'),
  maxFixRounds: z.number().int().min(0).max(5).default(3),
  manifests: z
    .array(Path)
    .min(1)
    .max(8)
    .default(['package.json', 'package-lock.json'])
    .describe('Manifest and lockfile paths: version evidence, and always changeable'),
  installCommand: Argv.nullable()
    .default(null)
    .describe(
      'Package-manager argv code runs in each verification checkout to refresh the lockfile',
    ),
  verifyCommands: z
    .array(Argv)
    .min(1)
    .max(8)
    .describe('Operator-selected build, typecheck and test argv commands that must all pass'),
  maxUsageFiles: z.number().int().min(1).max(500).default(200),
});
export type UpgradeInput = z.infer<typeof UpgradeInput>;

export const UpgradeOutput = z.object({
  status: z.enum([
    'not-attempted',
    'declined',
    'refused',
    'unchanged',
    'unstable',
    'base-moved',
    'upgraded',
  ]),
  package: z.string(),
  from: z.string(),
  to: z.string(),
  riskLevel: RiskLevel,
  riskNotes: z.string(),
  breakingChanges: z.array(Breaking),
  usage: z.object({
    sites: z.array(Path).describe('Files the analyst mapped as using the package'),
    unclassified: z.array(Path).describe('Code-found files the analyst neither mapped nor excused'),
    unmapped: z.array(Path).describe('Code-found files past maxUsageFiles, never analyzed'),
    evidenceOmitted: z.number().int().nonnegative(),
  }),
  approvedDigest: Digest.nullable(),
  rounds: z.number().int().nonnegative().describe('Verifications run'),
  verification: z.array(Round),
  remaining: z
    .array(z.string())
    .describe(
      'Plan steps not attempted; when unstable, the root causes of the last red round, or its failing commands when the triage named none',
    ),
  refusal: z.string().nullable(),
  commit: Sha.nullable(),
});
export type UpgradeOutput = z.infer<typeof UpgradeOutput>;

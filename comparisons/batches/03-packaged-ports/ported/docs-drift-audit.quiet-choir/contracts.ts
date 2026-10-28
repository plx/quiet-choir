// Data contracts: the input and output schemas and the structured agent results.
import { z, type WorktreeChange } from 'quiet-choir';

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
      // A control character (a newline in a file name, say) would break the Git listings.
      !/\p{Cc}/u.test(value) &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git'),
    'Use a repository-relative path without dot segments, control characters or .git',
  );
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());
/** One Git pathspec, magic included (`:(glob)**\/*.md`); it is passed after `--`. */
export const Pathspec = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !/\p{Cc}/u.test(value), 'A pathspec is one line without control characters');

/** A doc the workflow listed at the base commit, with up to three of its headings. */
export const Listed = z.object({ path: Path, headings: z.array(z.string()) });
export type Listed = z.infer<typeof Listed>;
export const Priority = z.enum(['high', 'medium', 'low']);
export type Priority = z.infer<typeof Priority>;
/** The librarian's answer, constrained to the paths the workflow listed. */
export const Classification = (paths: readonly [string, ...string[]]) =>
  z.object({
    docs: z
      .array(
        z.object({
          path: z.enum(paths),
          audience: z
            .string()
            .min(1)
            .max(120)
            .describe('Who reads this: end users, contributors, operators...'),
          priority: z
            .enum([...Priority.options, 'skip'])
            .describe(
              'high = wrong claims here actively hurt readers; skip = generated files and history',
            ),
        }),
      )
      .max(paths.length),
  });
export type Classified = z.infer<ReturnType<typeof Classification>>['docs'][number];
/** A doc chosen for the audit; a doc the librarian did not classify has null audience and priority. */
export const Chosen = z.object({
  path: Path,
  audience: z.string().nullable(),
  priority: Priority.nullable(),
});
export type Chosen = z.infer<typeof Chosen>;

export const ClaimKind = z.enum([
  'command',
  'path',
  'api',
  'config',
  'behavior',
  'example',
  'version',
]);
export const Claim = z.object({
  claim: z.string().min(1).max(500).describe('One atomic, checkable assertion the doc makes'),
  kind: ClaimKind,
  checkHint: z
    .string()
    .min(1)
    .max(500)
    .describe('How a checker would verify this against the repository'),
  quote: z
    .string()
    .min(1)
    .max(1000)
    .describe('The doc text making this claim, copied verbatim from the document'),
});
export type Claim = z.infer<typeof Claim>;
export const Claims = (max: number) =>
  z.object({
    claims: z.array(Claim).max(max),
    more: z.boolean().describe('True when the doc makes more checkable claims than were returned'),
  });

export const ClaimStatus = z.enum(['true', 'drifted', 'unverifiable']);
const Result = z.object({
  status: ClaimStatus,
  reality: z.string().min(1).describe('What the code actually does or has, with file evidence'),
  suggestedText: z
    .string()
    .min(1)
    .nullable()
    .describe('Replacement doc text when drifted; null otherwise'),
});
export type Result = z.infer<typeof Result>;
/** One result per claim, in the order given; code pairs them by position. */
export const CheckReport = (count: number) => z.object({ results: z.array(Result).length(count) });
export const Checked = Claim.extend(Result.shape);
export type Checked = z.infer<typeof Checked>;

export const Fixed = z.object({
  edits: z.array(z.string().min(1).max(300)).max(40).describe('A one-line summary per edit'),
});

/** A command's outcome; `failure` names a spawn failure, timeout or signal. */
export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;
/** An evidence command's result as the checkers see it, its retained output included. */
export const Ran = Check.extend({ outcome: z.string(), output: z.string() });
export type Ran = z.infer<typeof Ran>;

/** A changed file in a worktree receipt. */
const ChangedFile = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
});
/** What a fixer's isolated change does to its doc, judged in code from the receipt and the text. */
export const DocFix = z.object({
  status: z
    .enum(['changed', 'unchanged', 'refused', 'failed'])
    .describe('refused: the change touched another file; failed: the fixer call failed'),
  commit: Sha.nullable(),
  edits: z.array(z.string()),
  resolved: z.number().int().nonnegative().describe('Drifted claims whose quote is gone'),
  unresolved: z.array(z.string()).describe('Drifted claims whose quote is still in the doc'),
  collateral: z.array(z.string()).describe('Claims verified true whose quote the fix removed'),
  unexpected: z.array(ChangedFile).describe('Receipt entries other than an edit of the doc'),
  failure: z.string().nullable(),
});
export type DocFix = z.infer<typeof DocFix>;
/** One doc's pipeline result; `change` is an accepted fixer receipt, kept for integration. */
export type Pipeline = Pick<Audited, 'results' | 'unanchored' | 'capped' | 'fix'> & {
  change: WorktreeChange | null;
};

export const Audited = Chosen.extend({
  bytes: z.number().int().nonnegative(),
  results: z.array(Checked),
  unanchored: z
    .array(z.string())
    .describe('Claims whose quote is not in the doc, dropped before the check'),
  capped: z.boolean().describe('The extractor had more claims than maxClaims'),
  fix: DocFix.nullable(),
});
export type Audited = z.infer<typeof Audited>;
export const SkipReason = z.enum([
  'unsupported-path',
  'inventory-cap',
  'classified-skip',
  'max-docs',
  'too-large',
]);
export const Skipped = z.object({ doc: z.string(), reason: SkipReason });
export type Skipped = z.infer<typeof Skipped>;
export const Failed = z.object({
  doc: Path,
  step: z.string().nullable().describe('The step that failed, or null for the pipeline body'),
  error: z.string(),
});
export type Failed = z.infer<typeof Failed>;
export const Totals = z.object({
  docs: z.number().int().nonnegative(),
  claims: z.number().int().nonnegative(),
  drifted: z.number().int().nonnegative(),
  unverifiable: z.number().int().nonnegative(),
  fixed: z.number().int().nonnegative().describe('Drifted claims resolved in published docs'),
});
export const FixStatus = z.enum([
  'not-requested',
  'no-drift',
  'no-change',
  'verification-failed',
  'declined',
  'moved',
  'applied',
]);
export type FixStatus = z.infer<typeof FixStatus>;

const DEFAULT_PATHS = ['*.md', '*.mdx', '*.rst', '*.adoc', ':(glob)**/README*'];

export const DriftInput = z.object({
  paths: z
    .array(Pathspec)
    .min(1)
    .max(20)
    .default(DEFAULT_PATHS)
    .describe('Git pathspecs of the docs to audit at HEAD; changelogs are always excluded'),
  fix: z
    .boolean()
    .default(false)
    .describe(
      'Patch drifted docs in isolated checkouts and publish after a human approves the patch; report only otherwise',
    ),
  maxDocs: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Docs to audit, highest priority first; the rest are reported as skipped'),
  maxInventory: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe('Listed docs the librarian classifies, in path order; the rest are skipped'),
  maxClaims: z.number().int().min(1).max(80).default(40).describe('Claims extracted per doc'),
  maxDocBytes: z
    .number()
    .int()
    .min(1024)
    .max(1_000_000)
    .default(100_000)
    .describe('A larger doc is skipped as too-large'),
  evidenceCommands: z
    .array(Argv)
    .max(8)
    .default([])
    .describe('Operator-selected argv commands (a CLI --help, a config dump) every checker sees'),
  verifyCommands: z
    .array(Argv)
    .max(8)
    .default([])
    .describe('Operator-selected argv commands that must pass on the fixed docs before approval'),
});
export type DriftInput = z.infer<typeof DriftInput>;

export const DriftOutput = z.object({
  status: z
    .enum(['no-docs', 'complete', 'limited', 'degraded'])
    .describe(
      'limited: a cap skipped docs; degraded: a doc pipeline, an evidence command or the classification failed, or a claim list was capped',
    ),
  base: Sha.describe('The commit every doc and checker read'),
  listed: z.number().int().nonnegative().describe('Docs the pathspecs matched at the base'),
  docs: z.array(Audited),
  skipped: z.array(Skipped),
  failed: z.array(Failed),
  unclassified: z.array(Path).describe('Listed docs the librarian left out; ranked last'),
  evidence: z.array(Check),
  totals: Totals,
  fix: z.object({
    status: FixStatus.describe(
      'moved: the checkout left the base before publication, so the verified patch was not published',
    ),
    digest: Digest.nullable().describe('SHA-256 of the approved patch'),
    commit: Sha.nullable(),
    verification: z.array(Check),
  }),
});
export type DriftOutput = z.infer<typeof DriftOutput>;

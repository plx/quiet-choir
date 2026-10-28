// Data contracts: the input and output schemas and the structured agent results. The spec schema
// is built from the contested decision IDs, so a merged or repaired spec that lacks the required
// headings or leaves a decision unnamed is refused (and retried).
import { z } from 'quiet-choir';
import { structureProblems } from './lib/spec.js';

export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const isPath = (value: string) =>
  value.length > 0 &&
  value.length <= 500 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value
    .split('/')
    .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
  !value.includes('\0');
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(isPath, 'Use a repository-relative path without dot segments or .git');
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});

/** The five technical lenses, in the order they are drafted and listed. */
export const Lens = z.enum([
  'data-model',
  'api-contracts',
  'architecture',
  'edge-semantics',
  'operations',
]);
export type Lens = z.infer<typeof Lens>;
export const Stakes = z.enum(['load-bearing', 'moderate', 'reversible']);
export type Stakes = z.infer<typeof Stakes>;
export const Audit = z.enum(['implementability', 'fidelity']);
export type Audit = z.infer<typeof Audit>;
export const DecisionId = z.string().regex(/^D[1-9][0-9]?$/u);

const list = (meaning: string) => z.array(z.string().min(1)).max(15).describe(meaning);
export const Ground = z.object({
  summary: z.string().min(1).describe('The existing architecture in one paragraph'),
  conventions: list('Patterns the spec must respect: error handling, naming, layering'),
  integrationPoints: list('Where the new work attaches to existing code, naming the files'),
  constraints: list(
    'Realities the PRD may not know about: framework limits, load-bearing tech debt, performance walls',
  ),
});
export type Ground = z.infer<typeof Ground>;

const Drafted = z.object({
  heading: z.string().min(1).max(160),
  content: z.string().min(1).describe('Spec-grade markdown: concrete names, types and contracts'),
  prdAnchors: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe('The PRD requirements this section serves'),
});
const Raised = z.object({
  decision: z.string().min(1).max(300),
  options: z.array(z.string().min(1)).min(2).max(6),
  stakes: Stakes.describe(
    'load-bearing: the rest of the spec depends on it and it is expensive to reverse',
  ),
});
export type Raised = z.infer<typeof Raised>;
export const LensDraft = z.object({
  sections: z.array(Drafted).max(12),
  contestedDecisions: z
    .array(Raised)
    .max(6)
    .describe(
      'Choices with real alternatives this lens could not settle from the PRD and the code',
    ),
});
export type LensDraft = z.infer<typeof LensDraft>;
/** A drafted section with the lens that wrote it. */
export const Section = Drafted.extend({ lens: Lens });
export type Section = z.infer<typeof Section>;
/**
 * A contested decision with the ID code assigned after ranking by stakes, and every lens that
 * raised it (the same text from two lenses is one decision with their options combined).
 */
export const Contested = Raised.extend({
  id: DecisionId,
  // Unbounded: a decision two lenses raised carries both lenses' options.
  options: z.array(z.string().min(1)).min(2),
  lenses: z.array(Lens).min(1),
});
export type Contested = z.infer<typeof Contested>;

/** The merged or repaired spec, refused when its structure or its decision IDs are incomplete. */
export const SpecDocument = (ids: readonly string[]) =>
  z.object({
    spec: z
      .string()
      .min(1)
      .describe('The complete technical spec as markdown')
      .superRefine((spec, check) => {
        for (const message of structureProblems(spec, ids))
          check.addIssue({ code: 'custom', message });
      }),
  });

export const Gap = z.object({
  where: z.string().min(1).describe('The spec section or PRD requirement'),
  problem: z.string().min(1),
  fix: z.string().min(1),
});
export type Gap = z.infer<typeof Gap>;
/** An audit passes when it lists no gap; code derives the verdict. */
export const AuditReply = z.object({ gaps: z.array(Gap).max(30) });
export const AuditRecord = z.object({
  audit: Audit,
  completed: z.boolean().describe('False when the auditor failed, so its gaps are unknown'),
  gaps: z.array(Gap),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

export const TournamentStatus = z.enum([
  'complete',
  'degraded',
  'aborted',
  'unjudged',
  'refused',
  'failed',
]);
export const Tournament = z.object({
  decision: DecisionId.describe('The load-bearing decision the design-tournament child settled'),
  status: TournamentStatus.describe("The child's own status, or failed when the child failed"),
  winner: z
    .object({
      title: z.string(),
      philosophy: z.string(),
      avg: z.number().describe('Mean judge total out of 40'),
      tiedWith: z.array(z.string()),
    })
    .nullable(),
  adopted: z
    .boolean()
    .describe('True when the merger received the tournament design as authoritative'),
  failure: z.string().nullable(),
});
export type Tournament = z.infer<typeof Tournament>;

export const PrdToSpecInput = z
  .object({
    prd: z
      .string()
      .min(1)
      .refine(
        (value) => value.includes('\n') || isPath(value),
        'A single-line prd must be a repository-relative path; PRD text spans lines',
      )
      .describe(
        'The PRD text itself when it spans lines, else the repository-relative path of the PRD file',
      ),
    codebase: z
      .union([z.literal('greenfield'), z.literal('.'), Path])
      .default('.')
      .describe(
        "The directory whose tracked files ground the spec ('.' for the whole repository), or 'greenfield' to skip grounding",
      ),
    decideArchitecture: z
      .boolean()
      .default(false)
      .describe(
        'Settle the top contested decision with a design-tournament child when it is load-bearing (about eight more agent calls)',
      ),
    judges: z.number().int().min(1).max(7).default(3).describe("The tournament's judge panel size"),
    crossHarness: z
      .boolean()
      .default(false)
      .describe('Seat every second tournament judge on Codex'),
    out: Path.nullable()
      .default(null)
      .describe(
        'Create the spec here (an existing file refuses the run); when null, return it only',
      ),
    publication: z
      .enum(['file', 'commit'])
      .default('file')
      .describe('Create out as a file, or publish it as a managed commit for later stages'),
    maxPrdBytes: z
      .number()
      .int()
      .min(1_000)
      .max(500_000)
      .default(200_000)
      .describe('Largest PRD, inline or file, in bytes; a larger one is refused before any call'),
    maxCodebaseFiles: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .default(400)
      .describe('Most tracked files listed to the grounding agent; the output reports the total'),
  })
  .refine(
    (input) => !input.prd.includes('\n') || Buffer.byteLength(input.prd) <= input.maxPrdBytes,
    'Inline PRD text exceeds maxPrdBytes',
  );
export type PrdToSpecInput = z.infer<typeof PrdToSpecInput>;

export const PrdToSpecOutput = z.object({
  status: z
    .enum(['refused', 'undrafted', 'verified', 'repaired', 'degraded'])
    .describe(
      'verified: both audits read the final spec and found no gap; repaired: the audits found gaps and one repair revised the spec, which no audit has read since; degraded: a lens, an audit, the repair or a requested tournament failed or fell short; undrafted: no lens drafted a section, so nothing was merged; refused: out already exists, so no agent ran',
    ),
  prd: z.object({
    source: z.enum(['file', 'text']),
    path: Path.nullable(),
    sha256: Digest,
    bytes: z.number().int().nonnegative(),
  }),
  codebase: z
    .object({
      path: z.string(),
      files: z.number().int().nonnegative(),
      listed: z.number().int().nonnegative(),
    })
    .nullable()
    .describe(
      'Tracked files under the codebase directory and how many the grounder was shown; null for greenfield',
    ),
  grounding: Ground.nullable(),
  failedLenses: z.array(Lens),
  sections: z.number().int().nonnegative().describe('Spec sections the lenses drafted'),
  decisions: z.array(
    Contested.extend({
      settledBy: z
        .enum(['tournament', 'merger'])
        .nullable()
        .describe('Null when nothing was merged'),
    }),
  ),
  tournament: Tournament.nullable().describe(
    'Null when decideArchitecture is off or the top contested decision is not load-bearing',
  ),
  spec: z.string().nullable(),
  verification: z.object({
    audits: z.array(AuditRecord),
    repair: z
      .enum(['not-needed', 'applied', 'failed'])
      .describe(
        'One repair round runs when any audit found a gap; its revision is not audited again',
      ),
  }),
  openQuestions: z
    .array(z.string())
    .describe("The bullets of the final spec's Open questions section"),
  written: Receipt.nullable(),
});
export type PrdToSpecOutput = z.infer<typeof PrdToSpecOutput>;

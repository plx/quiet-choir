// Data contracts: the input and output schemas and the structured agent results. The PRD reply is
// built from the ids of the findings it may cite, so a requirement cannot trace to an unknown
// finding; code renders the reply as the document.
import { z } from 'quiet-choir';

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

export const Lens = z.enum(['user-needs', 'business', 'constraints', 'unknowns']);
export type Lens = z.infer<typeof Lens>;
export const Charter = z.enum(['ambiguity', 'scope', 'feasibility']);
export type Charter = z.infer<typeof Charter>;
export const Confidence = z.enum(['stated', 'implied', 'inferred']);
export const Severity = z.enum(['blocking', 'major', 'minor']);

/** The caps the extraction schema and the quote check enforce, which the Extract prompt states. */
export const extractCaps = {
  findings: 40,
  unknowns: 30,
  conflicts: 20,
  quoteChars: 400,
  quoteWords: 3,
} as const;
/** The issue cap of one critique, which the Attack prompt states. */
export const maxIssues = 25;

export const Extraction = z.object({
  findings: z
    .array(
      z.object({
        point: z.string().min(1).describe('One extracted requirement, goal or constraint'),
        quote: z
          .string()
          .min(1)
          .max(extractCaps.quoteChars)
          .nullable()
          .describe(
            'A short verbatim excerpt of the material or answers it comes from; null when inferred',
          ),
        confidence: Confidence,
      }),
    )
    .max(extractCaps.findings),
  unknowns: z
    .array(z.string().min(1))
    .max(extractCaps.unknowns)
    .describe('Things the material raises but does not answer'),
  conflicts: z
    .array(z.string().min(1))
    .max(extractCaps.conflicts)
    .describe('Places the material contradicts itself'),
});
export type Extraction = z.infer<typeof Extraction>;

/** A finding with the id and lens code assigned, the tier code kept and where its quote occurs. */
export const Finding = z.object({
  id: z.string(),
  lens: Lens,
  point: z.string(),
  quote: z.string().nullable(),
  claimed: Confidence.describe('The tier the lens claimed'),
  confidence: Confidence.describe(
    'The tier code kept: a stated or implied finding whose quote is not in the material is inferred',
  ),
  source: z
    .string()
    .nullable()
    .describe(
      'The material path, "text" for inline material, or "answers", where the quote occurs',
    ),
});
export type Finding = z.infer<typeof Finding>;

const text = z.string().min(1);
/** The writer's reply for a draft or a revision: the PRD's sections, traced to finding ids. */
export const PrdReply = (findingIds: readonly [string, ...string[]]) => {
  const cites = z.array(z.enum(findingIds)).max(12);
  return z.object({
    title: text.max(120),
    problem: text.describe('Problem and context, one or two paragraphs'),
    goals: z
      .array(
        z.object({
          goal: text,
          metric: text
            .nullable()
            .describe('How success is measured; null when the material gives no measure'),
        }),
      )
      .max(12),
    users: z.array(z.object({ user: text, job: text })).max(12),
    requirements: z
      .array(
        z.object({
          priority: z.enum(['must', 'should']),
          text,
          findings: cites.min(1).describe('The findings this requirement traces to'),
        }),
      )
      .min(1)
      .max(60),
    nonFunctional: z
      .array(z.object({ text, findings: cites.min(1) }))
      .max(30)
      .describe('Non-functional requirements, each traced to findings'),
    outOfScope: z.array(text).max(30),
    openQuestions: z
      .array(z.object({ question: text, consequences: text.describe('What the answer decides') }))
      .max(40),
    assumptions: z
      .array(
        z.object({
          text,
          findings: cites.describe(
            'The inferred findings it rests on; empty for your own decision',
          ),
        }),
      )
      .max(40),
  });
};
export type Prd = z.infer<ReturnType<typeof PrdReply>>;

export const Critique = z.object({
  issues: z
    .array(
      z.object({
        problem: text.describe('Quote the offending PRD text, then say what is wrong with it'),
        severity: Severity,
        fix: text.describe(
          'A concrete rewrite, a cut, or a question for the product owner; never "clarify this"',
        ),
      }),
    )
    .max(maxIssues),
});
export type Critique = z.infer<typeof Critique>;
/** A critic's issue with the charter that raised it. */
export const Issue = Critique.shape.issues.element.extend({ critic: Charter });
export type Issue = z.infer<typeof Issue>;

/** The product owner's answer to a question round; empty text keeps the questions open. */
export const Answers = z.object({
  answers: z.string().max(16_000).describe('Answers to the open questions; empty keeps them open'),
});

const OpenQuestion = z.object({ question: z.string(), consequences: z.string().nullable() });

export const RequirementsInput = z
  .object({
    input: z
      .union([
        z
          .string()
          .min(1)
          .refine(
            (value) => value.includes('\n') || isPath(value),
            'A single-line input must be a repository-relative path; raw material spans lines',
          ),
        z
          .array(Path)
          .min(1)
          .max(20)
          .refine((paths) => new Set(paths).size === paths.length, 'List each path once'),
      ])
      .describe(
        'The raw material itself when it spans lines, else a repository-relative file path or a list of them',
      ),
    product: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .default(null)
      .describe('One-line product context, such as "B2B invoicing SaaS, 200 customers"'),
    answers: z
      .string()
      .min(1)
      .max(16_000)
      .nullable()
      .default(null)
      .describe("Answers to a previous run's open questions, treated as stated requirements"),
    questionRounds: z
      .number()
      .int()
      .min(0)
      .max(3)
      .default(0)
      .describe(
        'Rounds that ask the open questions as a durable question and redo the PRD with the answers; 0 returns them, as upstream',
      ),
    out: Path.nullable()
      .default(null)
      .describe(
        'Write the PRD markdown here; an existing file is refused before any agent runs unless replace names it. null writes nothing',
      ),
    replace: Digest.nullable()
      .default(null)
      .describe(
        "The sha256 of the PRD at out that this run may replace, such as a previous run's written.sha256; null only creates out",
      ),
    publication: z
      .enum(['file', 'commit'])
      .default('file')
      .describe(
        'Write out as a file, or create it as a managed commit for later stages (which cannot replace)',
      ),
    maxMaterialBytes: z
      .number()
      .int()
      .min(1_000)
      .max(500_000)
      .default(200_000)
      .describe(
        'The byte limit of all the material together, and so of each file; larger material fails the run before any agent runs',
      ),
  })
  .refine(
    (input) =>
      typeof input.input !== 'string' ||
      !input.input.includes('\n') ||
      Buffer.byteLength(input.input) <= input.maxMaterialBytes,
    'Inline material exceeds maxMaterialBytes',
  )
  .refine(
    (input) => input.replace === null || (input.out !== null && input.publication === 'file'),
    "replace needs out and publication 'file': a managed commit only creates",
  );
export type RequirementsInput = z.infer<typeof RequirementsInput>;

/** The verdict on one drafting round. */
export const RoundStatus = z.enum(['complete', 'degraded', 'unrevised', 'empty']);
export type RoundStatus = z.infer<typeof RoundStatus>;

export const RequirementsOutput = z.object({
  status: z
    .enum(['complete', 'degraded', 'unrevised', 'empty', 'refused'])
    .describe(
      "The final round's verdict. complete: every lens and critic answered and the issues were revised; degraded: a lens or critic failed; unrevised: issues were raised, or every critic failed, and the draft stands; empty: no finding; refused: out exists and replace does not name it, so nothing ran. An earlier round's failures are in asked",
    ),
  material: z.array(
    z.object({
      source: z.enum(['file', 'text']),
      path: Path.nullable(),
      sha256: Digest,
      bytes: z.number().int().nonnegative(),
    }),
  ),
  rounds: z
    .number()
    .int()
    .min(0)
    .describe('Drafting rounds: the first plus one per answered question; 0 when refused'),
  answers: z.array(z.string()).describe('The answer sets the final round treated as stated'),
  asked: z.array(
    z
      .object({
        round: z.number().int().min(1),
        questions: z.number().int().min(1),
        answered: z.boolean(),
        status: RoundStatus,
        failedLenses: z.array(Lens),
        failedCritics: z.array(Charter),
      })
      .describe(
        'One question round: how many open questions it asked, whether they were answered, and the verdict and failures of the drafting round they came from',
      ),
  ),
  failedLenses: z.array(Lens).describe('The lenses of the final round that failed'),
  findings: z.array(Finding).describe("The final round's findings"),
  unknowns: z.array(z.string()),
  conflicts: z.array(z.string()),
  failedCritics: z.array(Charter).describe('The critics of the final round that failed'),
  issues: z.array(Issue).describe('The critique of the final round, most severe first'),
  revised: z.boolean(),
  prd: z.string().nullable().describe('The rendered PRD markdown, null when nothing was extracted'),
  assumptions: z.array(z.string()),
  addedAssumptions: z
    .array(z.string())
    .describe(
      'Inferred findings a requirement relied on that the writer left out; code added them',
    ),
  openQuestions: z.array(OpenQuestion),
  critiqueSummary: z.string().describe('The critique in one paragraph, or why nothing ran'),
  written: Receipt.nullable(),
});
export type RequirementsOutput = z.infer<typeof RequirementsOutput>;

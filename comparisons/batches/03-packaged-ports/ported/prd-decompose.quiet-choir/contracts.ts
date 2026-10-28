// Data contracts: the input and output schemas and the structured agent results. The merge and
// repair schemas are built from the ids they may name, so a reply cannot cite an unknown item or
// ticket, and their refinements keep tickets numbered in dependency order. The repair schema also
// takes the PRD, so a patch whose anchor code cannot find in it is refused (and retried).
import { z } from 'quiet-choir';
import { anchored } from './lib/anchors.js';

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

export const Lens = z.enum([
  'stories',
  'edges',
  'non-functional',
  'foundations',
  'instrumentation',
]);
export type Lens = z.infer<typeof Lens>;
export const Estimate = z.enum(['XS', 'S', 'M', 'L', 'XL']);
/** A ticket is at most L: the merger splits an XL item. */
export const TicketEstimate = z.enum(['XS', 'S', 'M', 'L']);
export const Lane = z.enum([
  'feature',
  'edge-cases',
  'non-functional',
  'infra-migration',
  'instrumentation',
]);
export const TicketId = z.string().regex(/^T[1-9][0-9]{0,2}$/u);

export const LensItem = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  prdAnchor: z
    .string()
    .min(1)
    .max(300)
    .describe('A short verbatim quote of the PRD sentence or heading this item traces to'),
  acceptanceCriteria: z.array(z.string().min(1)).max(12).describe('Testable statements'),
  estimate: Estimate,
});
export const LensReading = z.object({
  items: z.array(LensItem).max(25),
  openQuestions: z
    .array(z.string().min(1))
    .max(15)
    .describe('Ambiguities in the PRD this lens could not resolve or anchor'),
});
/** A lens item with the id code assigned and the lens that read it. */
export const Item = LensItem.extend({ id: z.string(), lens: Lens });
export type Item = z.infer<typeof Item>;

const prdAnchors = z
  .array(z.string().min(1).max(300))
  .min(1)
  .max(10)
  .describe('Verbatim PRD quotes this ticket traces to; mark a skipped stretch with "..."');
const ticketText = {
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(15).describe('Testable statements'),
  estimate: TicketEstimate,
};
/** A ticket as the merger writes it: code carries its source items' anchors onto it. */
const mergedShape = {
  id: TicketId,
  ...ticketText,
  lane: Lane,
  dependsOn: z.array(TicketId).max(20).describe('Ids of earlier tickets that block this one'),
};
export const Ticket = z.object({
  ...mergedShape,
  // Unbounded: a ticket that merges many items carries every one of their anchors.
  prdAnchors: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "PRD quotes code found in the PRD: the source items' anchors, or a repair's checked quotes",
    ),
  sources: z
    .array(z.string())
    .describe('Ids of the lens items merged into this ticket; empty for a ticket a repair added'),
});
export type Ticket = z.infer<typeof Ticket>;

/** Problems with ticket numbering and order: new tickets follow `existing` as T<n+1>, T<n+2>... */
export function orderProblems(
  tickets: readonly { id: string; dependsOn: readonly string[] }[],
  existing: readonly string[],
): string[] {
  const known = new Set(existing);
  return tickets.flatMap((ticket, index) => {
    const expected = `T${String(existing.length + index + 1)}`;
    const problems = [
      ...(ticket.id === expected ? [] : [`${ticket.id} should be numbered ${expected}`]),
      ...ticket.dependsOn
        .filter((dependency) => !known.has(dependency))
        .map(
          (dependency) => `${ticket.id} depends on ${dependency}, which is not an earlier ticket`,
        ),
      ...(new Set(ticket.dependsOn).size === ticket.dependsOn.length
        ? []
        : [`${ticket.id} repeats a dependency`]),
    ];
    known.add(ticket.id);
    return problems;
  });
}
const report = (check: z.RefinementCtx, problems: string[]) => {
  for (const message of problems) check.addIssue({ code: 'custom', message });
};

/** The merger's reply: every ticket cites the lens items it merges, in dependency order. */
export const MergeReply = (itemIds: readonly [string, ...string[]]) =>
  z
    .object({
      tickets: z
        .array(z.object({ ...mergedShape, sources: z.array(z.enum(itemIds)).min(1) }))
        .min(1)
        .max(60),
      sequencing: z
        .string()
        .min(1)
        .describe('The milestone grouping and what gates each milestone, one paragraph'),
      openQuestions: z.array(z.string().min(1)).max(30),
    })
    .superRefine((reply, check) => report(check, orderProblems(reply.tickets, [])));

export const Problem = z.enum(['missing', 'under-specified', 'wrong']);
const gapShape = {
  prdRequirement: z
    .string()
    .min(1)
    .describe('The PRD text, quoted verbatim, that no ticket adequately covers'),
  problem: Problem,
  suggestion: z.string().min(1),
};
export const Gap = z.object({ ...gapShape, ticket: TicketId.nullable() });
export type Gap = z.infer<typeof Gap>;
/** The critic's reply; coverage is decided from the gap list alone. */
export const Coverage = (ticketIds: readonly [string, ...string[]]) =>
  z.object({
    gaps: z
      .array(
        z.object({
          ...gapShape,
          ticket: z
            .enum(ticketIds)
            .nullable()
            .describe('The ticket that under-specifies or contradicts it; null when missing'),
        }),
      )
      .max(30),
  });

/** Problems with a patch's anchors: every quote must be one code finds in the PRD. */
const anchorProblems = (
  prd: string,
  tickets: readonly { id: string; prdAnchors: readonly string[] }[],
) =>
  tickets.flatMap((ticket) =>
    ticket.prdAnchors
      .filter((quote) => !anchored(prd, quote))
      .map((quote) => `${ticket.id}: the PRD anchor "${quote}" is not in the PRD`),
  );

/**
 * The repairer's patch: new tickets after the existing ones, complete text amendments, and a
 * revised sequencing paragraph or null; every anchor in it must be in the PRD.
 */
export const Repair = (ticketIds: readonly [string, ...string[]], prd: string) =>
  z
    .object({
      added: z.array(z.object({ ...mergedShape, prdAnchors })).max(20),
      amended: z
        .array(z.object({ id: z.enum(ticketIds), ...ticketText, prdAnchors }))
        .max(ticketIds.length),
      sequencing: z
        .string()
        .min(1)
        .nullable()
        .describe(
          'The revised sequencing paragraph when the patch changes the milestones, else null',
        ),
    })
    .superRefine((patch, check) =>
      report(check, [
        ...orderProblems(patch.added, ticketIds),
        ...anchorProblems(prd, [...patch.added, ...patch.amended]),
      ]),
    )
    .refine(
      (patch) =>
        new Set(patch.amended.map((amendment) => amendment.id)).size === patch.amended.length,
      'Amend each ticket at most once',
    );
export type Repair = z.infer<ReturnType<typeof Repair>>;

export const PrdDecomposeInput = z
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
      .union([z.literal('.'), Path])
      .nullable()
      .default(null)
      .describe(
        'Repository directory whose tracked files ground tickets in real modules, or null; a directory with no tracked file is refused',
      ),
    out: Path.nullable()
      .default(null)
      .describe('Create the backlog markdown at this new path; null writes nothing'),
    publication: z
      .enum(['file', 'commit'])
      .default('file')
      .describe('Create out as a file, or publish it as a managed commit for later stages'),
    maxRepairs: z
      .number()
      .int()
      .min(0)
      .max(2)
      .default(1)
      .describe('Repair rounds; each is followed by another coverage audit'),
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
      .describe('Most tracked files listed to the lenses; the output reports the total'),
  })
  .refine(
    (input) => !input.prd.includes('\n') || Buffer.byteLength(input.prd) <= input.maxPrdBytes,
    'Inline PRD text exceeds maxPrdBytes',
  );

export const PrdDecomposeOutput = z.object({
  status: z
    .enum(['covered', 'gaps-remain', 'unaudited', 'degraded', 'empty', 'unread'])
    .describe(
      'covered: the final backlog passed an audit; gaps-remain: the last audit found gaps or a repair failed; unaudited: the final backlog has no audit; degraded: a lens failed, with or without tickets; empty: every lens read the PRD and no item was anchored; unread: every lens failed, so no ticket says anything about the PRD',
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
    .describe('Tracked files under the codebase directory, and how many the lenses were shown'),
  failedLenses: z.array(Lens),
  tickets: z.array(Ticket),
  sequencing: z.string().nullable(),
  waves: z
    .array(z.array(TicketId))
    .describe('Tickets grouped by dependency depth: a wave needs only earlier waves'),
  criticalPath: z
    .object({ tickets: z.array(TicketId), days: z.number().nonnegative() })
    .nullable()
    .describe('The longest dependency chain by estimate (XS 0.5, S 1, M 2.5, L 5 days)'),
  coverage: z
    .object({
      audits: z.number().int().nonnegative(),
      repairs: z.number().int().nonnegative(),
      covered: z.boolean(),
      gaps: z.array(Gap).describe('Gaps of the last audit that no repair addressed'),
      repaired: z.array(Gap).describe('Gaps a repair addressed; verified only when covered'),
      failure: z.object({ stage: z.enum(['audit', 'repair']), message: z.string() }).nullable(),
    })
    .nullable(),
  openQuestions: z.array(z.string()),
  unanchored: z
    .array(z.object({ lens: Lens, title: z.string(), prdAnchor: z.string() }))
    .describe('Lens items whose quote code could not find in the PRD; never merged'),
  unmerged: z
    .array(z.object({ id: z.string(), lens: Lens, title: z.string() }))
    .describe('Anchored items no ticket cites as a source'),
  written: Receipt.nullable(),
});
export type PrdDecomposeOutput = z.infer<typeof PrdDecomposeOutput>;

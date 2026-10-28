// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);

/** Caps on agent answers. The prompts state each one: an answer over a cap fails validation. */
export const maxLeads = 20;
export const maxFindings = 20;
export const maxGaps = 10;

/** The four sweep territories; `local` runs only when the input gives a local context. */
export const Modality = z.enum(['web', 'source', 'practitioners', 'local']);
export type Modality = z.infer<typeof Modality>;
export const Kind = z.enum([
  'official-docs',
  'source-code',
  'issue-thread',
  'benchmark',
  'writeup',
  'discussion',
  'paper',
  'local-code',
]);
export const Credibility = z.enum(['primary', 'secondary', 'anecdotal']);
export type Credibility = z.infer<typeof Credibility>;

/** Where one source lives: enough for a reader to find it, and how much to trust it. */
export const Found = z.object({
  ref: z
    .string()
    .min(1)
    .max(500)
    .describe('URL, package name, file path or issue link: enough for a reader to find it'),
  kind: Kind,
  credibility: Credibility,
});
export const Lead = Found.extend({
  promise: z.string().min(1).describe('What this lead likely contains that answers the question'),
});
export type Lead = z.infer<typeof Lead>;
export const Leads = z.object({ leads: z.array(Lead).max(maxLeads) });
/** A lead after deduplication, with every modality that found it. */
export const Ranked = Lead.extend({ modalities: z.array(Modality).min(1) });
export type Ranked = z.infer<typeof Ranked>;

export const Finding = z.object({
  claim: z.string().min(1).describe('One specific fact or result relevant to the question'),
  support: z
    .string()
    .min(1)
    .describe('Where in the source this comes from: a section, code location or data point'),
  caveat: z.string().nullable().describe('Scope limits: version, scale, age of the information'),
});
export const Reading = z.object({
  useful: z.boolean().describe('False when the source is useless or inaccessible'),
  findings: z.array(Finding).max(maxFindings),
  contradicts: z
    .string()
    .nullable()
    .describe('Anything here that contradicts common belief or other likely sources'),
});
export type Reading = z.infer<typeof Reading>;
/** A hunt names the source it found, which code did not know beforehand; an empty hunt has none. */
export const Hunted = Reading.extend({
  source: Found.nullable().describe('The one source that best fills the gap; null when empty'),
}).refine((hunt) => !hunt.useful || hunt.source !== null, 'A useful hunt names its source');
export type Hunted = z.infer<typeof Hunted>;

/** A local hunt reads the pinned repository and nothing else; a web hunt cannot read it at all. */
export const Territory = z.enum(['web', 'local']);
export const Gap = z.object({
  gap: z.string().min(1).describe('What the answer is missing or asserts without evidence'),
  huntInstruction: z
    .string()
    .min(1)
    .describe('A targeted search or a specific document to read, not "search more"'),
  territory: Territory.describe('local only for this repository, when there is a local context'),
});
export type Gap = z.infer<typeof Gap>;
/** No gaps means adequate: code derives the verdict, so the two cannot disagree. */
export const Critique = z.object({ gaps: z.array(Gap).max(maxGaps) });

/** A reading that yielded findings, under the citation key the synthesizer uses. */
export const Source = Found.extend({
  id: z.string().regex(/^S\d+$/u),
  origin: z.enum(['lead', 'hunt']),
  findings: z.array(Finding),
  contradicts: z.array(z.string()),
});
export type Source = z.infer<typeof Source>;
export const HuntOutcome = z.enum(['found', 'empty', 'failed', 'unhunted']);
export const TrackedGap = Gap.extend({
  hunt: HuntOutcome,
  source: z.string().nullable().describe('The key of the source a successful hunt added to'),
});
export type TrackedGap = z.infer<typeof TrackedGap>;
export const CriticOutcome = z.enum(['adequate', 'gaps', 'failed', 'not-run']);
export type CriticOutcome = z.infer<typeof CriticOutcome>;
export const Confidence = z.enum(['high', 'moderate', 'low', 'none']);
export type Confidence = z.infer<typeof Confidence>;
export const Depth = z.enum(['quick', 'standard', 'deep']);
export type Depth = z.infer<typeof Depth>;
export const Unread = z.object({ ref: z.string(), outcome: z.enum(['failed', 'not-useful']) });
export type Unread = z.infer<typeof Unread>;

export const ResearchInput = z.object({
  question: z.string().min(1).max(4_000).describe('The research question'),
  context: z
    .string()
    .min(1)
    .max(4_000)
    .nullable()
    .default(null)
    .describe('Local grounding, such as "we run Postgres 14 and Django"; enables the local sweep'),
  depth: Depth.default('standard').describe('Leads deep-read: quick 4, standard 8, deep 14'),
});

export const ResearchOutput = z.object({
  status: z.enum(['answered', 'degraded', 'no-leads', 'no-findings']),
  answer: z.string().nullable().describe('Cited markdown with the source list appended'),
  confidence: Confidence,
  sources: z.array(Source),
  gaps: z.array(TrackedGap),
  critic: CriticOutcome,
  swept: z.array(Modality),
  unswept: z.array(Modality).describe('Sweeps that failed, so their territory went unsearched'),
  leadsFound: z.number().int().nonnegative(),
  deferred: z.array(Ranked).describe('Ranked past the depth cap and never read'),
  unread: z.array(Unread),
  unknownCitations: z.array(z.string()).describe('Keys the answer cites that no source has'),
  uncitedSources: z.array(z.string()),
  localCommit: Sha.nullable().describe('The commit the local roles read, pinned at the start'),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

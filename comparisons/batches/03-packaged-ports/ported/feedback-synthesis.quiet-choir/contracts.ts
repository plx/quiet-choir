// Data contracts: the input and output schemas and the structured agent results. The tagger and
// dive schemas are built per call from the item IDs and theme keys code handed out, so a reply
// can only name items and themes that exist.
import { z } from 'quiet-choir';

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

/** How a source file splits into items; code parses it, so every item is counted exactly once. */
export const Format = z.enum(['lines', 'blocks', 'jsonl', 'csv']);
export type Format = z.infer<typeof Format>;
export const Severity = z.enum(['none', 'churn-threat', 'data-loss', 'blocked-workflow', 'safety']);
export type Severity = z.infer<typeof Severity>;
/** The severe kinds; `none` is not severe. */
export const SEVERE = ['churn-threat', 'data-loss', 'blocked-workflow', 'safety'] as const;
export const ThemeKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,39}$/u)
  .describe('Stable lowercase slug, e.g. sync-reliability');

/** One feedback item as an agent sees it: code-assigned ID, the operator's fields, its text. */
export const PromptItem = z.object({
  id: z.string(),
  fields: z.string().nullable(),
  text: z.string(),
});
export type PromptItem = z.infer<typeof PromptItem>;
export const Theme = z.object({
  key: ThemeKey,
  definition: z
    .string()
    .min(1)
    .max(400)
    .describe('An inclusion rule precise enough that two taggers bucket an item the same way'),
});
export type Theme = z.infer<typeof Theme>;

export const Vocabulary = z.object({
  themes: z.array(Theme).min(3).max(16).describe('8-15 themes, including an "other" catch-all'),
});

type Keys = readonly [string, ...string[]];

/** A tagger's answer for one shard: every item once, verbatim quotes, emergent patterns. */
export const Tagged = (ids: Keys, keys: Keys) =>
  z.object({
    items: z
      .array(
        z.object({
          id: z.enum(ids),
          offFocus: z.boolean().describe('True only when a focus is given and the item misses it'),
          themes: z.array(z.enum(keys)).max(2).describe('One or two keys; none when off-focus'),
          severity: Severity,
        }),
      )
      .max(ids.length * 2),
    quotes: z
      .array(
        z.object({
          id: z.enum(ids),
          theme: z.enum(keys),
          text: z.string().min(1).max(400).describe('A verbatim excerpt of that item'),
        }),
      )
      .max(keys.length * 3),
    emergent: z
      .array(z.string().min(1).max(200))
      .max(5)
      .describe('Patterns stuck in "other" that deserve their own theme next run'),
  });
export type Tagged = z.infer<ReturnType<typeof Tagged>>;

/** A diver's answer: quotes name items from the dive's own list. */
export const Dive = (ids: Keys) =>
  z.object({
    storyline: z
      .string()
      .min(1)
      .describe('What is actually happening to users: the mechanism, one paragraph'),
    segments: z
      .string()
      .min(1)
      .nullable()
      .describe('Who is affected (plan, platform, tenure) when the items show it; else null'),
    recommendation: z.string().min(1).describe('The single highest-leverage product action'),
    quotes: z
      .array(z.object({ id: z.enum(ids), text: z.string().min(1).max(400) }))
      .min(1)
      .max(5)
      .describe('The 3-5 best verbatim excerpts, each from the item it names'),
  });
export type Dive = z.infer<ReturnType<typeof Dive>>;

/** The reporter writes judgment only; code renders the table, the quotes and the coverage. */
export const Narrative = z.object({
  summary: z.array(z.string().min(1).max(600)).min(1).max(3).describe('Executive summary bullets'),
  longTail: z
    .string()
    .min(1)
    .nullable()
    .describe('One paragraph on the ranked themes without a deep dive; null when there are none'),
  emergent: z
    .string()
    .min(1)
    .nullable()
    .describe('Which emergent patterns deserve a theme next quarter; null when there are none'),
});
export type Narrative = z.infer<typeof Narrative>;

export const FeedbackInput = z
  .object({
    sources: z
      .array(Path)
      .min(1)
      .max(20)
      .describe('Repository-relative feedback files, each read whole; required'),
    format: Format.default('lines').describe(
      'lines: one item per nonblank line; blocks: items between blank lines; jsonl: one object per line; csv: a header row, then one item per record',
    ),
    textField: z
      .string()
      .min(1)
      .max(80)
      .default('text')
      .describe('The jsonl key or csv column that holds the feedback text'),
    fields: z
      .array(z.string().min(1).max(80))
      .max(6)
      .default([])
      .describe('jsonl keys or csv columns shown beside each item, such as plan or platform'),
    focus: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .default(null)
      .describe('Optional steer, such as "only churn-related feedback"'),
    deepDives: z.number().int().min(0).max(10).default(4).describe('Top themes that get a dive'),
    severityWeight: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(4)
      .describe('Rank score: items plus this weight times severe items'),
    sampleSize: z
      .number()
      .int()
      .min(10)
      .max(200)
      .default(60)
      .describe('Items the calibrator reads, spread evenly across the corpus'),
    shardSize: z.number().int().min(5).max(300).default(150).describe('Items per tagger'),
    maxShards: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(20)
      .describe('Tagger cap; items past it are reported unsharded'),
    diveItems: z
      .number()
      .int()
      .min(5)
      .max(200)
      .default(60)
      .describe('Theme items one diver reads, severe first; the rest are counted'),
  })
  .refine((input) => new Set(input.sources).size === input.sources.length, 'Sources repeat')
  .refine(
    (input) => !input.fields.length || input.format === 'jsonl' || input.format === 'csv',
    'fields needs the jsonl or csv format',
  )
  .refine((input) => !input.fields.includes(input.textField), 'textField is not a field');
export type FeedbackInput = z.infer<typeof FeedbackInput>;

const Count = z.number().int().nonnegative();
const Quote = z.object({ id: z.string(), ref: z.string(), text: z.string() });
export type Quote = z.infer<typeof Quote>;

export const RankedTheme = z.object({
  theme: ThemeKey,
  definition: z.string(),
  count: Count,
  severe: Count,
  score: Count,
  severity: z.object({
    'churn-threat': Count,
    'data-loss': Count,
    'blocked-workflow': Count,
    safety: Count,
  }),
});
export type RankedTheme = z.infer<typeof RankedTheme>;

export const FeedbackOutput = z.object({
  status: z.enum(['complete', 'limited', 'degraded', 'empty']),
  report: z.string().nullable().describe('Markdown: code-rendered table and quotes around prose'),
  coverage: z.string().describe('One line: items tagged, across how many shards'),
  themes: z.array(RankedTheme).describe('Severity-weighted ranking of themes with items'),
  vocabulary: z.array(Theme),
  emergent: z.array(z.string()),
  dives: z.array(
    z.object({
      theme: ThemeKey,
      outcome: z.enum(['dived', 'failed']),
      storyline: z.string().nullable(),
      segments: z.string().nullable(),
      recommendation: z.string().nullable(),
      quotes: z.array(Quote),
      itemsShown: Count,
      itemsOmitted: Count.describe('Theme items past diveItems, never shown to the diver'),
    }),
  ),
  sources: z.array(
    z.object({
      path: Path,
      sha256: Digest.nullable(),
      items: Count,
      unparsed: Count.describe('Records that did not parse or had no text'),
      failure: z.string().nullable(),
    }),
  ),
  shards: z.array(
    z.object({
      first: z.string(),
      last: z.string(),
      items: Count,
      outcome: z.enum(['tagged', 'failed']),
      missing: z.array(z.string()).describe('Item IDs the answer left untagged'),
      duplicates: Count.describe('Repeated item IDs; the first tag counts'),
    }),
  ),
  accounting: z.object({
    items: Count,
    tagged: Count,
    offFocus: Count,
    untagged: Count.describe('In a failed shard, or missing from its answer'),
    unsharded: Count.describe('Past maxShards, never tagged'),
    truncated: Count.describe('Items shown to agents cut at the per-item character cap'),
    rejectedQuotes: Count.describe('Quotes that were not verbatim excerpts of their item'),
  }),
});
export type FeedbackOutput = z.infer<typeof FeedbackOutput>;

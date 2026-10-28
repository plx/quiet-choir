/**
 * feedback-synthesis — raw user feedback becomes ranked, quotable product themes
 * ==============================================================================
 *
 * USE CASE
 *   A thousand support tickets, app reviews, NPS verbatims, or survey rows
 *   contain the product roadmap — encoded as anecdotes. One agent reading
 *   them all loses the early items by the time it reads the late ones; naive
 *   sampling loses the rare-but-severe signal. This workflow shards the
 *   corpus across parallel taggers using a FIXED THEME VOCABULARY discovered
 *   in a calibration pass (so shard A's "sync issues" and shard B's "data
 *   loss on refresh" land in the same bucket), aggregates counts and
 *   severity in plain code, then deep-dives only the themes that matter.
 *
 * WHEN TO USE
 *   - Quarterly review of support/NPS/review corpora
 *   - Post-launch listening ("what are the first 500 reactions?")
 *   - Prioritization fights: replace "I feel like users want X" with counts
 *     and quotes
 *
 * ARGS  (required: source)
 *   { source: string, focus?: string, deepDives?: number }
 *   - source: where the feedback lives — file(s), directory, glob, or a
 *     description ("the CSV exports in data/reviews/")
 *   - focus: optional steer ("only churn-related feedback")
 *   - deepDives: how many top themes get a deep-dive agent (default 4)
 *
 * PATTERNS DEMONSTRATED
 *   - Calibrate-then-shard: a cheap sample pass fixes the theme vocabulary
 *     BEFORE the fan-out — without it, shards invent incompatible taxonomies
 *     and the aggregation is mush
 *   - Sharding by explicit item ranges over a manifest, so every item is
 *     read exactly once and coverage is provable, not vibes
 *   - Aggregate in code, interpret by agent: counting is arithmetic; naming
 *     the storyline is judgment
 *   - Severity-weighted ranking so rare-but-catastrophic beats common-but-mild
 *
 * COST PROFILE
 *   1 inventory + 1 calibrator + ~1 tagger per 150 items + N deep-dives + 1
 *   report. A 1000-item corpus ≈ 13 agents.
 *
 * OUTPUT
 *   { themes: [...], report, coverage, emergent }
 */

export const meta = {
  name: 'feedback-synthesis',
  description: 'Shard a feedback corpus across parallel taggers with a calibrated theme vocabulary, aggregate in code, deep-dive top themes into a quotable report',
  whenToUse: 'Turning large support/review/NPS corpora into ranked product themes with counts, severity, and representative quotes',
  phases: [
    { title: 'Inventory', detail: 'manifest the corpus into countable items' },
    { title: 'Calibrate', detail: 'fix the theme vocabulary on a sample' },
    { title: 'Tag', detail: 'parallel shard taggers, fixed vocabulary' },
    { title: 'Synthesize', detail: 'deep-dive top themes, write the report' },
  ],
}

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['totalItems', 'shards'],
  properties: {
    totalItems: { type: 'number' },
    shards: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'approxItems'],
        properties: {
          ref: { type: 'string', description: 'how a tagger locates this shard: file + row/line range, or file list' },
          approxItems: { type: 'number' },
        },
      },
      description: 'disjoint shards of ~150 items each covering the WHOLE corpus',
    },
    format: { type: 'string', description: 'what one item looks like and how to parse it' },
  },
}

const VOCAB_SCHEMA = {
  type: 'object',
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'definition'],
        properties: {
          key: { type: 'string', description: 'stable slug, e.g. sync-reliability' },
          definition: { type: 'string', description: 'inclusion rule a tagger can apply consistently' },
        },
      },
      description: '8-15 themes covering the sample; must include an "other" catch-all',
    },
  },
}

const TAGGED_SCHEMA = {
  type: 'object',
  required: ['itemsRead', 'counts'],
  properties: {
    itemsRead: { type: 'number' },
    counts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['theme', 'count', 'severe'],
        properties: {
          theme: { type: 'string' },
          count: { type: 'number' },
          severe: { type: 'number', description: 'of count, how many are severe: churn threat, data loss, blocked workflow, safety' },
          quotes: { type: 'array', items: { type: 'string' }, description: 'up to 3 verbatim, representative quotes' },
        },
      },
    },
    emergent: { type: 'array', items: { type: 'string' }, description: 'patterns in "other" that deserve their own theme next run' },
  },
}

const DIVE_SCHEMA = {
  type: 'object',
  required: ['theme', 'storyline', 'segments', 'recommendation'],
  properties: {
    theme: { type: 'string' },
    storyline: { type: 'string', description: 'what is actually happening to users, one paragraph, grounded in quotes' },
    segments: { type: 'string', description: 'who is affected — plan, platform, tenure — if inferable' },
    recommendation: { type: 'string', description: 'the single highest-leverage product action' },
    bestQuotes: { type: 'array', items: { type: 'string' } },
  },
}

if (!args || !args.source) {
  return { error: 'feedback-synthesis requires args: { source } — file(s), directory, or a description of where the feedback lives.' }
}
const focus = (args && args.focus) || null
const deepDives = (args && args.deepDives) || 4

// --------------------------------------------------------------------------
// Phase 1: Inventory. The manifest makes coverage PROVABLE: disjoint shard
// refs over the whole corpus, so "we read everything" is arithmetic
// (sum(itemsRead) vs totalItems), not an assertion.
// --------------------------------------------------------------------------

phase('Inventory')

const manifest = await agent(
  `Inventory this feedback corpus: ${args.source}
   ${focus ? `Focus filter (count only matching items): ${focus}` : ''}
   Locate the data, count the items, describe the per-item format, and partition
   the corpus into DISJOINT shards of roughly 150 items each — every item in
   exactly one shard. Shard refs must be self-contained instructions (file plus
   row/line range, or explicit file list) usable by an agent that has seen
   nothing else. Do not analyze content yet.`,
  { label: 'inventory', effort: 'low', schema: MANIFEST_SCHEMA },
)

if (!manifest || manifest.totalItems === 0) {
  return { themes: [], report: 'No feedback items found at the given source.', coverage: 'n/a', emergent: [] }
}
log(`${manifest.totalItems} items in ${manifest.shards.length} shards`)

// --------------------------------------------------------------------------
// Phase 2: Calibrate. One agent reads a cross-corpus sample and fixes the
// theme vocabulary every tagger must use. This is the step that makes the
// fan-out aggregatable — skip it and each shard invents its own taxonomy.
// --------------------------------------------------------------------------

phase('Calibrate')

const vocab = await agent(
  `Build the theme vocabulary for tagging this feedback corpus.
   Corpus: ${args.source} (${manifest.totalItems} items; format: ${manifest.format})
   ${focus ? `Focus: ${focus}` : ''}
   Read a spread sample of ~60 items drawn from DIFFERENT parts of the corpus
   (beginning/middle/end or across files). Derive 8-15 themes that would cover
   what you saw, each with an inclusion rule precise enough that two different
   taggers would bucket the same item the same way. Include an "other" catch-all.`,
  { label: 'calibrate', schema: VOCAB_SCHEMA },
)

if (!vocab) return { themes: [], report: 'Calibration failed.', coverage: 'n/a', emergent: [] }
log(`Vocabulary: ${vocab.themes.map(t => t.key).join(', ')}`)

// --------------------------------------------------------------------------
// Phase 3: Tag — the fan-out. One tagger per shard, all with the same fixed
// vocabulary. effort:low — classification against given rules is mechanical.
// --------------------------------------------------------------------------

phase('Tag')

const tagged = (await parallel(manifest.shards.map((shard, i) => () =>
  agent(
    `Tag every feedback item in your shard against a FIXED theme vocabulary.
     Shard: ${shard.ref} (~${shard.approxItems} items; format: ${manifest.format})
     ${focus ? `Skip items not matching: ${focus} (do not count skipped as read)` : ''}
     Vocabulary (use ONLY these keys): ${JSON.stringify(vocab.themes, null, 2)}
     An item may carry up to 2 themes. Count severe cases per theme (churn
     threat, data loss, blocked workflow, safety). Save up to 3 verbatim quotes
     per theme — the most representative, not the most colorful. Report patterns
     stuck in "other" as emergent. Report exactly how many items you read.`,
    { label: `tag:shard${i + 1}`, effort: 'low', schema: TAGGED_SCHEMA },
  ),
))).filter(Boolean)

// Aggregate in plain code. Counting is not a judgment call.
const agg = new Map()
for (const t of vocab.themes) agg.set(t.key, { theme: t.key, definition: t.definition, count: 0, severe: 0, quotes: [] })
let itemsRead = 0
const emergent = []
for (const shard of tagged) {
  itemsRead += shard.itemsRead
  emergent.push(...(shard.emergent || []))
  for (const c of shard.counts) {
    const a = agg.get(c.theme)
    if (!a) continue // taggers were told to use only the fixed vocabulary
    a.count += c.count
    a.severe += c.severe
    a.quotes.push(...(c.quotes || []))
  }
}
// Severity-weighted rank: a theme with 20 data-loss reports outranks one with
// 60 mild gripes. Weight of 4 is a product choice — tune it.
const ranked = [...agg.values()]
  .filter(t => t.count > 0)
  .sort((a, b) => (b.count + 4 * b.severe) - (a.count + 4 * a.severe))
const coverage = `${itemsRead}/${manifest.totalItems} items read across ${tagged.length}/${manifest.shards.length} shards`
log(`Tagged: ${coverage}. Top themes: ${ranked.slice(0, 5).map(t => `${t.theme}(${t.count}${t.severe ? `, ${t.severe} severe` : ''})`).join(', ')}`)

// --------------------------------------------------------------------------
// Phase 4: Deep-dive the head of the ranking, then one report writer. Dives
// go back to the RAW corpus for their theme — the tagger quotes are hints,
// not the evidence base.
// --------------------------------------------------------------------------

phase('Synthesize')

const dives = (await parallel(ranked.slice(0, deepDives).map(t => () =>
  agent(
    `Deep-dive the feedback theme "${t.theme}" (${t.definition}).
     Corpus: ${args.source}. This theme drew ${t.count} items (${t.severe} severe).
     Starter quotes from taggers: ${JSON.stringify(t.quotes.slice(0, 8))}
     Go back to the raw corpus and read items matching this theme. Produce: the
     storyline (what is actually happening to users — mechanism, not summary),
     affected segments if inferable, the single highest-leverage recommendation,
     and the 3-5 best verbatim quotes.`,
    { label: `dive:${t.theme}`, phase: 'Synthesize', schema: DIVE_SCHEMA },
  ),
))).filter(Boolean)

const report = await agent(
  `Write the feedback-synthesis report in markdown.
   Coverage: ${coverage}${focus ? ` (focus: ${focus})` : ''}
   Full ranking (severity-weighted): ${JSON.stringify(ranked.map(t => ({ theme: t.theme, count: t.count, severe: t.severe })), null, 2)}
   Deep dives: ${JSON.stringify(dives, null, 2)}
   Emergent patterns outside the vocabulary: ${JSON.stringify([...new Set(emergent)])}
   Structure: executive summary (3 bullets max), theme table with counts, one
   section per deep-dived theme (storyline, segments, quotes, recommendation),
   long-tail themes in one paragraph, emergent patterns worth a theme next
   quarter. Use verbatim quotes; never paraphrase a user into a stronger claim.`,
  { label: 'report', effort: 'high' },
)

return {
  themes: ranked.map(t => ({ theme: t.theme, count: t.count, severe: t.severe })),
  report,
  coverage,
  emergent: [...new Set(emergent)],
}

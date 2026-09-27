// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'feedback-synthesis',
  description:
    'Shard a feedback corpus across parallel taggers with a calibrated theme vocabulary, aggregate in code, deep-dive top themes into a quotable report',
  whenToUse:
    'Turning large support/review/NPS corpora into ranked product themes with counts, severity, and representative quotes',
  phases: [
    { title: 'Inventory', detail: 'manifest the corpus into countable items' },
    { title: 'Calibrate', detail: 'fix the theme vocabulary on a sample' },
    { title: 'Tag', detail: 'parallel shard taggers, fixed vocabulary' },
    { title: 'Synthesize', detail: 'deep-dive top themes, write the report' },
  ],
};
export const input = z.object({
  ...executionInput,
  source: z.string().optional(),
  focus: z.string().optional(),
  deepDives: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const MANIFEST_SCHEMA = z
      .object({
        totalItems: z.number(),
        shards: z
          .array(
            z
              .object({
                ref: z
                  .string()
                  .describe('how a tagger locates this shard: file + row/line range, or file list'),
                approxItems: z.number(),
              })
              .catchall(z.json()),
          )
          .describe('disjoint shards of ~150 items each covering the WHOLE corpus'),
        format: z.string().describe('what one item looks like and how to parse it').optional(),
      })
      .catchall(z.json());

    const VOCAB_SCHEMA = z
      .object({
        themes: z
          .array(
            z
              .object({
                key: z.string().describe('stable slug, e.g. sync-reliability'),
                definition: z.string().describe('inclusion rule a tagger can apply consistently'),
              })
              .catchall(z.json()),
          )
          .describe('8-15 themes covering the sample; must include an "other" catch-all'),
      })
      .catchall(z.json());

    const TAGGED_SCHEMA = z
      .object({
        itemsRead: z.number(),
        counts: z.array(
          z
            .object({
              theme: z.string(),
              count: z.number(),
              severe: z
                .number()
                .describe(
                  'of count, how many are severe: churn threat, data loss, blocked workflow, safety',
                ),
              quotes: z
                .array(z.string())
                .describe('up to 3 verbatim, representative quotes')
                .optional(),
            })
            .catchall(z.json()),
        ),
        emergent: z
          .array(z.string())
          .describe('patterns in "other" that deserve their own theme next run')
          .optional(),
      })
      .catchall(z.json());

    const DIVE_SCHEMA = z
      .object({
        theme: z.string(),
        storyline: z
          .string()
          .describe('what is actually happening to users, one paragraph, grounded in quotes'),
        segments: z.string().describe('who is affected — plan, platform, tenure — if inferable'),
        recommendation: z.string().describe('the single highest-leverage product action'),
        bestQuotes: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    if (!args || !args.source) {
      return {
        error:
          'feedback-synthesis requires args: { source } — file(s), directory, or a description of where the feedback lives.',
      };
    }
    const focus = (args && args.focus) || null;
    const deepDives = (args && args.deepDives) || 4;

    // --------------------------------------------------------------------------
    // Phase 1: Inventory. The manifest makes coverage PROVABLE: disjoint shard
    // refs over the whole corpus, so "we read everything" is arithmetic
    // (sum(itemsRead) vs totalItems), not an assertion.
    // --------------------------------------------------------------------------

    port.phase('Inventory');

    const manifest = await ctx.claude
      .object(port.id('agent-1', 'inventory'), {
        ...args.$claude,
        prompt: `Inventory this feedback corpus: ${args.source}
   ${focus ? `Focus filter (count only matching items): ${focus}` : ''}
   Locate the data, count the items, describe the per-item format, and partition
   the corpus into DISJOINT shards of roughly 150 items each — every item in
   exactly one shard. Shard refs must be self-contained instructions (file plus
   row/line range, or explicit file list) usable by an agent that has seen
   nothing else. Do not analyze content yet.`,
        schema: MANIFEST_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!manifest || manifest.totalItems === 0) {
      return {
        themes: [],
        report: 'No feedback items found at the given source.',
        coverage: 'n/a',
        emergent: [],
      };
    }
    port.log(`${manifest.totalItems} items in ${manifest.shards.length} shards`);

    // --------------------------------------------------------------------------
    // Phase 2: Calibrate. One agent reads a cross-corpus sample and fixes the
    // theme vocabulary every tagger must use. This is the step that makes the
    // fan-out aggregatable — skip it and each shard invents its own taxonomy.
    // --------------------------------------------------------------------------

    port.phase('Calibrate');

    const vocab = await ctx.claude
      .object(port.id('agent-2', 'calibrate'), {
        ...args.$claude,
        prompt: `Build the theme vocabulary for tagging this feedback corpus.
   Corpus: ${args.source} (${manifest.totalItems} items; format: ${manifest.format})
   ${focus ? `Focus: ${focus}` : ''}
   Read a spread sample of ~60 items drawn from DIFFERENT parts of the corpus
   (beginning/middle/end or across files). Derive 8-15 themes that would cover
   what you saw, each with an inclusion rule precise enough that two different
   taggers would bucket the same item the same way. Include an "other" catch-all.`,
        schema: VOCAB_SCHEMA,
      })
      .then((result) => result.output);

    if (!vocab) return { themes: [], report: 'Calibration failed.', coverage: 'n/a', emergent: [] };
    port.log(`Vocabulary: ${vocab.themes.map((t) => t.key).join(', ')}`);

    // --------------------------------------------------------------------------
    // Phase 3: Tag — the fan-out. One tagger per shard, all with the same fixed
    // vocabulary. effort:low — classification against given rules is mechanical.
    // --------------------------------------------------------------------------

    port.phase('Tag');

    const tagged = (
      await port.parallel(
        'parallel-1',
        manifest.shards.map(
          (shard, i) => () =>
            ctx.claude
              .object(port.id('agent-3', `tag:shard${i + 1}`), {
                ...args.$claude,
                prompt: `Tag every feedback item in your shard against a FIXED theme vocabulary.
     Shard: ${shard.ref} (~${shard.approxItems} items; format: ${manifest.format})
     ${focus ? `Skip items not matching: ${focus} (do not count skipped as read)` : ''}
     Vocabulary (use ONLY these keys): ${JSON.stringify(vocab.themes, null, 2)}
     An item may carry up to 2 themes. Count severe cases per theme (churn
     threat, data loss, blocked workflow, safety). Save up to 3 verbatim quotes
     per theme — the most representative, not the most colorful. Report patterns
     stuck in "other" as emergent. Report exactly how many items you read.`,
                schema: TAGGED_SCHEMA,
                // Original effort: 'low' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    // Aggregate in plain code. Counting is not a judgment call.
    const agg = new Map();
    for (const t of vocab.themes)
      agg.set(t.key, { theme: t.key, definition: t.definition, count: 0, severe: 0, quotes: [] });
    let itemsRead = 0;
    const emergent = [];
    for (const shard of tagged) {
      itemsRead += shard.itemsRead;
      emergent.push(...(shard.emergent || []));
      for (const c of shard.counts) {
        const a = agg.get(c.theme);
        if (!a) continue; // taggers were told to use only the fixed vocabulary
        a.count += c.count;
        a.severe += c.severe;
        a.quotes.push(...(c.quotes || []));
      }
    }
    // Severity-weighted rank: a theme with 20 data-loss reports outranks one with
    // 60 mild gripes. Weight of 4 is a product choice — tune it.
    const ranked = [...agg.values()]
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count + 4 * b.severe - (a.count + 4 * a.severe));
    const coverage = `${itemsRead}/${manifest.totalItems} items read across ${tagged.length}/${manifest.shards.length} shards`;
    port.log(
      `Tagged: ${coverage}. Top themes: ${ranked
        .slice(0, 5)
        .map((t) => `${t.theme}(${t.count}${t.severe ? `, ${t.severe} severe` : ''})`)
        .join(', ')}`,
    );

    // --------------------------------------------------------------------------
    // Phase 4: Deep-dive the head of the ranking, then one report writer. Dives
    // go back to the RAW corpus for their theme — the tagger quotes are hints,
    // not the evidence base.
    // --------------------------------------------------------------------------

    port.phase('Synthesize');

    const dives = (
      await port.parallel(
        'parallel-2',
        ranked.slice(0, deepDives).map(
          (t) => () =>
            ctx.claude
              .object(port.id('agent-4', `dive:${t.theme}`), {
                ...args.$claude,
                prompt: `Deep-dive the feedback theme "${t.theme}" (${t.definition}).
     Corpus: ${args.source}. This theme drew ${t.count} items (${t.severe} severe).
     Starter quotes from taggers: ${JSON.stringify(t.quotes.slice(0, 8))}
     Go back to the raw corpus and read items matching this theme. Produce: the
     storyline (what is actually happening to users — mechanism, not summary),
     affected segments if inferable, the single highest-leverage recommendation,
     and the 3-5 best verbatim quotes.`,
                schema: DIVE_SCHEMA,
                // Original phase: 'Synthesize' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const report = await ctx.claude
      .text(port.id('agent-5', 'report'), {
        ...args.$claude,
        prompt: `Write the feedback-synthesis report in markdown.
   Coverage: ${coverage}${focus ? ` (focus: ${focus})` : ''}
   Full ranking (severity-weighted): ${JSON.stringify(
     ranked.map((t) => ({ theme: t.theme, count: t.count, severe: t.severe })),
     null,
     2,
   )}
   Deep dives: ${JSON.stringify(dives, null, 2)}
   Emergent patterns outside the vocabulary: ${JSON.stringify([...new Set(emergent)])}
   Structure: executive summary (3 bullets max), theme table with counts, one
   section per deep-dived theme (storyline, segments, quotes, recommendation),
   long-tail themes in one paragraph, emergent patterns worth a theme next
   quarter. Use verbatim quotes; never paraphrase a user into a stronger claim.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    return {
      themes: ranked.map((t) => ({ theme: t.theme, count: t.count, severe: t.severe })),
      report,
      coverage,
      emergent: [...new Set(emergent)],
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});

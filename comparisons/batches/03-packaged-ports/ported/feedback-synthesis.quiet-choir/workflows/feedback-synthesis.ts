// feedback-synthesis: control flow only. Code reads and parses the corpus into numbered items,
// draws the calibration sample and cuts disjoint shards; a calibrator fixes the vocabulary, a
// settled map tags each shard, code counts, checks quotes and ranks, a settled map dives the top
// themes, and code renders the report around the reporter's prose.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Dive,
  FeedbackInput,
  FeedbackOutput,
  Narrative,
  Tagged,
  Vocabulary,
} from '../contracts.js';
import { idsOf, promptItems, readCorpus, sample, shard } from '../lib/corpus.js';
import {
  aggregate,
  divePlans,
  keysOf,
  rank,
  settleDives,
  settleVocabulary,
  summarize,
} from '../lib/policy.js';
import { render } from '../lib/report.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

/** Emergent patterns the reporter reads; the output and the report list them all. */
const REPORTED_EMERGENT = 30;

export default defineWorkflow({
  name: 'feedback-synthesis',
  version: 'packaged-03',
  description:
    'Parse a feedback corpus in code, calibrate a theme vocabulary, tag disjoint shards, count and rank in code, and deep-dive the top themes into a quotable report.',
  roster,
  prompts: [prompts],
  input: FeedbackInput,
  output: FeedbackOutput,
  async run(ctx, input) {
    const { focus } = input;
    const { items, sources } = await readCorpus(ctx, input);
    const { shards, unsharded } = shard(items, input.shardSize, input.maxShards);
    const none = { report: null, themes: [], vocabulary: [], emergent: [], dives: [], shards: [] };
    if (!items.length)
      return { ...none, ...summarize({ sources, items: 0, focus }).summary, sources };
    const drawn = sample(items, input.sampleSize);
    const calibrated = await ctx.roster.Calibrator.value('calibrate', {
      schema: Vocabulary,
      prompt: prompts.Calibrate({
        focus,
        total: items.length,
        fields: input.fields,
        items: promptItems(drawn),
      }),
    });
    const vocabulary = settleVocabulary(calibrated.themes);
    const keys = keysOf(vocabulary);
    // `version` names the template and schema, which a settled map's fingerprint does not show.
    const tags = await ctx.map(
      'shards',
      shards,
      { concurrency: 4, onError: 'return', version: 'tag/1' },
      (members, index) =>
        ctx.roster.Tagger.value('tag', {
          schema: Tagged(idsOf(members), keys),
          prompt: prompts.Tag({
            focus,
            vocabulary,
            shard: index + 1,
            shards: shards.length,
            items: promptItems(members),
          }),
        }),
    );
    const tally = aggregate(vocabulary, shards, tags, focus !== null);
    const ranked = rank(vocabulary, tally, input.severityWeight);
    const plans = divePlans(ranked, tally, input.deepDives, input.diveItems);
    const dove = plans.length
      ? await ctx.map(
          'dives',
          plans,
          { concurrency: 4, onError: 'return', version: 'dive/1' },
          (plan) =>
            ctx.roster.Diver.value('dive', {
              schema: Dive(idsOf(plan.items)),
              prompt: prompts.Dive({
                focus,
                theme: plan.theme,
                items: promptItems(plan.items),
                omitted: plan.omitted,
                starters: plan.starters,
              }),
            }),
        )
      : [];
    const { dives, rejected } = settleDives(plans, dove);
    const { summary, gaps } = summarize({
      sources,
      items: items.length,
      focus,
      unsharded,
      seen: [...drawn, ...shards.flat(), ...plans.flatMap((plan) => plan.items)],
      tally,
      dives,
      rejected,
      ranked: ranked.length,
    });
    const settled = {
      ...none,
      ...summary,
      themes: ranked,
      vocabulary,
      emergent: tally.emergent,
      dives,
      sources,
      shards: tally.rows,
    };
    if (!ranked.length) return settled;
    const dived = new Set(plans.map((plan) => plan.theme.theme));
    const narrative = await ctx.roster.Reporter.value('report', {
      schema: Narrative,
      prompt: prompts.Report({
        coverage: summary.coverage,
        weight: input.severityWeight,
        ranked,
        longTail: ranked.filter((theme) => !dived.has(theme.theme)),
        emergent: tally.emergent.slice(0, REPORTED_EMERGENT),
        moreEmergent: Math.max(0, tally.emergent.length - REPORTED_EMERGENT),
        gaps,
        dives: std.exec.json(dives.filter((entry) => entry.outcome === 'dived')),
      }),
    });
    const report = render({
      coverage: summary.coverage,
      weight: input.severityWeight,
      ranked,
      dives,
      narrative,
      emergent: tally.emergent,
      gaps,
    });
    return { ...settled, report };
  },
});

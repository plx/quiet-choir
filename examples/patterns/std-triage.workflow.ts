import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Issues = z.array(z.object({ number: z.int().min(1), title: z.string(), body: z.string() }));
const Labels = z.array(z.string().min(1)).min(1).default(['bug', 'feature', 'docs', 'question']);
const Counts = z.array(z.object({ label: z.string(), count: z.int() }));

export default defineWorkflow({
  name: 'std-triage',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ issues: Issues.min(1), labels: Labels, top: std.types.limit(5, 20) }),
  output: z.object({ status: z.string(), counts: Counts, urgent: Issues, unlabeled: Issues }),
  async run(ctx, { issues, labels, top }) {
    const { status, counts, assignments, unlabeled } = await std.patterns.classify(ctx, {
      id: 'classify',
      team: { tagger: ctx.roster.Clerk },
      items: issues,
      labels,
    });
    const ranked = await std.patterns.rank(ctx, {
      id: 'rank',
      team: { ranker: ctx.roster.Judge },
      items: assignments,
      pick: top,
      criterion: 'How urgently it needs attention: the severity and reach of its impact.',
    });
    return { status, counts, urgent: ranked.selected.map(({ item }) => item), unlabeled };
  },
});

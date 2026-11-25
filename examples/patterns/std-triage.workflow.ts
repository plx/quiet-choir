import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Issue = z.object({ number: z.int().min(1), title: z.string(), body: z.string() });
const Labels = z.array(z.string().min(1)).min(1).default(['bug', 'feature', 'docs', 'question']);

export default defineWorkflow({
  name: 'std-triage',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ issues: z.array(Issue).min(1), labels: Labels, top: std.types.limit(5, 20) }),
  output: z.object({ labeled: std.patterns.ClassifyResult(Issue), urgent: z.array(Issue) }),
  async run(ctx, { issues, labels, top }) {
    const labeled = await std.patterns.classify(ctx, {
      id: 'classify',
      team: { tagger: ctx.roster.Clerk },
      items: issues,
      labels,
    });
    const ranked = await std.patterns.rank(ctx, {
      id: 'rank',
      team: { ranker: ctx.roster.Judge },
      items: labeled.assignments, // Unlabeled issues are left for a person to read.
      pick: top,
      criterion: 'How urgently it needs attention: the severity and reach of its impact.',
    });
    return { labeled, urgent: ranked.selected.map(({ item }) => item) };
  },
});

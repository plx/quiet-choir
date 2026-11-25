import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Criteria = z.array(z.union([z.string().min(1), std.types.Criterion])).min(1);
const Results = z.array(
  z.object({ criterion: std.types.Criterion, result: std.types.CriterionResult.nullable() }),
);

export default defineWorkflow({
  name: 'std-acceptance',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), criteria: Criteria }),
  output: z.object({
    verdict: z.enum(['done', 'not-done', 'unverified']),
    status: z.enum(['complete', 'degraded']),
    results: Results,
  }),
  async run(ctx, { range, criteria }) {
    const diff = await std.exec.diff(ctx, 'diff', range);
    const { verdict, status, results } = await std.patterns.checklist(ctx, {
      id: 'acceptance',
      team: { checker: ctx.roster.Reviewer },
      target: `The change in ${range}, as git diff shows it:\n\n${std.text.fence(diff, 'diff')}`,
      criteria,
    });
    return { verdict, status, results };
  },
});

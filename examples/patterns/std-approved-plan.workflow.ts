import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-approved-plan',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ task: z.string().min(1), revisions: std.types.limit(2, 5, 0) }),
  output: z.object({
    status: z.enum(['approved', 'rejected', 'out-of-revisions']),
    plan: std.types.Plan,
    report: std.types.WorkReport.nullable(),
  }),
  async run(ctx, { task, revisions }) {
    const review = await std.patterns.approvedPlan(ctx, {
      id: 'plan',
      team: { planner: ctx.roster.Planner },
      task,
      revisions,
    });
    const { status, plan } = review;
    if (!review.approved) return { status, plan, report: null };
    const report = await ctx.roster.Mechanic.value(
      'implement',
      std.patterns.planCall(review, task),
    );
    return { status, plan, report };
  },
});

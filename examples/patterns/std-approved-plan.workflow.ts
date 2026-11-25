import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-approved-plan',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ task: z.string().min(1), revisions: std.types.limit(2, 5, 0) }),
  output: z.object({
    review: std.patterns.ApprovedPlanResult,
    report: std.types.WorkReport.nullable(),
  }),
  async run(ctx, { task, revisions }) {
    const team = { planner: ctx.roster.Planner };
    const review = await std.patterns.approvedPlan(ctx, { id: 'plan', team, task, revisions });
    // Only an approved plan is implemented; a rejected one is returned for the record.
    if (!review.approved) return { review, report: null };
    const call = std.patterns.planCall(review, task);
    return { review, report: await ctx.roster.Mechanic.value('implement', call) };
  },
});

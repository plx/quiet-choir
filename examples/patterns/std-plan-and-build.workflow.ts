import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Reports = z.array(std.types.WorkReport.nullable());

export default defineWorkflow({
  name: 'std-plan-and-build',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ goal: z.string().min(1), maxTasks: std.types.limit(8, 30) }),
  output: std.types.TaskList.extend({ status: std.data.Health, reports: Reports }),
  async run(ctx, { goal, maxTasks }) {
    const team = { planner: ctx.roster.Planner };
    const plan = await std.patterns.decompose(ctx, { id: 'plan', team, goal, maxTasks });
    const build = await std.flow.waves(ctx, {
      id: 'build',
      items: plan.tasks,
      key: (task) => task.id,
      dependsOn: (task) => task.dependsOn,
      concurrency: 1, // The tasks share one checkout, so each wave runs them one at a time.
      run: async (task) => {
        const report = await ctx.roster.Mechanic.value('work', std.patterns.taskCall(task, goal));
        if (report.status === 'done') return report;
        throw new Error(`${task.id} is ${report.status}: ${report.summary}`); // Skips dependents.
      },
    });
    const reports = build.results.map((item) => item.value);
    return { status: std.data.health(plan, build), tasks: plan.tasks, reports };
  },
});

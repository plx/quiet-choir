import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'per-item-pipeline',
  version: '1',
  input: z.object({ tasks: z.array(z.string()).max(8) }),
  output: z.array(z.object({ approved: z.boolean(), patch: z.string() })),
  async run(ctx, input) {
    return ctx.map('fix', input.tasks, { concurrency: 2 }, async (task) => {
      const plan = await ctx.claude.value('plan', { prompt: `Plan this task: ${task}` });
      const patch = await ctx.codex.value('implement', {
        prompt: `Propose a patch as text, without editing files: ${task}\n${plan}`,
      });
      const check = await ctx.claude.value('check', {
        prompt: `Review this proposed patch: ${patch}`,
        schema: z.object({ approved: z.boolean() }),
      });
      return { approved: check.approved, patch };
    });
  },
});

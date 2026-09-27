import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'human-review',
  version: '1',
  input: z.object({ task: z.string(), revision: z.string() }),
  output: z.object({ approved: z.boolean(), plan: z.string() }),
  async run(ctx, input) {
    const plan = await ctx.codex.value('plan', {
      prompt: `Propose a short plan for ${input.task}; do not edit files.`,
    });
    const decision = await ctx.approve(ctx.id('approve', input.revision), {
      prompt: 'Accept this plan?',
      title: 'Plan review',
      details: Buffer.from(plan).subarray(0, 16_000).toString('utf8'),
      subject: { revision: input.revision, plan },
      audience: 'human',
    });
    return { approved: decision.approved, plan };
  },
});

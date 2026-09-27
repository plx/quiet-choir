import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'rehearse',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ approved: z.boolean() }),
  async run(ctx, input) {
    const draft = await ctx.claude.value('draft', { prompt: `Draft: ${input.topic}` });
    return ctx.codex.value('review', {
      prompt: `Review: ${draft}`,
      schema: z.object({ approved: z.boolean() }),
    });
  },
});

import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'salvage',
  version: '1',
  input: z.object({ topics: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    const answers: string[] = [];
    for (const [index, topic] of input.topics.entries()) {
      answers.push(await ctx.claude.value(`answer/${String(index)}`, { prompt: topic }));
    }
    return answers;
  },
});

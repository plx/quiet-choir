import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'tolerant-panel',
  version: '1',
  input: z.object({ topic: z.string(), lenses: z.array(z.string()).min(1).max(8) }),
  output: z.object({ quorum: z.boolean(), answers: z.array(z.string()) }),
  async run(ctx, input) {
    const results = await ctx.map(
      'panel',
      input.lenses,
      { concurrency: 2, onError: 'settle' },
      (lens) => ctx.claude.value('review', { prompt: `${lens}: ${input.topic}` }),
    );
    const answers = results.flatMap((result) => (result.ok ? [result.value] : []));
    return { quorum: answers.length > input.lenses.length / 2, answers };
  },
});

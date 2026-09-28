import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'review-revise',
  version: '1',
  input: z.object({ draft: z.string(), rounds: z.int().min(1).max(10) }),
  output: z.object({ approved: z.boolean(), draft: z.string() }),
  async run(ctx, input) {
    let draft = input.draft;
    for (let round = 0; round < input.rounds; round++) {
      const review = await ctx.codex.value(`review/${String(round)}`, {
        prompt: `Review this draft: ${draft}`,
        schema: z.object({ approved: z.boolean(), feedback: z.string() }),
      });
      if (review.approved) return { approved: true, draft };
      if (round + 1 < input.rounds) {
        draft = await ctx.claude.value(`revise/${String(round)}`, {
          prompt: `Revise ${draft} using this feedback: ${review.feedback}`,
        });
      }
    }
    return { approved: false, draft };
  },
});

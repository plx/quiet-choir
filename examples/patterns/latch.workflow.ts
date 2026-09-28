import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'latch',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ source: z.enum(['primary', 'fallback']), answer: z.string() }),
  async run(ctx, input) {
    const primary = await ctx.claude.value('primary', {
      prompt: input.topic,
      onError: 'return',
      retry: { maxAttempts: 2, delayMs: 1, on: ['rate-limit'] },
    });
    if (primary.ok) return { source: 'primary', answer: primary.value };
    const answer = await ctx.codex.value('fallback', { prompt: input.topic });
    return { source: 'fallback', answer };
  },
});

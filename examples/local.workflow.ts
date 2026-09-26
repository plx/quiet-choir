import { defineWorkflow, z } from '../src/index.js';

// Run with --input '{"failOnce":true}' to demonstrate failure followed by durable resume.
export default defineWorkflow({
  name: 'local-demo',
  version: '1',
  input: z.object({
    words: z.array(z.string()).max(20).default(['typed', 'durable', 'workflows']),
    failOnce: z.boolean().default(false),
  }),
  output: z.object({ words: z.array(z.string()), characters: z.number() }),
  async run(ctx, input) {
    const words = await ctx.map(input.words, 2, (word, index) =>
      ctx.step(`word/${String(index)}`, {
        input: word,
        schema: z.string(),
        run: () => word.toUpperCase(),
      }),
    );

    return ctx.step('summarize', {
      input: { words, failOnce: input.failOnce },
      schema: z.object({ words: z.array(z.string()), characters: z.number() }),
      run: ({ attempt }) => {
        if (input.failOnce && attempt === 1) {
          throw new Error(
            'Demonstration failure. Resume this run; completed word steps will replay.',
          );
        }
        return { words, characters: words.reduce((total, word) => total + word.length, 0) };
      },
    });
  },
});

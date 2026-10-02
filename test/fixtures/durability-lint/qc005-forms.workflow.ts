import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// QC005 on every root receiver and loop form; within and dynamic IDs are clean.
export default defineWorkflow({
  name: 'durability-qc005-forms',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.string(),
  async run(ctx, input) {
    const answers = await Promise.all(
      input.items.map(async (item) => ctx.claude.text('review', { prompt: item })),
    );
    let index = 0;
    while (index < input.items.length) {
      await ctx.exec.json('probe', ['true'], { schema: z.unknown() });
      index += 1;
    }
    await ctx.exec('run', ['true']);
    if (index > 0) {
      await ctx.exec('run', ['true']);
    }
    for (const item of input.items) {
      await ctx.within(ctx.id('item', item)).step('same', text);
      await ctx.step(ctx.id('dynamic', item), text);
    }
    return answers.map((answer) => answer.output).join('');
  },
});

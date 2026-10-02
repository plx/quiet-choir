import { defineWorkflow, z } from '../../../src/index.js';

// QC005: a literal ID inside a loop on the root context.
export default defineWorkflow({
  name: 'durability-m03-loop-id',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    const results: string[] = [];
    for (const item of input.items) {
      results.push(
        await ctx.step('process', { input: item, schema: z.string(), run: () => item.trim() }),
      );
    }
    return results;
  },
});

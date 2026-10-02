import { defineWorkflow, z } from '../../../src/index.js';

// QC005: one literal ID used twice on the root context.
export default defineWorkflow({
  name: 'durability-m02-reused-id',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    const first = await ctx.step('fetch', { input: {}, schema: z.number(), run: () => 1 });
    const second = await ctx.step('fetch', { input: {}, schema: z.number(), run: () => 2 });
    return first + second;
  },
});

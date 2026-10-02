import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// Clean: one literal ID reused only where at most one occurrence can run.
export default defineWorkflow({
  name: 'durability-exclusive-branch',
  version: '1',
  input: z.object({ mode: z.enum(['a', 'b', 'c']), fast: z.boolean() }),
  output: z.string(),
  async run(ctx, input) {
    let picked: string;
    if (input.mode === 'a') {
      picked = await ctx.step('pick', text);
    } else if (input.mode === 'b') {
      picked = await ctx.step('pick', text);
    } else {
      picked = await ctx.step('pick', text);
    }
    switch (input.mode) {
      case 'a': {
        picked += await ctx.step('route', text);
        break;
      }
      case 'b': {
        picked += await ctx.step('route', text);
        break;
      }
      default: {
        picked += await ctx.step('route', text);
      }
    }
    picked += input.fast ? await ctx.step('choose', text) : await ctx.step('choose', text);
    if (input.fast) {
      const quick = await ctx.step('result', text);
      return picked + quick;
    }
    if (input.mode === 'c') throw new Error(await ctx.step('result', text));
    return picked + (await ctx.step('result', text));
  },
});

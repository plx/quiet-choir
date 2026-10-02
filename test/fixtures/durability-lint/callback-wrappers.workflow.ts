import { defineWorkflow, z } from '../../../src/index.js';

// A parenthesized or asserted callback is classified by its call, like a bare one.
export default defineWorkflow({
  name: 'durability-callback-wrappers',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    // Repeats: the fixed ID is reported.
    await Promise.all(
      input.items.map((item: string) =>
        ctx.step('fixed', { input: item, schema: z.string(), run: () => item }),
      ),
    );
    // Each scope and each named-map mapper has its own namespace: no duplicate across them.
    await ctx.scope('first', async () =>
      ctx.step('inner', {
        input: 'a',
        schema: z.string(),
        run: () => 'a',
      }),
    );
    await ctx.scope('second', async () =>
      ctx.step('inner', { input: 'b', schema: z.string(), run: () => 'b' }),
    );
    return ctx.map('items', input.items, { concurrency: 2, key: (item) => item }, (async (
      item: string,
    ) => ctx.step('each', { input: item, schema: z.string(), run: () => item })) satisfies (
      item: string,
    ) => Promise<string>);
  },
});

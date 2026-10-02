import { defineWorkflow, z } from '../../../src/index.js';

// Clean: the named map scopes each item, so a literal ID in its mapper is unique per item.
export default defineWorkflow({
  name: 'durability-m11b-named-map',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    return ctx.map('items', input.items, { concurrency: 2, key: (item) => item }, async (item) =>
      ctx.step('each', { input: item, schema: z.string(), run: () => item }),
    );
  },
});

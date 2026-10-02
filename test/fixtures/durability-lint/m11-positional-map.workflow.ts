import { defineWorkflow, z } from '../../../src/index.js';

// QC006: the deprecated positional map; QC005: its mapper repeats a literal ID per item.
export default defineWorkflow({
  name: 'durability-m11-positional-map',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the hazard under test
    return ctx.map(input.items, 2, async (item) =>
      ctx.step('each', { input: item, schema: z.string(), run: () => item }),
    );
  },
});

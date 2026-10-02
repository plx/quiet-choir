import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// A custom sort() calls its comparator once, so a literal ID in it is not a loop.
const custom = { sort: (compare: () => number) => compare() };

// A sort or toSorted comparator runs once per comparison, so a fixed ID in it repeats (QC005).
export default defineWorkflow({
  name: 'durability-sort-comparator',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.string(),
  async run(ctx, input) {
    const pending: Promise<string>[] = [];
    custom.sort(() => {
      pending.push(ctx.step('custom-sort', text));
      return 0;
    });
    [...input.items].sort(() => {
      pending.push(ctx.step('array-sort', text));
      return 0;
    });
    input.items.toSorted(() => {
      pending.push(ctx.step('array-to-sorted', text));
      return 0;
    });
    await Promise.all(pending);
    return 'done';
  },
});

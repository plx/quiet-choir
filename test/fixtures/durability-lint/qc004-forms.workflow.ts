import { defineWorkflow, z } from '../../../src/index.js';

// QC004 over direct, identifier and map-produced arrays; plain promises are clean.
export default defineWorkflow({
  name: 'durability-qc004-forms',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.string(),
  async run(ctx, input) {
    const nap = ctx.sleep('nap', 10);
    const first = await Promise.race([nap, Promise.resolve(null)]);
    const tasks = input.items.map(async (item) =>
      ctx.step(ctx.id('task', item), { input: item, schema: z.string(), run: () => item }),
    );
    const any = await Promise.any(tasks);
    const plain = await Promise.race([Promise.resolve('a'), Promise.resolve('b')]);
    return `${String(first)}${any}${plain}`;
  },
});

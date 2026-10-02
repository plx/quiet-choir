import { defineWorkflow, z } from '../../../src/index.js';

// QC004: racing durable calls picks a winner by completion order.
export default defineWorkflow({
  name: 'durability-m20-race',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    return Promise.race([
      ctx.sleep('nap', 10).then(() => 'sleep'),
      ctx.step('work', { input: {}, schema: z.string(), run: () => 'work' }),
    ]);
  },
});

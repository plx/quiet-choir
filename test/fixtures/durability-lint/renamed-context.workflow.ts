import { defineWorkflow, z } from '../../../src/index.js';

// Hazards are found by the context's type, whatever the parameter is called.
export default defineWorkflow({
  name: 'durability-renamed-context',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.number(),
  async run(c, input) {
    for (const item of input.items) {
      await c.step('again', { input: item, schema: z.string(), run: () => item });
    }
    return Math.random();
  },
});

import { defineWorkflow, z, type WorkflowContext } from '../../../src/index.js';

type Context = WorkflowContext;

// An alias of the context type is still the context, so its hazards are found.
export default defineWorkflow({
  name: 'durability-aliased-context',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.number(),
  async run(c: Context, input) {
    for (const item of input.items) {
      await c.step('again', { input: item, schema: z.string(), run: () => item });
    }
    return Math.random();
  },
});

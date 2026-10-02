import { defineWorkflow, z } from '../../../src/index.js';

// QC003: a durable step inside a step callback.
export default defineWorkflow({
  name: 'durability-m08-nested-step',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    return ctx.step('outer', {
      input: {},
      schema: z.string(),
      run: async () => ctx.step('inner', { input: {}, schema: z.string(), run: () => 'x' }),
    });
  },
});

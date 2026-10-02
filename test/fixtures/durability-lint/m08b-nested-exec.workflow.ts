import { defineWorkflow, z } from '../../../src/index.js';

// QC003: the durable ctx.exec inside a step callback; the callback's context.exec is the fix.
export default defineWorkflow({
  name: 'durability-m08b-nested-exec',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    return ctx.step('outer', {
      input: {},
      schema: z.string(),
      async run() {
        const result = await ctx.exec('status', ['git', 'status', '--short']);
        return result.stdout;
      },
    });
  },
});

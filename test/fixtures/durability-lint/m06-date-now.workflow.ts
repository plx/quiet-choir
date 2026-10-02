import { defineWorkflow, z } from '../../../src/index.js';

// QC002: a live clock read becomes step input.
export default defineWorkflow({
  name: 'durability-m06-date-now',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    const started = Date.now();
    return ctx.step('stamp', { input: { started }, schema: z.number(), run: () => started });
  },
});

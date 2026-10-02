import { defineWorkflow, z } from '../../../src/index.js';

// Two QC002 findings; the comment silences only the first.
export default defineWorkflow({
  name: 'durability-suppression',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    // quiet-choir-ignore QC002 fixture: this clock read is deliberately live
    const first = Date.now();
    const second = Date.now();
    return ctx.step('sum', { input: { first, second }, schema: z.number(), run: () => 1 });
  },
});

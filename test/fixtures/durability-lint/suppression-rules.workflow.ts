import { defineWorkflow, z } from '../../../src/index.js';

// A comment silences only the rules it names.
export default defineWorkflow({
  name: 'durability-suppression-rules',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    // quiet-choir-ignore QC005 names a different rule
    const first = Date.now();
    // quiet-choir-ignore QC005, QC002 lists the rule among others
    const second = Date.now();
    // quiet-choir-ignore QC002
    const third = Date.now();
    return ctx.step('sum', {
      input: { first, second, third },
      schema: z.number(),
      run: () => 1,
    });
  },
});

import { defineWorkflow, z } from '../../../src/index.js';

// QC001: an effect promise the workflow drops.
export default defineWorkflow({
  name: 'durability-m01-void',
  version: '1',
  input: z.object({}),
  output: z.string(),
  run(ctx) {
    void ctx.step('greet', { input: {}, schema: z.string(), run: () => 'hello' });
    return Promise.resolve('done');
  },
});

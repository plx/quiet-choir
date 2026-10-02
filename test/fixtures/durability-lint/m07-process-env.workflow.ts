import { defineWorkflow, z } from '../../../src/index.js';

// QC002: the body reads the environment.
export default defineWorkflow({
  name: 'durability-m07-process-env',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    const home = process.env['HOME'] ?? '';
    return ctx.step('home', { input: { home }, schema: z.string(), run: () => home });
  },
});

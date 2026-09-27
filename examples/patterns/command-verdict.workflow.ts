import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'command-verdict',
  version: '1',
  input: z.object({ argv: z.tuple([z.string().min(1)], z.string()) }),
  output: z.object({ green: z.boolean(), code: z.number().nullable() }),
  async run(ctx, input) {
    const result = await ctx.exec('prove', input.argv, { okExitCodes: 'any' });
    return { green: result.code === 0, code: result.code };
  },
});

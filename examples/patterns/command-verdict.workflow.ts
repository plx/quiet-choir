import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'command-verdict',
  version: '1',
  input: z.object({ argv: z.tuple([z.string().min(1)], z.string()) }),
  output: z.object({ green: z.boolean(), code: z.number().nullable() }),
  async run(ctx, input) {
    const result = await ctx.exec('prove', input.argv, { onError: 'return' });
    if (result.ok) return { green: true, code: result.value.code };
    return { green: false, code: result.error.code ?? null };
  },
});

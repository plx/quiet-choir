import { defineWorkflow, guardFile, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'guard-mutation',
  version: '1',
  input: z.object({ file: z.string(), argv: z.tuple([z.string().min(1)], z.string()) }),
  output: z.number().nullable(),
  async run(ctx, input) {
    return guardFile(
      ctx,
      'mutation',
      input.file,
      async () => {
        const result = await ctx.exec('test', input.argv, { okExitCodes: 'any' });
        return result.code;
      },
      { version: JSON.stringify(input.argv) },
    );
  },
});

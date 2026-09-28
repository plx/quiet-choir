import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'file-update',
  version: '1',
  input: z.object({ file: z.string(), prefix: z.string() }),
  output: z.object({ path: z.string(), sha256: z.string() }),
  async run(ctx, input) {
    const before = await ctx.readFile('snapshot', input.file);
    return ctx.writeFile('publish', input.file, input.prefix + before.content, {
      ifMatch: before.sha256,
    });
  },
});

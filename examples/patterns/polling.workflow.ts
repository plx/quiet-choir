import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { defineWorkflow, z } from '../../src/index.js';

const Result = z.enum(['success', 'failure', 'timeout']);
export default defineWorkflow({
  name: 'polling',
  version: '1',
  input: z.object({ file: z.string(), ms: z.int().min(1).max(60_000) }),
  output: Result,
  async run(ctx, input) {
    const clock = { input: null, schema: z.number(), run: () => Date.now() };
    const deadline = (await ctx.step('started-at', clock)) + input.ms;
    return ctx.step('wait', {
      input: { file: input.file, deadline },
      schema: Result,
      async run({ signal }): Promise<z.infer<typeof Result>> {
        for (;;) {
          const state = (await readFile(input.file, { encoding: 'utf8', signal })).trim();
          if (state === 'success' || state === 'failure') return state;
          if (state !== 'pending') throw new Error('Unknown check status');
          if (Date.now() >= deadline) return 'timeout';
          await wait(100, undefined, { signal });
        }
      },
    });
  },
});

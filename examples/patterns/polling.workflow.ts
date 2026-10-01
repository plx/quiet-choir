import { readFile } from 'node:fs/promises';
import { defineWorkflow, z } from '../../src/index.js';

const Terminal = z.enum(['success', 'failure']);
// A producer that deletes and rewrites the file can briefly leave it missing.
const missing = (error: unknown) => (error as { code?: unknown }).code === 'ENOENT';
export default defineWorkflow({
  name: 'polling',
  version: '3',
  input: z.object({ file: z.string(), ms: z.int().min(1).max(60_000) }),
  output: z.enum(['success', 'failure', 'timeout']),
  async run(ctx, input) {
    const deadline = (await ctx.now('started-at')) + input.ms;
    const result = await ctx.poll('wait', {
      input: { file: input.file },
      schema: Terminal,
      deadline,
      every: 100,
      onError: { tolerate: 3, classify: (error) => (missing(error) ? 'transient' : 'fatal') },
      async observe({ signal }) {
        const state = (await readFile(input.file, { encoding: 'utf8', signal })).trim();
        if (state === 'success' || state === 'failure') return { done: true, value: state };
        if (state !== 'pending') throw new Error('Unknown check status');
        return { done: false, note: { state } };
      },
    });
    return result.by === 'deadline' ? 'timeout' : result.value;
  },
});

import { defineWorkflow, z } from '../../src/index.js';

const reviewFile = defineWorkflow({
  name: 'review-file',
  version: '1',
  input: z.object({ path: z.string().describe('File to review') }),
  output: z.string(),
  async run(ctx, input) {
    return ctx.claude.value('verdict', {
      profile: 'readonly',
      prompt: `Read and review this file: ${input.path}`,
    });
  },
});
export default defineWorkflow({
  name: 'reusable-helper',
  version: '2',
  children: [reviewFile],
  input: z.object({ paths: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    return ctx.map('files', input.paths, { concurrency: 2, key: (path) => ctx.id(path) }, (path) =>
      ctx.workflow('review', reviewFile, { path }),
    );
  },
});

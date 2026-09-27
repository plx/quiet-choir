import { defineWorkflow, z, type WorkflowContext } from '../../src/index.js';

async function reviewFile(ctx: WorkflowContext, path: string): Promise<string> {
  return ctx.claude.value('verdict', {
    profile: 'readonly',
    prompt: `Read and review this file: ${path}`,
  });
}
export default defineWorkflow({
  name: 'reusable-helper',
  version: '1',
  input: z.object({ paths: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    return ctx.map('files', input.paths, { concurrency: 2, key: (path) => ctx.id(path) }, (path) =>
      reviewFile(ctx.within('review'), path),
    );
  },
});

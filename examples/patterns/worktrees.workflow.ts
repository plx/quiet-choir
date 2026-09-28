import { defineWorkflow, z } from '../../src/index.js';
import { ensureWorktree } from './worktree-helper.js';

const Input = z.object({ repo: z.string(), root: z.string(), items: z.array(z.string()).max(8) });
export default defineWorkflow({
  name: 'worktrees',
  version: '1',
  input: Input,
  output: z.array(z.string()),
  profiles: { editor: { extends: 'edit' } },
  async run(ctx, input) {
    const { repo, root } = input;
    return ctx.map(
      'items',
      input.items,
      { concurrency: 2, key: (item) => ctx.id(item) },
      async (item) => {
        const setup = { repo, root, runId: ctx.runId, item };
        const cwd = await ctx.step('worktree', {
          input: setup,
          schema: z.string(),
          run: ({ signal }) => ensureWorktree({ ...setup, signal }),
        });
        await ensureWorktree({ ...setup, signal: ctx.signal });
        return ctx.codex.value('edit', { profile: 'editor', cwd, prompt: `Implement: ${item}` });
      },
    );
  },
});

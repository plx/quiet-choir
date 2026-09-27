import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'worktrees',
  version: '2',
  input: z.object({ items: z.array(z.string()).max(8) }),
  output: z.object({ commit: z.string(), conflicts: z.array(z.string()) }),
  profiles: { editor: { extends: 'edit' } },
  async run(ctx, input) {
    const changes = await ctx.map(
      'items',
      input.items,
      { concurrency: 2, key: (item) => ctx.id(item) },
      async (item) => {
        const result = await ctx.codex.text('edit', {
          profile: 'editor',
          isolation: 'worktree',
          prompt: `Implement: ${item}`,
        });
        if (!result.worktree) throw new Error('Missing isolated change');
        return result.worktree;
      },
    );
    const result = await ctx.merge('integrate', changes);
    return { commit: result.commit, conflicts: result.conflicts.flatMap((c) => c.files) };
  },
});

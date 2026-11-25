import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-doc-polish',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ file: std.types.RepoPath, rounds: std.types.limit(2, 5) }),
  output: z.object({
    status: z.enum(['approved', 'open-issues', 'degraded']),
    issues: z.array(std.types.Issue),
    receipt: std.types.Receipt.nullable(),
  }),
  async run(ctx, { file, rounds }) {
    const doc = await ctx.readFile('read', file);
    const polish = await std.patterns.critiqueRevise(ctx, {
      id: 'polish',
      team: { critic: ctx.roster.Critic, author: ctx.roster.Writer },
      brief: `Polish the Markdown document ${file} for its readers, keeping its scope and voice.`,
      draft: doc.content,
      lenses: std.lenses.writing,
      rounds,
    });
    const changed = polish.approved && polish.draft !== doc.content;
    const receipt = changed
      ? await ctx.writeFile('write', file, polish.draft, { ifMatch: doc.sha256 })
      : null;
    return { status: polish.status, issues: polish.issues, receipt };
  },
});

import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-doc-polish',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ file: std.types.RepoPath, rounds: std.types.limit(2, 5) }),
  output: z.object({
    polish: std.patterns.CritiqueReviseResult,
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
    // Write only an approved change, and only over the content the critics read.
    if (!polish.approved || polish.draft === doc.content) return { polish, receipt: null };
    const receipt = await ctx.writeFile('write', file, polish.draft, { ifMatch: doc.sha256 });
    return { polish, receipt };
  },
});

import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-incident',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), range: z.string().min(1), notes: z.string() }),
  output: std.patterns.FalsifyResult,
  async run(ctx, { question, range, notes }) {
    // The suspect range as evidence: its commits, oldest first, and the files they changed.
    const commits = std.text.commits(await std.exec.log(ctx, 'log', range));
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    return std.patterns.falsify(ctx, {
      id: 'incident',
      team: { theorist: ctx.roster.Reviewer, falsifier: ctx.roster.Skeptic },
      question,
      context: [
        std.text.section(`Commits in ${range}`, commits),
        std.text.section('Files changed', stat),
        std.text.section('Notes', notes),
      ].join('\n\n'),
    });
  },
});

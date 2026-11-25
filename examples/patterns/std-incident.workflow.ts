import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-incident',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), range: z.string().min(1), notes: z.string() }),
  output: z.object({
    confidence: z.enum(['high', 'medium', 'split', 'none']),
    status: z.enum(['complete', 'degraded']),
    survivors: z.array(std.types.Hypothesis),
  }),
  async run(ctx, { question, range, notes }) {
    // `--end-of-options` keeps a range such as `--output=x` from being read as an option.
    const args = ['--stat', '--date=iso', '--format=%h %ad %s', '--end-of-options', range, '--'];
    const log = await std.exec.git(ctx, 'log', ['log', ...args]);
    const { confidence, status, survivors } = await std.patterns.falsify(ctx, {
      id: 'incident',
      team: { theorist: ctx.roster.Reviewer, falsifier: ctx.roster.Skeptic },
      question,
      evidence: `${std.text.section(`Commits in ${range}`, log)}\n\n${std.text.section('Notes', notes)}`,
    });
    return { confidence, status, survivors };
  },
});

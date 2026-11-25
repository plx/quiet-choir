import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-vote',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(3, 7) }),
  output: std.patterns.VoteResult,
  async run(ctx, { range, seats }) {
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    const diff = std.text.fence(await std.exec.diff(ctx, 'diff', range), 'diff');
    return std.patterns.vote(ctx, {
      id: 'vote',
      team: { voter: ctx.roster.Skeptic },
      question: `Is the change in ${range} safe to merge, breaking no existing caller or behavior?`,
      context: `${std.text.section('Files', stat)}\n\n${std.text.section('Diff', diff)}`,
      seats,
      rule: 'unanimous', // A single no, or a failed seat, means the change is not cleared.
    });
  },
});

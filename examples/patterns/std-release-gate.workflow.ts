import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-release-gate',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(1, 5) }),
  output: std.patterns.GateResult,
  async run(ctx, { range, seats }) {
    const commits = std.text.commits(await std.exec.log(ctx, 'commits', range));
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    return std.patterns.gate(ctx, {
      id: 'gate',
      team: { assessor: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      task: `Assess whether the release ${range} is ready to ship.`,
      subject: `${std.text.section('Commits', commits)}\n\n${std.text.section('Diff stat', stat)}`,
      seats, // Skeptics per reported blocker; a blocker they refute counts as a concern.
    });
  },
});

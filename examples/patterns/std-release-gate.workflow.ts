import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-release-gate',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(1, 5) }),
  output: z.object({
    decision: std.types.GateDecision,
    status: z.enum(['complete', 'degraded']),
    reasons: z.array(z.string()),
  }),
  async run(ctx, { range, seats }) {
    // `--end-of-options` keeps a range such as `--output=x` from being read as an option.
    const git = (id: string, ...args: [string, ...string[]]) =>
      std.exec.git(ctx, id, [...args, '--end-of-options', range, '--']);
    const commits = await git('commits', 'log', '--format=%h %s');
    const stat = await git('stat', 'diff', '--stat');
    const { decision, status, reasons } = await std.patterns.gate(ctx, {
      id: 'gate',
      team: { assessor: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      task: `Assess whether the release ${range} is ready to ship.`,
      subject: `${std.text.section('Commits', commits)}\n${std.text.section('Diff stat', stat)}`,
      seats,
    });
    return { decision, status, reasons };
  },
});

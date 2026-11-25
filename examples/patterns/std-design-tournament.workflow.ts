import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-design-tournament',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ brief: z.string().min(1), judges: std.types.limit(3, 7) }),
  output: z.object({
    status: z.enum(['complete', 'degraded', 'aborted']),
    winner: z.string().nullable(),
    design: z.string().nullable(),
    standings: z.array(z.object({ entrant: z.string(), score: z.number().nullable() })),
    dissent: z.array(z.string()),
  }),
  async run(ctx, { brief, judges }) {
    const { Planner, Judge } = ctx.roster;
    const result = await std.patterns.tournament(ctx, {
      id: 'tournament',
      team: { proposer: Planner, judge: Judge, synthesizer: Planner },
      brief,
      judges,
    });
    const standings = result.standings.map(({ entrant, score }) => ({ entrant, score }));
    const { status, design, dissent } = result;
    return { status, winner: result.winner?.entrant ?? null, design, standings, dissent };
  },
});

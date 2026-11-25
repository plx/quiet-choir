import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-design-tournament',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ brief: z.string().min(1), judges: std.types.limit(3, 7) }),
  output: std.patterns.TournamentResult,
  run: (ctx, { brief, judges }) =>
    std.patterns.tournament(ctx, {
      id: 'tournament',
      // A Planner proposes per design lens, Judges score blind, and a Planner builds on the winner.
      team: {
        proposer: ctx.roster.Planner,
        judge: ctx.roster.Judge,
        synthesizer: ctx.roster.Planner,
      },
      brief,
      judges,
    }),
});

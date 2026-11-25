import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-bug-hunt',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({
    scope: z.string().min(1),
    rounds: std.types.limit(4, 10),
    maxCalls: std.types.limit(80, 400),
  }),
  // `findings` holds the confirmed bugs, most severe first; `ended` says why the hunt stopped.
  output: std.patterns.HuntResult,
  run: (ctx, { scope, rounds, maxCalls }) =>
    std.patterns.hunt(ctx, {
      id: 'hunt',
      team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      subject: scope,
      rounds,
      maxCalls,
    }),
});

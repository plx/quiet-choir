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
  output: z.object({ status: z.string(), rounds: z.int(), findings: z.array(std.types.Finding) }),
  async run(ctx, { scope, rounds, maxCalls }) {
    const hunt = await std.patterns.hunt(ctx, {
      id: 'hunt',
      team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      subject: scope,
      rounds,
      maxCalls,
    });
    // Each outcome list is already sorted most severe first.
    return {
      status: hunt.status,
      rounds: hunt.rounds,
      findings: hunt.confirmed.map((v) => v.item),
    };
  },
});

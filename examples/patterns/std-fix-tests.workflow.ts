import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-fix-tests',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic, Surgeon: std.roles.Surgeon }),
  input: z.object({
    check: std.types.Argv.default(['npm', 'test']),
    rounds: std.types.limit(3, 6),
    task: z.string().min(1).optional(),
  }),
  // `outcome` is the check command's verdict; no agent report can make it green.
  output: std.patterns.FixUntilGreenResult,
  run: (ctx, input) =>
    std.patterns.fixUntilGreen(ctx, {
      id: 'fix',
      team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
      ...input,
    }),
});

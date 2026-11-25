import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-escalate',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic, Surgeon: std.roles.Surgeon }),
  input: z.object({
    task: z.string().min(1),
    check: std.types.Argv.default(['npm', 'test']),
    attempts: std.types.limit(2, 4),
  }),
  output: std.patterns.EscalateResult(),
  run: (ctx, { task, check, attempts }) =>
    std.patterns.escalate(ctx, {
      id: 'change',
      team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
      task,
      attempts,
      // Accept only work reported done that passes the check, recorded as attempt/<n>/check.
      async accept(report) {
        if (report.status !== 'done') return `The work is ${report.status}: ${report.summary}`;
        const result = await std.exec.check(ctx, 'check', check);
        return result.passed || `${check.join(' ')} failed:\n\n${std.text.fence(result.output)}`;
      },
    }),
});

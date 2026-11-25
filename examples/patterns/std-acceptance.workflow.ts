import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-acceptance',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), criteria: std.types.Criteria }),
  output: std.patterns.ChecklistResult,
  async run(ctx, { range, criteria }) {
    const diff = await std.exec.diff(ctx, 'diff', range);
    return std.patterns.checklist(ctx, {
      id: 'acceptance',
      team: { checker: ctx.roster.Reviewer },
      subject: `The change in ${range}, as git diff shows it:\n\n${std.text.fence(diff, 'diff')}`,
      criteria,
    });
  },
});

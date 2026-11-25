import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-code-review',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  output: z.object({ status: z.string(), findings: z.array(std.types.Finding) }),
  async run(ctx, { range }) {
    const diff = std.text.fence(await std.exec.diff(ctx, 'diff', range), 'diff');
    const { results, failed } = await std.patterns.lensPanel(ctx, {
      id: 'review',
      team: { reader: ctx.roster.Reviewer },
      lenses: std.lenses.review,
      task: `Review the changes in ${range} below for defects.`,
      subject: diff,
      schema: std.types.Findings,
    });
    const found = results.flatMap((answer) => answer.value.findings);
    const verdicts = await std.patterns.verify(ctx, {
      id: 'verify',
      team: { skeptic: ctx.roster.Skeptic },
      items: std.data.dedupeBy(found, std.data.findingKey),
      context: `The changes in ${range}:\n\n${diff}`,
    });
    const status = failed.length + verdicts.failedVotes === 0 ? 'complete' : 'degraded';
    return { status, findings: std.data.bySeverity(verdicts.confirmed.map((v) => v.item)) };
  },
});

import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-changelog',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  // `result` holds the notes; `coverage.missing` lists the commits of chunks whose mapper failed.
  output: std.patterns.MapReduceResult(std.types.Changes),
  async run(ctx, { range }) {
    const commits = await std.exec.log(ctx, 'commits', range);
    return std.patterns.mapReduce(ctx, {
      id: 'notes',
      team: { mapper: ctx.roster.Scribe, reducer: ctx.roster.Writer },
      items: commits,
      key: (commit) => commit.sha,
      describe: (commit) => commit.subject,
      task: `Turn these commits from ${range} into change-log entries, one per distinct change.`,
      schema: std.types.Changes,
      reduce: 'Write Markdown release notes: breaking changes and migrations first, then by kind.',
    });
  },
});

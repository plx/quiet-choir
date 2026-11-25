import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-changelog',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  output: z.object({ status: z.string(), notes: z.string(), missing: z.array(std.types.Sha) }),
  async run(ctx, { range }) {
    const shas = await std.exec.commits(ctx, 'commits', range);
    const log = await std.exec.git(ctx, 'subjects', ['log', '--format=%H %s', range, '--']);
    const lines = log.split('\n');
    // Coverage is computed from the chunks that succeeded: a failed chunk's commits are missing.
    const notes = await std.patterns.mapReduce(ctx, {
      id: 'notes',
      team: { mapper: ctx.roster.Scribe, reducer: ctx.roster.Writer },
      items: shas,
      describe: (sha) => lines.find((line) => line.startsWith(sha)) ?? sha,
      task: `Turn these commits from ${range} into change-log entries, one per distinct change.`,
      schema: std.types.Changes,
      reduce: 'Write Markdown release notes: breaking changes and migrations first, then by kind.',
    });
    return { status: notes.status, notes: notes.result, missing: notes.coverage.missing };
  },
});

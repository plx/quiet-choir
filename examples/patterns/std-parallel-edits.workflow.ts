import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-parallel-edits',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic }),
  input: z.object({ edits: z.array(std.types.Step).min(1).max(12), message: z.string().min(1) }),
  output: z.object({
    status: z.enum(['complete', 'degraded']),
    commit: z.string().nullable(),
    merged: z.array(z.string()),
    conflicts: z.array(z.string()),
    violations: z.array(z.object({ key: z.string(), files: z.array(z.string()) })),
    unchanged: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  run: (ctx, { edits, message }) =>
    std.patterns.isolatedEdits(ctx, {
      id: 'edits',
      team: { editor: ctx.roster.Mechanic },
      items: edits,
      key: (edit) => edit.id,
      task: (edit) => edit.description,
      owns: (edit) => edit.files, // Each edit may change only its own files, so the merge is clean.
      merge: { strategy: 'squash', commit: { message } },
    }),
});

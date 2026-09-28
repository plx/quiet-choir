import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'github-snapshot',
  version: '1',
  input: z.object({ repo: z.string(), pr: z.int().positive() }),
  output: z.object({ headRefOid: z.string(), state: z.string() }),
  async run(ctx, input) {
    return ctx.exec.json(
      'pr-snapshot',
      ['gh', 'pr', 'view', String(input.pr), '-R', input.repo, '--json', 'headRefOid,state'],
      { schema: z.object({ headRefOid: z.string(), state: z.string() }) },
    );
  },
});

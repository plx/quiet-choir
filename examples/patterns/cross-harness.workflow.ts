import { defineWorkflow, z } from '../../src/index.js';

const Reviewer = z.object({
  id: z.string(),
  harness: z.enum(['claude', 'codex']),
  lens: z.string(),
});
const Verdict = z.object({ approved: z.boolean(), reason: z.string() });
export default defineWorkflow({
  name: 'cross-harness',
  version: '1',
  input: z.object({ topic: z.string(), reviewers: z.array(Reviewer).max(8) }),
  output: z.array(Verdict),
  async run(ctx, input) {
    return ctx.map('panel', input.reviewers, { concurrency: 2, key: (r) => ctx.id(r.id) }, (r) => {
      const options = { prompt: `${r.lens}: ${input.topic}`, schema: Verdict };
      return ctx.agent(r.harness).value('verdict', options);
    });
  },
});

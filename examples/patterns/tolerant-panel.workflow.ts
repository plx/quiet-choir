import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'tolerant-panel',
  version: '2',
  input: z.object({ topic: z.string(), lenses: z.array(z.string()).min(1).max(8) }),
  output: z.object({ quorum: z.boolean(), answers: z.array(z.string()) }),
  async run(ctx, input) {
    const { quorum, answers } = await std.patterns.tolerantPanel(ctx, {
      id: 'panel',
      team: { panelist: ctx.claude.bind({}) },
      items: input.lenses,
      prompt: (lens) => `${lens}: ${input.topic}`,
      concurrency: 2,
    });
    return { quorum, answers };
  },
});

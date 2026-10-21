import { defineWorkflow, z } from '../../src/index.js';
import { roster } from './roster.js';

export default defineWorkflow({
  name: 'work-then-extract',
  version: '1',
  roster,
  input: z.object({ task: z.string() }),
  output: z.object({ summary: z.string(), ready: z.boolean() }),
  async run(ctx, input) {
    const report = await ctx.roster.CodexReader.value('work', { prompt: input.task });
    return ctx.claude.value('extract', {
      prompt: `Extract a concise summary and readiness decision from this report: ${report}`,
      schema: z.object({ summary: z.string(), ready: z.boolean() }),
    });
  },
});

import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-research',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), reads: std.types.limit(6, 20) }),
  output: z.object({
    status: z.enum(['complete', 'degraded', 'unanswered']),
    answer: z.string(),
    sources: z.array(std.types.Lead),
  }),
  async run(ctx, { question, reads }) {
    // Researchers search the web from each default angle and read; the tool-free Writer cites.
    const { status, answer, sources } = await std.patterns.research(ctx, {
      id: 'research',
      team: {
        scout: ctx.roster.Researcher,
        reader: ctx.roster.Researcher,
        synthesizer: ctx.roster.Writer,
      },
      question,
      reads,
    });
    return { status, answer, sources };
  },
});

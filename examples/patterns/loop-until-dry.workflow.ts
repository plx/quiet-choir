import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'loop-until-dry',
  version: '1',
  input: z.object({ topic: z.string(), rounds: z.int().min(1).max(10) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    const known: string[] = [];
    for (let round = 0; round < input.rounds; round++) {
      const result = await ctx.claude.value(`hunt/${String(round)}`, {
        prompt: `${input.topic}; list new findings beyond ${JSON.stringify(known)}.`,
        schema: z.object({ findings: z.array(z.string()) }),
      });
      const fresh = [...new Set(result.findings)].filter((finding) => !known.includes(finding));
      if (fresh.length === 0) break;
      known.push(...fresh);
    }
    return known;
  },
});

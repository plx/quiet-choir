import { defineWorkflow, z } from '../src/index.js';

// A small real workflow: Claude proposes a label, Codex checks it. Both calls are durable.
export default defineWorkflow({
  name: 'duet',
  version: '1',
  input: z.object({ topic: z.string().min(1).max(120) }),
  output: z.object({ label: z.string(), accepted: z.boolean(), reason: z.string() }),
  async run(ctx, input) {
    const proposal = await ctx.claude.object('propose', {
      prompt: `Suggest a short, plain English label for this topic: ${input.topic}. Return the schema. Do not use tools.`,
      model: 'haiku',
      maxTurns: 3,
      maxBudgetUsd: 0.1,
      schema: z.object({ label: z.string() }),
    });
    const review = await ctx.codex.object('review', {
      prompt: `Is this label understandable? Topic: ${input.topic}. Label: ${proposal.output.label}. Give a boolean and a one-sentence reason. Do not use tools.`,
      reasoningEffort: 'low',
      schema: z.object({ accepted: z.boolean(), reason: z.string() }),
    });
    return { label: proposal.output.label, ...review.output };
  },
});

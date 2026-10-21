import { defineWorkflow, z } from '../../../src/index.js';

const verdict = z.object({ ok: z.boolean() });

// Calls through bound agents (ADR 0063): binding is not an effect, and distinct IDs are clean.
// The lint resolves ID namespaces only through .claude, .codex and .agent(x) receivers, so the
// reused 'again' ID through a bound agent is not reported (a known coverage gap, not a finding).
export default defineWorkflow({
  name: 'durability-bound-agent',
  version: '1',
  input: z.null(),
  output: z.boolean(),
  async run(ctx) {
    const reviewer = ctx.claude.bind({ model: 'opus', tools: ['Read'] });
    const mechanic = ctx.codex.bind({ sandbox: 'read-only' }).bind({ timeoutMs: 1_000 });
    const first = await reviewer.value('review', { prompt: 'x', schema: verdict });
    const second = await ctx.claude.bind({ effort: 'high' }).value('inline', { prompt: 'y' });
    await mechanic.text('again', { prompt: 'z' });
    await mechanic.text('again', { prompt: 'z' });
    return first.ok && second.length > 0;
  },
});

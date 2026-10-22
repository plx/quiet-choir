import { defineWorkflow, z } from '../../src/index.js';
import { deskRoster, jev, resolved, route } from './deciders.js';

const minConfidence = 0.7; // a threshold is ordinary code; a low-confidence answer is a result

export default defineWorkflow({
  name: 'decide-then-act',
  version: '1',
  decisions: [jev],
  roster: deskRoster,
  input: z.object({ ticket: z.string() }),
  output: z.object({ outcome: z.enum(['escalated', 'sent', 'needs-review']), reply: z.string() }),
  async run(ctx, input) {
    const triage = await ctx.roster.Triage.decide('triage', { state: input, questions: { route } });
    if (triage.route.choice === 'escalate' || triage.route.confidence < minConfidence)
      return { outcome: 'escalated', reply: '' }; // conservative: no agent runs
    const reply = await ctx.roster.Responder.value('reply', {
      prompt: `Draft a reply to this support ticket:\n${input.ticket}`,
    });
    // The same step as ctx.decide('grade', { provider: 'jev', ... }), plus meta.roster 'Grader'.
    const grade = await ctx.roster.Grader.decide('grade', {
      state: { ticket: input.ticket, reply },
      questions: { resolved },
    });
    return { outcome: grade.resolved.noul >= 0.9 ? 'sent' : 'needs-review', reply };
  },
});

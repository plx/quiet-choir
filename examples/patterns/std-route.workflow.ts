import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const routes = {
  question: 'Asks how something works or where it is; the code and its docs can answer it.',
  bug: 'Reports behavior that is broken or differs from what the docs promise.',
  feature: 'Asks for new behavior or a change to existing behavior.',
  unclear: 'Does not say enough to act on.',
};

export default defineWorkflow({
  name: 'std-route',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ request: z.string().min(1) }),
  output: z.object({ routed: std.patterns.RouteResult(routes), reply: z.string() }),
  async run(ctx, { request }) {
    const { Clerk, Reader, Reviewer, Planner, Writer } = ctx.roster;
    const options = { id: 'route', team: { router: Clerk }, subject: request, routes };
    const routed = await std.patterns.route(ctx, { ...options, fallback: 'unclear' });
    const ask = (task: string) => ({ prompt: std.text.brief({ task, context: request }) });
    const reply = await {
      question: () => Reader.value('answer', ask('Answer the question below, citing file:line.')),
      bug: () => Reviewer.value('diagnose', ask('Find the cause of the bug below, at file:line.')),
      feature: () => Planner.value('scope', ask('Scope the feature below; list open questions.')),
      unclear: () => Writer.value('clarify', ask('Ask its author what the request below lacks.')),
    }[routed.route]();
    return { routed, reply };
  },
});

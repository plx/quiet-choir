// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'acceptance-qa-batch',
  description:
    'Per ticket: demonstrate every acceptance criterion against the real code with captured evidence, then attack the feature adversarially; pass = demonstrated AND unbroken',
  whenToUse:
    'Acceptance QA on finished work — verifying tickets meet their own criteria before merge or release, beyond unit-test green',
  phases: [
    { title: 'Ingest', detail: 'parse tickets and acceptance criteria' },
    { title: 'Demonstrate', detail: 'evidence agent per ticket, AC by AC' },
    { title: 'Break', detail: 'adversary attacks passing tickets' },
  ],
};
export const input = z.object({
  ...executionInput,
  tickets: z.string().optional(),
  scope: z.string().optional(),
  maxTickets: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const TICKETS_SCHEMA = z
      .object({
        tickets: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              description: z.string().optional(),
              acceptanceCriteria: z.array(z.string()),
            })
            .catchall(z.json()),
        ),
        runContext: z
          .string()
          .describe('how to run/exercise this project: commands, entry points, test invocations')
          .optional(),
      })
      .catchall(z.json());

    const DEMO_SCHEMA = z
      .object({
        criteria: z.array(
          z
            .object({
              criterion: z.string(),
              status: z.enum(['demonstrated', 'failed', 'undemonstrable']),
              evidence: z
                .string()
                .describe('the command/test/output that proves it — concrete, reproducible'),
            })
            .catchall(z.json()),
        ),
        notes: z.string().optional(),
      })
      .catchall(z.json());

    const BREAK_SCHEMA = z
      .object({
        breaks: z.array(
          z
            .object({
              description: z.string(),
              reproduction: z.string().describe('exact steps/inputs that trigger it'),
              severity: z.enum(['breaks-criterion', 'degrades', 'cosmetic']),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.tickets) {
      return {
        error:
          'acceptance-qa-batch requires args: { tickets } — a backlog file path or ticket content with acceptance criteria. Optional: { scope, maxTickets }',
      };
    }
    const ticketsRef = args.tickets.includes('\n')
      ? `these tickets:\n---\n${args.tickets}\n---`
      : `the tickets at ${args.tickets} (read fully)`;
    const scope = (args && args.scope) || 'the current repository';
    const maxTickets = (args && args.maxTickets) || 8;

    // ---------------------------------------------------------------------------
    // Phase 1: Ingest — structure the tickets and, critically, work out HOW this
    // project is exercised (the runContext every downstream agent needs).
    // ---------------------------------------------------------------------------

    port.phase('Ingest');

    const ingested = await ctx.claude
      .object(port.id('agent-1', 'ingest'), {
        ...args.$claude,
        prompt: `Parse ${ticketsRef} into structured tickets with their acceptance criteria.
   Skip tickets with no checkable criteria (note them). Then inspect ${scope}
   and report runContext: exactly how an agent can exercise this project —
   install/build commands, how to start it, how to run its tests, entry points.`,
        schema: TICKETS_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!ingested || ingested.tickets.length === 0) {
      return { tickets: [], passed: 0, failed: 0, deferred: 0 };
    }
    const chosen = ingested.tickets.slice(0, maxTickets);
    const deferred = ingested.tickets.length - chosen.length;
    if (deferred > 0) port.log(`Cap: verifying ${chosen.length} tickets, deferring ${deferred}`);

    // ---------------------------------------------------------------------------
    // Phases 2-3 as a pipeline: demonstrate -> break per ticket, independently.
    // Demonstration and destruction are different skills, so they are different
    // agents. The break stage runs only on tickets whose criteria all demonstrated
    // — there is nothing to defend on a ticket that already failed its own ACs.
    // New per-ticket, no cross-ticket dependency => pipeline, no barrier.
    // ---------------------------------------------------------------------------

    const results = await port.pipeline(
      'pipeline-1',
      chosen,

      // Stage 1: demonstrate every AC with reproducible evidence.
      (t) =>
        ctx.claude
          .object(port.id('agent-2', `demo:${t.id}`), {
            ...args.$claude,
            prompt: `Demonstrate that ticket ${t.id} ("${t.title}") meets its acceptance criteria,
     against the real implementation in ${scope}.
     Criteria: ${JSON.stringify(t.acceptanceCriteria)}
     How to exercise this project: ${ingested.runContext || 'discover it'}
     For each criterion, produce reproducible EVIDENCE it holds — the command run
     and its output, the test that exercises it, the request/response. Ground
     every verdict in what you actually ran or read, never in the ticket's own
     description. status: demonstrated / failed / undemonstrable (needs an
     environment you lack — say so, don't fake it).`,
            schema: DEMO_SCHEMA,
            // Original phase: 'Demonstrate'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((demo) => ({ ticket: t, demo })),

      // Stage 2: adversary attacks the feature — but only if it earned defending.
      (r) => {
        if (!r || !r.demo) return { ...r, breakResult: undefined };
        const allShown =
          r.demo.criteria.length > 0 && r.demo.criteria.every((c) => c.status === 'demonstrated');
        if (!allShown) return { ...r, breakResult: { breaks: [] } }; // already failing; no point attacking
        return ctx.claude
          .object(port.id('agent-3', `break:${r.ticket.id}`), {
            ...args.$claude,
            prompt: `Ticket ${r.ticket.id} ("${r.ticket.title}") passed its acceptance criteria.
       Now try to BREAK the feature. Exercise its edges in ${scope}: malformed and
       boundary inputs, permission and auth gaps, concurrency, empty/huge data,
       the interactions its criteria never mention. How to run it: ${ingested.runContext || 'discover it'}.
       Report only breaks you can REPRODUCE, each with exact steps. severity
       breaks-criterion means it defeats an acceptance criterion in a case the
       criterion should have covered. Coming back empty-handed is a real result.`,
            schema: BREAK_SCHEMA,
            // Original phase: 'Break'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((breakResult) => ({ ...r, breakResult }));
      },
    );

    // ---------------------------------------------------------------------------
    // Verdicts, computed in code: a ticket passes only when every criterion is
    // demonstrated AND the breaker found nothing that defeats a criterion.
    // ---------------------------------------------------------------------------

    port.phase('Break');

    const graded = results.filter(Boolean).map((r) => {
      const criteria = r.demo ? r.demo.criteria : [];
      const breaks = (r.breakResult && r.breakResult.breaks) || [];
      const allShown = criteria.length > 0 && criteria.every((c) => c.status === 'demonstrated');
      const criterionBreak = breaks.some((b) => b.severity === 'breaks-criterion');
      const undemonstrable = criteria.some((c) => c.status === 'undemonstrable');
      const verdict =
        allShown && !criterionBreak ? (undemonstrable ? 'pass-pending-manual' : 'pass') : 'fail';
      return { id: r.ticket.id, title: r.ticket.title, verdict, criteria, breaks };
    });

    const passed = graded.filter(
      (g) => g.verdict === 'pass' || g.verdict === 'pass-pending-manual',
    ).length;
    const failed = graded.filter((g) => g.verdict === 'fail').length;
    port.log(
      `QA: ${passed}/${graded.length} tickets pass${deferred ? `, ${deferred} deferred` : ''}`,
    );

    return { tickets: graded, passed, failed, deferred };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});

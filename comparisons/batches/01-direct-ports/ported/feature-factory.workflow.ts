// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';
import { runChild } from './children.js';
import prd_decompose from './prd-decompose.workflow.js';
import deep_code_review from './deep-code-review.workflow.js';

export const meta = {
  name: 'feature-factory',
  description:
    'Conductor: prd-decompose the spec, implement disjoint modules in parallel, deep-code-review each module as a sub-workflow, repair confirmed findings, verify globally',
  whenToUse:
    'PRD-to-reviewed-code for a feature sized to one repo — or as the template for composing your own multi-workflow conductors',
  phases: [
    { title: 'Decompose', detail: 'prd-decompose sub-workflow -> ticketed backlog' },
    { title: 'Plan modules', detail: 'group tickets into disjoint file-area modules' },
    { title: 'Implement', detail: 'foundations first, then parallel module builders' },
    { title: 'Review', detail: 'one deep-code-review sub-workflow per module' },
    { title: 'Stabilize', detail: 'repair confirmed findings, verify globally' },
  ],
};
export const input = z.object({
  ...executionInput,
  prd: z.string().optional(),
  maxModules: z.number().int().nonnegative().optional(),
  codebase: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const MODULES_SCHEMA = z
      .object({
        modules: z.array(
          z
            .object({
              name: z.string(),
              ticketIds: z.array(z.string()),
              fileAreas: z
                .array(z.string())
                .describe(
                  'paths/globs this module owns — MUST be disjoint from every other module',
                ),
              isFoundation: z
                .boolean()
                .describe(
                  'true if other modules depend on this (schema, scaffolding, shared types)',
                ),
              notes: z.string().optional(),
            })
            .catchall(z.json()),
        ),
        deferred: z
          .array(z.string())
          .describe('ticket ids that fit no module slot this run')
          .optional(),
      })
      .catchall(z.json());

    const IMPL_SCHEMA = z
      .object({
        status: z.enum(['done', 'partial', 'blocked']),
        summary: z.string(),
        filesTouched: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    const VERIFY_SCHEMA = z
      .object({
        passed: z.boolean(),
        summary: z.string(),
        failures: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    if (!args || !args.prd) {
      return {
        error: 'feature-factory requires args: { prd }. Optional: { codebase, maxModules }',
      };
    }
    const maxModules = (args && args.maxModules) || 4;

    // ---------------------------------------------------------------------------
    // Phase 1: Decompose — the first child workflow. Its structured return
    // (tickets with acceptance criteria, lanes, dependencies) IS our input; we
    // never re-read the PRD here. Guard the result like any agent(): a child can
    // fail, and a conductor that assumes success fabricates one.
    // ---------------------------------------------------------------------------

    port.phase('Decompose');

    const backlog = await runChild(ctx, port.id('child-1'), prd_decompose, {
      ...{ prd: args.prd, codebase: args.codebase },
      $claude: args.$claude,
    });

    if (!backlog || !backlog.tickets || backlog.tickets.length === 0) {
      return {
        backlog: null,
        modules: [],
        verification: null,
        deferred: [],
        notes: 'prd-decompose returned no tickets — nothing to build.',
      };
    }
    port.log(`Backlog: ${backlog.tickets.length} tickets. ${backlog.coverage || ''}`);

    // ---------------------------------------------------------------------------
    // Phase 2: Plan modules — the glue only the conductor can supply. Disjoint
    // fileAreas are what make Phase 3's parallel builders safe in one shared
    // tree (same rule as api-migration: disjointness by construction beats
    // worktree machinery, and reviews need the diffs in the main tree anyway).
    // ---------------------------------------------------------------------------

    port.phase('Plan modules');

    const plan = await ctx.claude
      .object(port.id('agent-1', 'plan'), {
        ...args.$claude,
        prompt: `Group this backlog into at most ${maxModules} implementation modules for
   parallel builders working in ONE shared checkout.
   Tickets: ${JSON.stringify(backlog.tickets, null, 2)}
   Sequencing notes: ${backlog.sequencing || 'none'}
   Rules: every module owns explicit fileAreas and NO two modules may overlap —
   shared scaffolding (schemas, types, config, migrations) goes into a single
   foundation module others build on. Respect ticket dependsOn edges: a ticket
   may not land in a module that builds before its dependency's module. Tickets
   that fit no slot go in deferred (do not silently drop any id).`,
        schema: MODULES_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!plan || plan.modules.length === 0) {
      return {
        backlog,
        modules: [],
        verification: null,
        deferred: [],
        notes: 'Module planning failed — backlog produced but nothing implemented.',
      };
    }
    const foundations = plan.modules.filter((m) => m.isFoundation);
    const features = plan.modules.filter((m) => !m.isFoundation);
    port.log(
      `${plan.modules.length} modules (${foundations.length} foundation), ${(plan.deferred || []).length} tickets deferred`,
    );

    // ---------------------------------------------------------------------------
    // Phase 3: Implement — foundations sequentially (everything depends on them),
    // then feature modules in parallel (disjoint by construction). Builders run
    // only narrow checks; the global gate is Phase 5's job.
    // ---------------------------------------------------------------------------

    port.phase('Implement');

    const ticketById = new Map(backlog.tickets.map((t) => [t.id, t]));
    const buildModule = (m) =>
      ctx.claude
        .object(port.id('agent-2', `build:${m.name}`), {
          ...args.$claude,
          prompt: `Implement the "${m.name}" module. You own ONLY these file areas: ${m.fileAreas.join(', ')}
   — do not touch files outside them (another builder owns those).
   Tickets, in order: ${JSON.stringify(m.ticketIds.map((id) => ticketById.get(id)).filter(Boolean), null, 2)}
   ${m.notes || ''}
   Satisfy each ticket's acceptance criteria. Match the codebase's existing
   conventions. Run only narrow checks (compile the touched files, run directly
   related tests) — a global verifier runs later. Report honestly: "partial"
   with blockers beats a hollow "done".`,
          schema: IMPL_SCHEMA,
          // Original phase: 'Implement' — no matching ClaudeOptions control.
        })
        .then((result) => result.output)
        .then((r) => ({ module: m, impl: r }));

    const built = [];
    for (const f of foundations) {
      built.push(await buildModule(f)); // sequential: parallel features build on this
    }
    // GAP: no shared token ledger; feature modules always proceed after foundations.
    {
      built.push(
        ...(
          await port.parallel(
            'parallel-1',
            features.map((m) => () => buildModule(m)),
          )
        ).filter(Boolean),
      );
    }

    const implemented = built.filter((b) => b.impl && b.impl.status !== 'blocked');
    const blocked = built.filter((b) => !b.impl || b.impl.status === 'blocked');
    port.log(
      `${implemented.length}/${plan.modules.length} modules implemented${blocked.length ? `; blocked: ${blocked.map((b) => b.module.name).join(', ')}` : ''}`,
    );

    // ---------------------------------------------------------------------------
    // Phase 4: Review — one deep-code-review CHILD per implemented module, run
    // concurrently (children share the run's concurrency cap; the harness
    // interleaves their agents). Each child gets a target scoped to the module's
    // file areas, and returns adversarially-verified findings — the conductor
    // trusts the child's verification and never re-litigates it.
    // ---------------------------------------------------------------------------

    port.phase('Review');

    const reviews = (
      await port.parallel(
        'parallel-2',
        implemented.map(
          (b) => () =>
            runChild(ctx, port.id('child-2'), deep_code_review, {
              ...{
                target: `the uncommitted working-tree changes under these paths only: ${b.module.fileAreas.join(', ')}`,
              },
              $claude: args.$claude,
            }).then((r) => ({ module: b.module, review: r })),
        ),
      )
    ).filter(Boolean);

    const withFindings = reviews.filter(
      (r) => r.review && r.review.confirmed && r.review.confirmed.length > 0,
    );
    port.log(
      `Reviews: ${reviews.length} modules reviewed, ${withFindings.length} with confirmed findings`,
    );

    // ---------------------------------------------------------------------------
    // Phase 5: Stabilize — module-scoped repairs for confirmed findings (already
    // adversarially verified by the child — repair, don't re-judge), then one
    // global verify with an honest exit.
    // ---------------------------------------------------------------------------

    port.phase('Stabilize');

    await port.parallel(
      'parallel-3',
      withFindings.map(
        (r) => () =>
          ctx.claude
            .text(port.id('agent-3', `repair:${r.module.name}`), {
              ...args.$claude,
              prompt: `Fix these confirmed code-review findings in the "${r.module.name}" module
     (file areas: ${r.module.fileAreas.join(', ')} — stay inside them).
     Findings (already adversarially verified — do not re-litigate, fix):
     ${JSON.stringify(r.review.confirmed, null, 2)}
     Run only the narrow checks for what you change.`,

              // Original phase: 'Stabilize' — no matching ClaudeOptions control.
            })
            .then((result) => result.output),
      ),
    );

    const verification = await ctx.claude
      .object(port.id('agent-4', 'verify'), {
        ...args.$claude,
        prompt: `Global verification: run this repository's build/typecheck and full test
   suite (find the commands). The changes implement: ${JSON.stringify(plan.modules.map((m) => m.name))}.
   Report pass/fail with failures clustered by root cause. Do not fix anything.`,
        schema: VERIFY_SCHEMA,
        // Original phase: 'Stabilize' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    return {
      backlog: {
        tickets: backlog.tickets.length,
        coverage: backlog.coverage,
        openQuestions: backlog.openQuestions,
      },
      modules: built.map((b) => ({
        name: b.module.name,
        status: b.impl ? b.impl.status : 'error',
        summary: b.impl ? b.impl.summary : null,
        reviewFindings:
          (reviews.find((r) => r.module.name === b.module.name) || {}).review?.confirmed?.length ??
          null,
      })),
      verification: verification ? verification.summary : 'verifier unavailable',
      deferred: plan.deferred || [],
      notes:
        [
          blocked.length
            ? `Blocked modules need attention: ${blocked.map((b) => b.module.name).join(', ')}.`
            : null,
          verification && !verification.passed
            ? 'Global verification failed — see verification; a follow-up stabilize run or human review is needed.'
            : null,
        ]
          .filter(Boolean)
          .join(' ') || 'All modules implemented, reviewed, and verified.',
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});

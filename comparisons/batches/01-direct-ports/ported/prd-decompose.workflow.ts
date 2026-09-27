// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'prd-decompose',
  description:
    'Read a PRD through five parallel lenses, merge into deduplicated tickets with acceptance criteria, and verify coverage with a reverse-direction critic',
  whenToUse:
    'Sprint planning from a PRD or spec — producing a backlog whose error states, migrations, and instrumentation are ticketed, not just the happy path',
  phases: [
    { title: 'Decompose', detail: 'five lenses read the PRD in parallel' },
    { title: 'Merge', detail: 'judgment-dedupe into tickets with ACs' },
    { title: 'Verify coverage', detail: 'PRD-to-backlog critic + repair round' },
  ],
};
export const input = z.object({
  ...executionInput,
  prd: z.string().optional(),
  codebase: z.string().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const ITEMS_SCHEMA = z
      .object({
        items: z.array(
          z
            .object({
              title: z.string(),
              description: z.string(),
              prdAnchor: z
                .string()
                .describe(
                  'the PRD sentence/section this item comes from — every item must trace to the PRD',
                ),
              acceptanceCriteria: z.array(z.string()).optional(),
              estimate: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
            })
            .catchall(z.json()),
        ),
        openQuestions: z
          .array(z.string())
          .describe('ambiguities in the PRD this lens could not resolve')
          .optional(),
      })
      .catchall(z.json());

    const BACKLOG_SCHEMA = z
      .object({
        tickets: z.array(
          z
            .object({
              id: z.string().describe('T1, T2, ...'),
              title: z.string(),
              description: z.string(),
              acceptanceCriteria: z.array(z.string()),
              estimate: z.enum(['XS', 'S', 'M', 'L', 'XL']),
              lane: z.enum([
                'feature',
                'edge-cases',
                'non-functional',
                'infra-migration',
                'instrumentation',
              ]),
              dependsOn: z.array(z.string()).describe('ids of blocking tickets').optional(),
              prdAnchors: z.array(z.string()).optional(),
            })
            .catchall(z.json()),
        ),
        sequencing: z
          .string()
          .describe('suggested milestone grouping and the critical path, one paragraph'),
        openQuestions: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    const COVERAGE_SCHEMA = z
      .object({
        covered: z.boolean(),
        gaps: z.array(
          z
            .object({
              prdRequirement: z.string().describe('the PRD text with no adequate ticket'),
              problem: z.enum(['missing', 'under-specified', 'wrong']),
              suggestion: z.string().optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.prd) {
      return {
        error: 'prd-decompose requires args: { prd } — a file path or the PRD text itself.',
      };
    }

    const prdRef = args.prd.includes('\n')
      ? `this PRD text:\n---\n${args.prd}\n---`
      : `the PRD at ${args.prd} (read it fully)`;
    const codebase = (args && args.codebase) || null;

    // --------------------------------------------------------------------------
    // Phase 1: Five lenses, one PRD. Same diversity logic as code-review
    // dimensions: each lens has a charter AND an anti-charter, so five readers
    // produce five different item sets instead of five copies of the happy path.
    // Barrier justified: the merger needs every lens's items to dedupe.
    // --------------------------------------------------------------------------

    port.phase('Decompose');

    const LENSES = [
      {
        key: 'stories',
        charter:
          'User-facing capability, sliced into shippable stories. Each story = a user can now do X. Ignore infrastructure, error handling, and metrics — other lenses own those.',
      },
      {
        key: 'edges',
        charter:
          'Everything that goes wrong: invalid input, permission denied, empty states, conflicts, offline/timeout, partial failure, concurrent edits, abuse. One item per distinct failure the product must handle GRACEFULLY (define what graceful means each time).',
      },
      {
        key: 'non-functional',
        charter:
          'Performance targets, scale assumptions, security/privacy requirements, accessibility, i18n, compliance. Only what the PRD states or clearly implies — flag vague ones ("fast") as open questions rather than inventing numbers.',
      },
      {
        key: 'foundations',
        charter:
          'What must exist before stories can build: schema changes, migrations, new services/queues, feature flags, third-party integrations, backfill jobs. Include teardown/rollback items where a migration implies one.',
      },
      {
        key: 'instrumentation',
        charter:
          "How we know it works: analytics events with their triggers, success-metric dashboards from the PRD's goals section, alerts, A/B scaffolding if the PRD implies an experiment. If the PRD names a success metric, there must be an item that makes it measurable.",
      },
    ];

    const lensReads = await port.parallel(
      'parallel-1',
      LENSES.map(
        (l) => () =>
          ctx.claude
            .object(port.id('agent-1', `lens:${l.key}`), {
              ...args.$claude,
              prompt: `Read ${prdRef}.
     ${codebase ? `Codebase context (reference real modules in items): ${codebase}` : ''}
     Your lens: ${l.charter}
     Extract work items visible through YOUR lens only. Every item must carry a
     prdAnchor — the PRD text it traces to; if you cannot anchor it, it goes in
     openQuestions instead. Write acceptance criteria as testable statements.
     Estimate: XS(hours) S(a day) M(2-3 days) L(a week) XL(should be split).`,
              schema: ITEMS_SCHEMA,
            })
            .then((result) => result.output)
            .then((r) => ({ lens: l.key, ...r })),
      ),
    );

    const allItems = lensReads
      .filter(Boolean)
      .flatMap((r) => (r.items || []).map((i) => ({ ...i, lens: r.lens })));
    const allQuestions = [
      ...new Set(lensReads.filter(Boolean).flatMap((r) => r.openQuestions || [])),
    ];
    port.log(
      `${allItems.length} raw items from ${lensReads.filter(Boolean).length} lenses, ${allQuestions.length} open questions`,
    );

    if (allItems.length === 0) {
      return {
        tickets: [],
        sequencing: null,
        coverage: 'No items extracted — is the PRD readable?',
        openQuestions: allQuestions,
      };
    }

    // --------------------------------------------------------------------------
    // Phase 2: Merge — BY AGENT, unlike code-review's mechanical (file,line)
    // dedupe. Two lenses describing the same ticket use different words ("handle
    // upload failure" vs "show retry UI on failed upload"), so ticket identity is
    // a judgment call. Rule of thumb: dedupe by code when items share a natural
    // key; dedupe by agent when identity itself requires reading.
    // --------------------------------------------------------------------------

    port.phase('Merge');

    const backlog = await ctx.claude
      .object(port.id('agent-2', 'merge'), {
        ...args.$claude,
        prompt: `Merge these work items from five specialized readings of one PRD into a
   deduplicated backlog. Items describing the same work in different words
   become ONE ticket (union the acceptance criteria, keep all prdAnchors).
   Assign ids (T1...), lanes, and dependsOn edges (foundations before the
   stories needing them; instrumentation can trail its feature). Split any XL.
   Then write the sequencing paragraph: milestone grouping + the critical path.
   Items: ${JSON.stringify(allItems, null, 2)}
   Carry forward these open questions, deduplicated: ${JSON.stringify(allQuestions)}`,
        schema: BACKLOG_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!backlog) {
      return {
        tickets: [],
        sequencing: null,
        coverage: 'Merge failed',
        openQuestions: allQuestions,
      };
    }
    port.log(`Merged into ${backlog.tickets.length} tickets`);

    // --------------------------------------------------------------------------
    // Phase 3: Reverse-direction critic. The lenses walked PRD -> items; the
    // critic walks the PRD sentence by sentence asking "which ticket covers
    // THIS?" Omissions hide in the forward direction and are exposed in reverse.
    // One repair round, then ship the backlog with an honest coverage note.
    // --------------------------------------------------------------------------

    port.phase('Verify coverage');

    const coverage = await ctx.claude
      .object(port.id('agent-3', 'coverage-critic'), {
        ...args.$claude,
        prompt: `Audit backlog coverage BACKWARDS. Read ${prdRef} section by section; for each
   requirement, commitment, or implied behavior, find the ticket(s) covering it
   in this backlog: ${JSON.stringify(
     backlog.tickets.map((t) => ({
       id: t.id,
       title: t.title,
       acceptanceCriteria: t.acceptanceCriteria,
       prdAnchors: t.prdAnchors,
     })),
     null,
     2,
   )}
   Report gaps: PRD text with NO adequate ticket (missing), a ticket that exists
   but whose ACs don't actually cover the requirement (under-specified), or a
   ticket that contradicts the PRD (wrong). Judge coverage of the requirement's
   SUBSTANCE, not keyword overlap.`,
        schema: COVERAGE_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    let finalBacklog = backlog;
    if (coverage && !coverage.covered && coverage.gaps.length > 0) {
      port.log(`Critic found ${coverage.gaps.length} coverage gaps — one repair round`);
      const repaired = await ctx.claude
        .object(port.id('agent-4', 'repair'), {
          ...args.$claude,
          prompt: `Repair this backlog. For each gap: add a ticket (next free Tn id) or amend
     the under-specified/wrong ticket's ACs. Keep everything else unchanged.
     Backlog: ${JSON.stringify(backlog, null, 2)}
     Gaps: ${JSON.stringify(coverage.gaps, null, 2)}
     Return the complete updated backlog.`,
          schema: BACKLOG_SCHEMA,
          // Original phase: 'Verify coverage' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
      if (repaired) finalBacklog = repaired;
    }

    if (args && args.out) {
      await ctx.claude
        .text(port.id('agent-5', 'write-doc'), {
          ...args.$claude,
          prompt: `Write this backlog as a clean markdown document to ${args.out}: a summary
     table (id, title, lane, estimate, dependsOn), then each ticket with
     description and acceptance criteria, then sequencing, then open questions.
     Backlog: ${JSON.stringify(finalBacklog, null, 2)}
     Write the file and return its path.`,

          // Original phase: 'Verify coverage'; effort: 'low' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    return {
      tickets: finalBacklog.tickets,
      sequencing: finalBacklog.sequencing,
      coverage: coverage
        ? coverage.covered
          ? 'Critic confirmed full PRD coverage.'
          : `${coverage.gaps.length} gaps found and repaired in one round — re-audit if the PRD is contractual.`
        : 'Coverage critic unavailable.',
      openQuestions: finalBacklog.openQuestions || allQuestions,
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

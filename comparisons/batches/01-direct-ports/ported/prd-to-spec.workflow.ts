// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';
import { runChild } from './children.js';
import design_tournament from './design-tournament.workflow.js';

export const meta = {
  name: 'prd-to-spec',
  description:
    'Ground in the codebase, draft a technical spec through five lenses, optionally settle the top architecture decision via design-tournament, and verify implementability + PRD fidelity',
  whenToUse:
    'The step between PRD and tickets: producing a spec an engineer can build from without re-deriving the architecture inside the tickets',
  phases: [
    { title: 'Ground', detail: 'existing architecture, conventions, integration surface' },
    { title: 'Draft', detail: 'five technical lenses in parallel' },
    { title: 'Decide', detail: 'contested decisions; optional tournament child' },
    { title: 'Merge', detail: 'one spec from lenses + decisions' },
    { title: 'Verify', detail: 'implementability skeptic ∥ PRD-fidelity checker' },
  ],
};
export const input = z.object({
  ...executionInput,
  prd: z.string().optional(),
  codebase: z.string().optional(),
  decideArchitecture: z.boolean().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const GROUND_SCHEMA = z
      .object({
        summary: z.string().describe('the existing architecture in one paragraph'),
        conventions: z
          .array(z.string())
          .describe('patterns the spec must respect (error handling, naming, layering...)')
          .optional(),
        integrationPoints: z
          .array(z.string())
          .describe('where new work will attach to existing code')
          .optional(),
        constraints: z
          .array(z.string())
          .describe('realities the PRD may not know about (framework limits, tech debt walls)')
          .optional(),
      })
      .catchall(z.json());

    const LENS_SCHEMA = z
      .object({
        sections: z.array(
          z
            .object({
              heading: z.string(),
              content: z.string().describe('spec-grade markdown: concrete names, types, contracts'),
              prdAnchors: z.array(z.string()).describe('PRD requirements this section serves'),
            })
            .catchall(z.json()),
        ),
        contestedDecisions: z
          .array(
            z
              .object({
                decision: z.string(),
                options: z.array(z.string()),
                stakes: z.enum(['load-bearing', 'moderate', 'reversible']),
              })
              .catchall(z.json()),
          )
          .describe('choices with real alternatives this lens could not settle alone'),
      })
      .catchall(z.json());

    const VERIFY_SCHEMA = z
      .object({
        passed: z.boolean(),
        gaps: z.array(
          z
            .object({
              where: z.string().describe('spec section or PRD requirement'),
              problem: z.string(),
              fix: z.string(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.prd) {
      return {
        error:
          'prd-to-spec requires args: { prd }. Optional: { codebase, decideArchitecture, out }',
      };
    }
    const prdRef = args.prd.includes('\n')
      ? `this PRD:\n---\n${args.prd}\n---`
      : `the PRD at ${args.prd} (read it fully)`;
    const greenfield = args.codebase === 'greenfield';

    // ---------------------------------------------------------------------------
    // Phase 1: Ground — the spec must fit the code that exists, not the code we
    // wish existed. Skipped for greenfield.
    // ---------------------------------------------------------------------------

    port.phase('Ground');

    const ground = greenfield
      ? null
      : await ctx.claude
          .object(port.id('agent-1', 'ground'), {
            ...args.$claude,
            prompt: `Ground an upcoming technical spec in reality. Codebase: ${args.codebase || 'the current repository'}.
   Read ${prdRef} for what is being planned, then map: the existing architecture
   (one paragraph), the conventions new code must respect, the integration
   points where this work will attach, and constraints the PRD may not know
   about (framework limits, load-bearing tech debt, performance walls). Report
   the map only — do not design anything.`,
            schema: GROUND_SCHEMA,
          })
          .then((result) => result.output);
    const groundCtx = ground
      ? `Existing architecture: ${ground.summary}\nConventions to respect: ${(ground.conventions || []).join('; ')}\nIntegration points: ${(ground.integrationPoints || []).join('; ')}\nConstraints: ${(ground.constraints || []).join('; ')}`
      : 'Greenfield — no existing codebase constraints.';

    // ---------------------------------------------------------------------------
    // Phase 2: Draft — five lenses. Barrier justified: the merge and the
    // contested-decision tally need every lens.
    // ---------------------------------------------------------------------------

    port.phase('Draft');

    const LENSES = [
      {
        key: 'data-model',
        charter:
          'Entities, schemas, ownership, lifecycle, consistency requirements, indexes/queries the PRD implies, and migrations from the current state. Concrete field names and types. Ignore API shape and component structure.',
      },
      {
        key: 'api-contracts',
        charter:
          'Every interface this work exposes or consumes: routes/RPCs with request/response shapes, error contracts, auth requirements, versioning stance. Concrete, not "an endpoint for X". Ignore storage and internals.',
      },
      {
        key: 'architecture',
        charter:
          'Components and their responsibilities, how data flows between them, where state lives, what runs where (client/server/worker), and how this attaches to the integration points. Ignore field-level and route-level detail.',
      },
      {
        key: 'edge-semantics',
        charter:
          'The behavior spec for the unhappy paths: for each PRD requirement, what happens on invalid input, permission failure, concurrent edits, partial failure, empty states, limits. This is where "handle errors gracefully" becomes decidable. Ignore structure.',
      },
      {
        key: 'operations',
        charter:
          "What it takes to run it: config/secrets, feature flags and rollout, observability (logs/metrics/alerts this work must emit), performance budgets from the PRD's non-functional requirements, third-party integration setup. Ignore application logic.",
      },
    ];

    const lensDrafts = (
      await port.parallel(
        'parallel-1',
        LENSES.map(
          (l) => () =>
            ctx.claude
              .object(port.id('agent-2', `lens:${l.key}`), {
                ...args.$claude,
                prompt: `Draft your slice of a technical spec.
     Read ${prdRef}
     ${groundCtx}
     Your lens: ${l.charter}
     Write spec-grade content: an engineer implements from it without inventing
     names or shapes. Anchor every section to the PRD requirements it serves.
     Where you face a choice with genuinely competitive alternatives you cannot
     settle from PRD + codebase alone, do NOT pick silently — record it in
     contestedDecisions with the options and stakes.`,
                schema: LENS_SCHEMA,
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const sections = lensDrafts.flatMap((d) => d.sections);
    const contested = lensDrafts.flatMap((d) => d.contestedDecisions);
    port.log(`${sections.length} spec sections drafted; ${contested.length} contested decisions`);

    // ---------------------------------------------------------------------------
    // Phase 3: Decide — rank contested decisions; optionally settle the top
    // load-bearing one with a design-tournament CHILD workflow. Everything else
    // gets decided by the merger with rationale (reversible choices don't earn
    // tournaments).
    // ---------------------------------------------------------------------------

    port.phase('Decide');

    const STAKES = { 'load-bearing': 0, moderate: 1, reversible: 2 };
    contested.sort((a, b) => STAKES[a.stakes] - STAKES[b.stakes]);
    let tournament = null;
    if (
      args &&
      args.decideArchitecture &&
      contested.length > 0 &&
      contested[0].stakes === 'load-bearing'
    ) {
      const top = contested[0];
      port.log(`Running design-tournament on: ${top.decision}`);
      tournament = await runChild(ctx, port.id('child-1'), design_tournament, {
        ...{
          brief: `${top.decision}. Options on the table (you may propose others): ${top.options.join(' | ')}. Context: ${groundCtx}. This decision serves the PRD at: ${args.prd}`,
        },
        $claude: args.$claude,
      });
    }

    // ---------------------------------------------------------------------------
    // Phase 4: Merge.
    // ---------------------------------------------------------------------------

    port.phase('Merge');

    let spec = await ctx.claude
      .text(port.id('agent-3', 'merge'), {
        ...args.$claude,
        prompt: `Merge these lens drafts into one coherent technical spec.
   Read ${prdRef}
   ${groundCtx}
   Sections: ${JSON.stringify(sections, null, 2)}
   Contested decisions: ${JSON.stringify(contested, null, 2)}
   ${tournament && tournament.design ? `The top decision was settled by an independent design tournament — adopt its result as authoritative:\n${typeof tournament.design === 'string' ? tournament.design.slice(0, 4000) : JSON.stringify(tournament.winner)}` : ''}
   Resolve overlaps between lenses (one canonical name per concept). Decide the
   remaining contested items YOURSELF with one-paragraph rationale each in a
   "Decisions" section — reversible choices need a decision, not a committee.
   Structure: Overview / Decisions / Data model / API contracts / Architecture /
   Behavior & edge semantics / Operations / Out of scope / Open questions.
   Return only the spec markdown.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    // ---------------------------------------------------------------------------
    // Phase 5: Verify — two checkers in parallel, different failure modes:
    // implementability (can you build from it?) and fidelity (is it the PRD's
    // product?). One repair round.
    // ---------------------------------------------------------------------------

    port.phase('Verify');

    const [implGaps, fidelityGaps] = await port.parallel('parallel-2', [
      () =>
        ctx.claude
          .object(port.id('agent-4', 'verify:implementability'), {
            ...args.$claude,
            prompt: `Implementability audit. Read this spec as a mid-level engineer assigned to
     build it, section by section: could you implement WITHOUT asking a single
     question? Every place you would have to ask — a missing shape, an
     unnamed thing, an undefined behavior, two sections that contradict — is a
     gap with a concrete fix.
     Spec:\n---\n${spec}\n---`,
            schema: VERIFY_SCHEMA,
            // Original effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output),
      () =>
        ctx.claude
          .object(port.id('agent-5', 'verify:fidelity'), {
            ...args.$claude,
            prompt: `Fidelity audit, both directions. Read ${prdRef} and this spec.
     Direction 1: every PRD requirement (must AND should) maps to spec sections
     that actually satisfy its substance — flag missing or diluted coverage.
     Direction 2: every spec decision either traces to the PRD or is justified
     in the Decisions section — flag invented scope.
     Spec:\n---\n${spec}\n---`,
            schema: VERIFY_SCHEMA,
            // Original effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output),
    ]);

    const gaps = [...(implGaps ? implGaps.gaps : []), ...(fidelityGaps ? fidelityGaps.gaps : [])];
    if (gaps.length > 0) {
      port.log(`${gaps.length} verification gaps — one repair round`);
      const repaired = await ctx.claude
        .text(port.id('agent-6', 'repair'), {
          ...args.$claude,
          prompt: `Repair this spec. Gaps from two independent audits: ${JSON.stringify(gaps, null, 2)}
     Spec:\n---\n${spec}\n---
     Fix each gap in place; where a fix needs the product owner, add it to Open
     questions instead of guessing. Return the complete revised spec markdown.`,

          // Original phase: 'Verify' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
      if (repaired) spec = repaired;
    }

    if (args && args.out) {
      await ctx.claude
        .text(port.id('agent-7', 'write'), {
          ...args.$claude,
          prompt: `Write this spec to ${args.out} and return the path:\n${spec}`,

          // Original phase: 'Verify'; effort: 'low' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    const oq = spec && spec.match(/#+\s*Open questions[^\n]*\n([\s\S]*?)(?=\n#+\s|$)/i);
    return {
      spec,
      decisions: contested.map((c) => c.decision),
      contested: tournament
        ? { settledByTournament: contested[0].decision, winner: tournament.winner }
        : null,
      verification: `${gaps.length} gaps found across implementability + fidelity audits${gaps.length ? ', repaired in one round' : ''}`,
      openQuestions: oq
        ? oq[1]
            .split('\n')
            .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
            .filter(Boolean)
        : [],
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

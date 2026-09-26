// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'roadmap-plan',
  description:
    'Decompose a spec into capabilities, sequence them under three competing strategies, pick via panel, and stress-test the winner for hidden coupling and critical-path risk',
  whenToUse:
    'The milestone-altitude plan between spec and tickets — sequenced, gated, shippable phases with risks located',
  phases: [
    { title: 'Decompose', detail: 'spec -> capabilities + dependency graph' },
    { title: 'Sequence', detail: 'three competing milestone strategies' },
    { title: 'Choose', detail: 'panel picks; critic stress-tests' },
    { title: 'Finalize', detail: 'the committed roadmap' },
  ],
};
export const input = z.object({
  ...executionInput,
  spec: z.string().optional(),
  horizon: z.string().optional(),
  priorities: z.string().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const CAPS_SCHEMA = z
      .object({
        capabilities: z.array(
          z
            .object({
              id: z.string().describe('C1, C2, ...'),
              name: z.string(),
              size: z.enum(['S', 'M', 'L', 'XL']),
              dependsOn: z.array(z.string()).describe('capability ids that must precede this'),
              risk: z
                .enum(['high', 'medium', 'low'])
                .describe('technical/unknown risk, not business importance'),
              value: z
                .enum(['high', 'medium', 'low'])
                .describe('user/business value delivered')
                .optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const STRATEGY_SCHEMA = z
      .object({
        milestones: z.array(
          z
            .object({
              name: z.string(),
              capabilityIds: z.array(z.string()),
              goal: z.string().describe('what shippable/demoable thing this milestone achieves'),
              gate: z.string().describe('the exit criterion that says this milestone is done'),
            })
            .catchall(z.json()),
        ),
        rationale: z.string(),
      })
      .catchall(z.json());

    const PICK_SCHEMA = z
      .object({
        winner: z.enum(['de-risk-first', 'value-first', 'foundation-first']),
        scores: z
          .object({})
          .catchall(z.json())
          .describe('strategy -> 1-10 fit against the stated priorities and horizon'),
        reasoning: z.string(),
        bestOfLosers: z
          .string()
          .describe('the one idea from a losing strategy worth grafting in')
          .optional(),
      })
      .catchall(z.json());

    const STRESS_SCHEMA = z
      .object({
        sound: z.boolean(),
        problems: z.array(
          z
            .object({
              kind: z.enum([
                'hidden-dependency',
                'unbalanced-critical-path',
                'risk-piled-late',
                'milestone-not-shippable',
                'gate-unmeasurable',
              ]),
              detail: z.string(),
              fix: z.string(),
            })
            .catchall(z.json()),
        ),
        criticalPath: z.string().describe('the longest dependency chain, named').optional(),
      })
      .catchall(z.json());

    if (!args || !args.spec) {
      return {
        error: 'roadmap-plan requires args: { spec }. Optional: { horizon, priorities, out }',
      };
    }
    const specRef = args.spec.includes('\n')
      ? `this spec:\n---\n${args.spec}\n---`
      : `the spec at ${args.spec} (read it fully)`;
    const horizon = (args && args.horizon) || 'sensible milestones you choose';
    const priorities = (args && args.priorities) || null;

    // ---------------------------------------------------------------------------
    // Phase 1: Decompose into capabilities with an explicit dependency graph.
    // The graph is what makes sequencing a real analysis instead of a vibe.
    // ---------------------------------------------------------------------------

    port.phase('Decompose');

    const decomp = await ctx.claude
      .object(port.id('agent-1', 'decompose'), {
        ...args.$claude,
        prompt: `Decompose ${specRef} into capabilities — coherent, independently-plananable
   units bigger than a ticket, smaller than the whole product (an auth system,
   a billing flow, a search feature). For each: a size, its hard dependencies on
   other capabilities (the real graph — what literally cannot start until what
   finishes), its technical RISK (unknowns, not importance), and its VALUE.
   Risk and value are separate axes; the sequencing strategies will trade them
   off differently.`,
        schema: CAPS_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!decomp || decomp.capabilities.length === 0) {
      return {
        milestones: [],
        criticalPath: null,
        risks: [],
        strategy: null,
        roadmap: 'No capabilities decomposed from the spec.',
      };
    }
    port.log(
      `${decomp.capabilities.length} capabilities; ${decomp.capabilities.filter((c) => c.risk === 'high').length} high-risk`,
    );

    // ---------------------------------------------------------------------------
    // Phase 2: Sequence — three strategies, each a real philosophy about what to
    // build first. Barrier justified: the panel needs all three to compare.
    // ---------------------------------------------------------------------------

    port.phase('Sequence');

    const STRATEGIES = [
      {
        key: 'de-risk-first',
        identity:
          'Sequence to kill the biggest unknowns earliest. Front-load high-risk capabilities and spikes so the scary discoveries happen when the plan can still absorb them. You accept a less demoable early milestone to buy certainty.',
      },
      {
        key: 'value-first',
        identity:
          'Sequence to put usable value in front of users as fast as dependencies allow. Every milestone ships something someone can use; you defer risk you can defer and cut scope to keep each milestone shippable.',
      },
      {
        key: 'foundation-first',
        identity:
          'Sequence so the platform is solid before features pile on. Build shared infrastructure, data models, and cross-cutting concerns first; you accept a slower start to avoid rework and to make later milestones cheap and parallel.',
      },
    ];

    const strategies = (
      await port.parallel(
        'parallel-1',
        STRATEGIES.map(
          (s) => () =>
            ctx.claude
              .object(port.id('agent-2', `strategy:${s.key}`), {
                ...args.$claude,
                prompt: `${s.identity}
     Group these capabilities into milestones for horizon: ${horizon}.
     ${priorities ? `Business priorities to weigh: ${priorities}` : ''}
     Capabilities with dependency graph, risk, and value:
     ${JSON.stringify(decomp.capabilities, null, 2)}
     Respect the dependency graph absolutely (nothing scheduled before its
     dependencies). Every milestone states a shippable/demoable goal and a
     measurable exit gate. Stay in character — express your sequencing
     philosophy, don't hedge to a balanced plan.`,
                schema: STRATEGY_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output)
              .then((r) => ({ key: s.key, ...r })),
        ),
      )
    ).filter((r) => r && r.milestones);

    if (strategies.length === 0) {
      return {
        milestones: [],
        criticalPath: null,
        risks: [],
        strategy: null,
        roadmap: 'Strategy generation failed.',
      };
    }

    // ---------------------------------------------------------------------------
    // Phase 3: Choose + stress-test. Panel picks against the STATED priorities;
    // critic then attacks the winner for the failure modes roadmaps actually die
    // of (hidden deps, lumpy critical path, risk shoved to the end).
    // ---------------------------------------------------------------------------

    port.phase('Choose');

    const pick = await ctx.claude
      .object(port.id('agent-3', 'panel'), {
        ...args.$claude,
        prompt: `Pick the best milestone sequencing for this project.
   ${priorities ? `Stated priorities (judge against THESE, not your taste): ${priorities}` : 'No explicit priorities — judge on balanced delivery risk and value.'}
   Horizon: ${horizon}
   Strategies: ${JSON.stringify(
     strategies.map((s) => ({ strategy: s.key, milestones: s.milestones, rationale: s.rationale })),
     null,
     2,
   )}
   Score each 1-10 on fit to the priorities, pick a winner, and name the single
   best idea from a losing strategy worth grafting into the winner.`,
        schema: PICK_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    const winner = strategies.find((s) => s.key === (pick && pick.winner)) || strategies[0];

    const stress = await ctx.claude
      .object(port.id('agent-4', 'critic'), {
        ...args.$claude,
        prompt: `Stress-test this milestone plan before we commit to it.
   Plan: ${JSON.stringify(winner.milestones, null, 2)}
   Capabilities + dependency graph: ${JSON.stringify(decomp.capabilities, null, 2)}
   Hunt the ways roadmaps fail: hidden dependencies the milestones violate,
   an unbalanced critical path (one milestone secretly gating everything),
   high-risk work piled into the last milestone, milestones that aren't
   actually shippable, and exit gates you can't measure. Name the critical
   path explicitly. Each problem gets a concrete fix.`,
        schema: STRESS_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    // ---------------------------------------------------------------------------
    // Phase 4: Finalize — apply the graft and the critic's fixes into the
    // committed roadmap document.
    // ---------------------------------------------------------------------------

    port.phase('Finalize');

    const roadmap = await ctx.claude
      .text(port.id('agent-5', 'finalize'), {
        ...args.$claude,
        prompt: `Produce the committed roadmap in markdown.
   Winning strategy (${winner.key}): ${JSON.stringify(winner.milestones, null, 2)}
   Graft this idea from a runner-up: ${pick ? pick.bestOfLosers : 'none'}
   Apply these stress-test fixes: ${JSON.stringify(stress ? stress.problems : [], null, 2)}
   Critical path: ${stress ? stress.criticalPath : 'unknown'}
   Structure: a one-paragraph strategy statement, a milestone table (name, goal,
   capabilities, exit gate, key risks), the critical path called out, and a
   "risk register" of the high-risk capabilities with which milestone de-risks
   each. ${args.out ? `Write it to ${args.out} as well.` : ''} Return the markdown.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    return {
      milestones: winner.milestones.map((m) => ({
        name: m.name,
        goal: m.goal,
        gate: m.gate,
        capabilities: m.capabilityIds,
      })),
      criticalPath: stress ? stress.criticalPath : null,
      risks: decomp.capabilities.filter((c) => c.risk === 'high').map((c) => c.name),
      strategy: winner.key,
      roadmap,
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

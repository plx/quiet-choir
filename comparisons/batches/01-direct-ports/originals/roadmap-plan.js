/**
 * roadmap-plan — a spec becomes a sequenced, milestone-level roadmap
 * ==================================================================
 *
 * USE CASE
 *   The altitude between spec and tickets that prd-decompose skips. Tickets
 *   answer "what are the units of work"; a roadmap answers "in what order,
 *   grouped into what shippable milestones, gated by what, and where are the
 *   risks concentrated." This workflow decomposes the spec into capabilities,
 *   builds the real dependency graph, proposes milestones under THREE competing
 *   sequencing strategies (de-risk-first / value-first / foundation-first),
 *   has a panel pick and a critic stress-test the winner for hidden coupling
 *   and an unbalanced critical path.
 *
 * WHEN TO USE
 *   - Turning a spec into a phased plan stakeholders can commit to
 *   - Re-planning mid-project when scope or priorities shifted
 *   - Feeds prd-decompose / feature-factory per milestone (composition)
 *
 * ARGS  (required: spec)
 *   { spec: string, horizon?: string, priorities?: string, out?: string }
 *   - horizon: shape the milestones ("3 two-week sprints", "MVP then GA")
 *   - priorities: business steer ("must demo auth to investors in 3 weeks")
 *
 * PATTERNS DEMONSTRATED
 *   - Strategy tournament: three sequencing philosophies, panel pick (the
 *     design-tournament pattern applied to planning, inline)
 *   - Dependency graph built explicitly, then critiqued for hidden edges
 *   - Critical-path + risk-concentration stress test before commit
 *
 * COST PROFILE
 *   1 decompose + 3 strategists + 1 panel + 1 critic + 1 finalize ≈ 7 agents.
 *
 * OUTPUT
 *   { milestones: [...], criticalPath, risks, strategy, roadmap }
 */

export const meta = {
  name: 'roadmap-plan',
  description: 'Decompose a spec into capabilities, sequence them under three competing strategies, pick via panel, and stress-test the winner for hidden coupling and critical-path risk',
  whenToUse: 'The milestone-altitude plan between spec and tickets — sequenced, gated, shippable phases with risks located',
  phases: [
    { title: 'Decompose', detail: 'spec -> capabilities + dependency graph' },
    { title: 'Sequence', detail: 'three competing milestone strategies' },
    { title: 'Choose', detail: 'panel picks; critic stress-tests' },
    { title: 'Finalize', detail: 'the committed roadmap' },
  ],
}

const CAPS_SCHEMA = {
  type: 'object',
  required: ['capabilities'],
  properties: {
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'size', 'dependsOn', 'risk'],
        properties: {
          id: { type: 'string', description: 'C1, C2, ...' },
          name: { type: 'string' },
          size: { enum: ['S', 'M', 'L', 'XL'] },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'capability ids that must precede this' },
          risk: { enum: ['high', 'medium', 'low'], description: 'technical/unknown risk, not business importance' },
          value: { enum: ['high', 'medium', 'low'], description: 'user/business value delivered' },
        },
      },
    },
  },
}

const STRATEGY_SCHEMA = {
  type: 'object',
  required: ['milestones', 'rationale'],
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'capabilityIds', 'goal', 'gate'],
        properties: {
          name: { type: 'string' },
          capabilityIds: { type: 'array', items: { type: 'string' } },
          goal: { type: 'string', description: 'what shippable/demoable thing this milestone achieves' },
          gate: { type: 'string', description: 'the exit criterion that says this milestone is done' },
        },
      },
    },
    rationale: { type: 'string' },
  },
}

const PICK_SCHEMA = {
  type: 'object',
  required: ['winner', 'scores', 'reasoning'],
  properties: {
    winner: { enum: ['de-risk-first', 'value-first', 'foundation-first'] },
    scores: { type: 'object', description: 'strategy -> 1-10 fit against the stated priorities and horizon' },
    reasoning: { type: 'string' },
    bestOfLosers: { type: 'string', description: 'the one idea from a losing strategy worth grafting in' },
  },
}

const STRESS_SCHEMA = {
  type: 'object',
  required: ['sound', 'problems'],
  properties: {
    sound: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'detail', 'fix'],
        properties: {
          kind: { enum: ['hidden-dependency', 'unbalanced-critical-path', 'risk-piled-late', 'milestone-not-shippable', 'gate-unmeasurable'] },
          detail: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    criticalPath: { type: 'string', description: 'the longest dependency chain, named' },
  },
}

if (!args || !args.spec) {
  return { error: 'roadmap-plan requires args: { spec }. Optional: { horizon, priorities, out }' }
}
const specRef = args.spec.includes('\n') ? `this spec:\n---\n${args.spec}\n---` : `the spec at ${args.spec} (read it fully)`
const horizon = (args && args.horizon) || 'sensible milestones you choose'
const priorities = (args && args.priorities) || null

// ---------------------------------------------------------------------------
// Phase 1: Decompose into capabilities with an explicit dependency graph.
// The graph is what makes sequencing a real analysis instead of a vibe.
// ---------------------------------------------------------------------------

phase('Decompose')

const decomp = await agent(
  `Decompose ${specRef} into capabilities — coherent, independently-plananable
   units bigger than a ticket, smaller than the whole product (an auth system,
   a billing flow, a search feature). For each: a size, its hard dependencies on
   other capabilities (the real graph — what literally cannot start until what
   finishes), its technical RISK (unknowns, not importance), and its VALUE.
   Risk and value are separate axes; the sequencing strategies will trade them
   off differently.`,
  { label: 'decompose', effort: 'high', schema: CAPS_SCHEMA },
)

if (!decomp || decomp.capabilities.length === 0) {
  return { milestones: [], criticalPath: null, risks: [], strategy: null, roadmap: 'No capabilities decomposed from the spec.' }
}
log(`${decomp.capabilities.length} capabilities; ${decomp.capabilities.filter(c => c.risk === 'high').length} high-risk`)

// ---------------------------------------------------------------------------
// Phase 2: Sequence — three strategies, each a real philosophy about what to
// build first. Barrier justified: the panel needs all three to compare.
// ---------------------------------------------------------------------------

phase('Sequence')

const STRATEGIES = [
  { key: 'de-risk-first', identity: 'Sequence to kill the biggest unknowns earliest. Front-load high-risk capabilities and spikes so the scary discoveries happen when the plan can still absorb them. You accept a less demoable early milestone to buy certainty.' },
  { key: 'value-first', identity: 'Sequence to put usable value in front of users as fast as dependencies allow. Every milestone ships something someone can use; you defer risk you can defer and cut scope to keep each milestone shippable.' },
  { key: 'foundation-first', identity: 'Sequence so the platform is solid before features pile on. Build shared infrastructure, data models, and cross-cutting concerns first; you accept a slower start to avoid rework and to make later milestones cheap and parallel.' },
]

const strategies = (await parallel(STRATEGIES.map(s => () =>
  agent(
    `${s.identity}
     Group these capabilities into milestones for horizon: ${horizon}.
     ${priorities ? `Business priorities to weigh: ${priorities}` : ''}
     Capabilities with dependency graph, risk, and value:
     ${JSON.stringify(decomp.capabilities, null, 2)}
     Respect the dependency graph absolutely (nothing scheduled before its
     dependencies). Every milestone states a shippable/demoable goal and a
     measurable exit gate. Stay in character — express your sequencing
     philosophy, don't hedge to a balanced plan.`,
    { label: `strategy:${s.key}`, effort: 'high', schema: STRATEGY_SCHEMA },
  ).then(r => ({ key: s.key, ...r })),
))).filter(r => r && r.milestones)

if (strategies.length === 0) {
  return { milestones: [], criticalPath: null, risks: [], strategy: null, roadmap: 'Strategy generation failed.' }
}

// ---------------------------------------------------------------------------
// Phase 3: Choose + stress-test. Panel picks against the STATED priorities;
// critic then attacks the winner for the failure modes roadmaps actually die
// of (hidden deps, lumpy critical path, risk shoved to the end).
// ---------------------------------------------------------------------------

phase('Choose')

const pick = await agent(
  `Pick the best milestone sequencing for this project.
   ${priorities ? `Stated priorities (judge against THESE, not your taste): ${priorities}` : 'No explicit priorities — judge on balanced delivery risk and value.'}
   Horizon: ${horizon}
   Strategies: ${JSON.stringify(strategies.map(s => ({ strategy: s.key, milestones: s.milestones, rationale: s.rationale })), null, 2)}
   Score each 1-10 on fit to the priorities, pick a winner, and name the single
   best idea from a losing strategy worth grafting into the winner.`,
  { label: 'panel', effort: 'high', schema: PICK_SCHEMA },
)

const winner = strategies.find(s => s.key === (pick && pick.winner)) || strategies[0]

const stress = await agent(
  `Stress-test this milestone plan before we commit to it.
   Plan: ${JSON.stringify(winner.milestones, null, 2)}
   Capabilities + dependency graph: ${JSON.stringify(decomp.capabilities, null, 2)}
   Hunt the ways roadmaps fail: hidden dependencies the milestones violate,
   an unbalanced critical path (one milestone secretly gating everything),
   high-risk work piled into the last milestone, milestones that aren't
   actually shippable, and exit gates you can't measure. Name the critical
   path explicitly. Each problem gets a concrete fix.`,
  { label: 'critic', effort: 'high', schema: STRESS_SCHEMA },
)

// ---------------------------------------------------------------------------
// Phase 4: Finalize — apply the graft and the critic's fixes into the
// committed roadmap document.
// ---------------------------------------------------------------------------

phase('Finalize')

const roadmap = await agent(
  `Produce the committed roadmap in markdown.
   Winning strategy (${winner.key}): ${JSON.stringify(winner.milestones, null, 2)}
   Graft this idea from a runner-up: ${pick ? pick.bestOfLosers : 'none'}
   Apply these stress-test fixes: ${JSON.stringify(stress ? stress.problems : [], null, 2)}
   Critical path: ${stress ? stress.criticalPath : 'unknown'}
   Structure: a one-paragraph strategy statement, a milestone table (name, goal,
   capabilities, exit gate, key risks), the critical path called out, and a
   "risk register" of the high-risk capabilities with which milestone de-risks
   each. ${args.out ? `Write it to ${args.out} as well.` : ''} Return the markdown.`,
  { label: 'finalize', effort: 'high' },
)

return {
  milestones: winner.milestones.map(m => ({ name: m.name, goal: m.goal, gate: m.gate, capabilities: m.capabilityIds })),
  criticalPath: stress ? stress.criticalPath : null,
  risks: decomp.capabilities.filter(c => c.risk === 'high').map(c => c.name),
  strategy: winner.key,
  roadmap,
}

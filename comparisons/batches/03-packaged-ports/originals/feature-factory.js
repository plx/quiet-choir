/**
 * feature-factory — a CONDUCTOR: composes prd-decompose + deep-code-review around
 * a parallel implementation stage
 * ==============================================================================
 *
 * USE CASE
 *   The composition demo: PRD in, reviewed working code out. Encapsulated
 *   sub-workflows do what they already know how to do — `prd-decompose` turns
 *   the PRD into a ticketed backlog, `deep-code-review` adversarially reviews
 *   each module's diff — and this script supplies only what composition needs:
 *   grouping tickets into disjoint modules, implementing them in parallel,
 *   feeding each module's diff to its own review child, and repairing what
 *   the reviews confirm.
 *
 * COMPOSITION RULES DEMONSTRATED
 *   - `workflow(name, args)` runs a saved workflow inline; its structured
 *     RETURN VALUE is the composition interface (this is why every library
 *     script returns queryable objects, not prose)
 *   - Nesting is ONE LEVEL: this conductor calls leaf workflows; a leaf must
 *     never call workflow() itself. Invoke feature-factory directly — never
 *     from another script.
 *   - Children share this run's concurrency cap, agent counter, and token
 *     budget; their agents appear grouped under the child's name. Budget
 *     checks between stages matter more here than anywhere else.
 *
 * WHEN TO USE
 *   - Greenfield features specced in a PRD, sized for one repo
 *   - As the template for your own conductors (swap the children)
 *
 * ARGS  (required: prd)
 *   { prd: string, codebase?: string, maxModules?: number }
 *   - prd: path to the PRD file, or the PRD text itself
 *   - codebase: context hint passed through to prd-decompose
 *   - maxModules: implementation shards (default 4; excess lanes deferred, loudly)
 *
 * COST PROFILE
 *   HEAVY — the most expensive workflow in the library: prd-decompose (~8
 *   agents) + 1 planner + 1 implementer per module + a full deep-code-review
 *   per module (~10 agents each) + repairs + verify. Reserve a generous
 *   budget ("+500k"-style) for a real PRD.
 *
 * OUTPUT
 *   { backlog, modules: [...], verification, deferred, notes }
 */

export const meta = {
  name: 'feature-factory',
  description: 'Conductor: prd-decompose the spec, implement disjoint modules in parallel, deep-code-review each module as a sub-workflow, repair confirmed findings, verify globally',
  whenToUse: 'PRD-to-reviewed-code for a feature sized to one repo — or as the template for composing your own multi-workflow conductors',
  phases: [
    { title: 'Decompose', detail: 'prd-decompose sub-workflow -> ticketed backlog' },
    { title: 'Plan modules', detail: 'group tickets into disjoint file-area modules' },
    { title: 'Implement', detail: 'foundations first, then parallel module builders' },
    { title: 'Review', detail: 'one deep-code-review sub-workflow per module' },
    { title: 'Stabilize', detail: 'repair confirmed findings, verify globally' },
  ],
}

const MODULES_SCHEMA = {
  type: 'object',
  required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'ticketIds', 'fileAreas', 'isFoundation'],
        properties: {
          name: { type: 'string' },
          ticketIds: { type: 'array', items: { type: 'string' } },
          fileAreas: { type: 'array', items: { type: 'string' }, description: 'paths/globs this module owns — MUST be disjoint from every other module' },
          isFoundation: { type: 'boolean', description: 'true if other modules depend on this (schema, scaffolding, shared types)' },
          notes: { type: 'string' },
        },
      },
    },
    deferred: { type: 'array', items: { type: 'string' }, description: 'ticket ids that fit no module slot this run' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'summary'],
  properties: {
    passed: { type: 'boolean' },
    summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

if (!args || !args.prd) {
  return { error: 'feature-factory requires args: { prd }. Optional: { codebase, maxModules }' }
}
const maxModules = (args && args.maxModules) || 4

// ---------------------------------------------------------------------------
// Phase 1: Decompose — the first child workflow. Its structured return
// (tickets with acceptance criteria, lanes, dependencies) IS our input; we
// never re-read the PRD here. Guard the result like any agent(): a child can
// fail, and a conductor that assumes success fabricates one.
// ---------------------------------------------------------------------------

phase('Decompose')

const backlog = await workflow('prd-decompose', { prd: args.prd, codebase: args.codebase })

if (!backlog || !backlog.tickets || backlog.tickets.length === 0) {
  return { backlog: null, modules: [], verification: null, deferred: [], notes: 'prd-decompose returned no tickets — nothing to build.' }
}
log(`Backlog: ${backlog.tickets.length} tickets. ${backlog.coverage || ''}`)

// ---------------------------------------------------------------------------
// Phase 2: Plan modules — the glue only the conductor can supply. Disjoint
// fileAreas are what make Phase 3's parallel builders safe in one shared
// tree (same rule as api-migration: disjointness by construction beats
// worktree machinery, and reviews need the diffs in the main tree anyway).
// ---------------------------------------------------------------------------

phase('Plan modules')

const plan = await agent(
  `Group this backlog into at most ${maxModules} implementation modules for
   parallel builders working in ONE shared checkout.
   Tickets: ${JSON.stringify(backlog.tickets, null, 2)}
   Sequencing notes: ${backlog.sequencing || 'none'}
   Rules: every module owns explicit fileAreas and NO two modules may overlap —
   shared scaffolding (schemas, types, config, migrations) goes into a single
   foundation module others build on. Respect ticket dependsOn edges: a ticket
   may not land in a module that builds before its dependency's module. Tickets
   that fit no slot go in deferred (do not silently drop any id).`,
  { label: 'plan', effort: 'high', schema: MODULES_SCHEMA },
)

if (!plan || plan.modules.length === 0) {
  return { backlog, modules: [], verification: null, deferred: [], notes: 'Module planning failed — backlog produced but nothing implemented.' }
}
const foundations = plan.modules.filter(m => m.isFoundation)
const features = plan.modules.filter(m => !m.isFoundation)
log(`${plan.modules.length} modules (${foundations.length} foundation), ${(plan.deferred || []).length} tickets deferred`)

// ---------------------------------------------------------------------------
// Phase 3: Implement — foundations sequentially (everything depends on them),
// then feature modules in parallel (disjoint by construction). Builders run
// only narrow checks; the global gate is Phase 5's job.
// ---------------------------------------------------------------------------

phase('Implement')

const ticketById = new Map(backlog.tickets.map(t => [t.id, t]))
const buildModule = (m) => agent(
  `Implement the "${m.name}" module. You own ONLY these file areas: ${m.fileAreas.join(', ')}
   — do not touch files outside them (another builder owns those).
   Tickets, in order: ${JSON.stringify(m.ticketIds.map(id => ticketById.get(id)).filter(Boolean), null, 2)}
   ${m.notes || ''}
   Satisfy each ticket's acceptance criteria. Match the codebase's existing
   conventions. Run only narrow checks (compile the touched files, run directly
   related tests) — a global verifier runs later. Report honestly: "partial"
   with blockers beats a hollow "done".`,
  { label: `build:${m.name}`, phase: 'Implement', schema: IMPL_SCHEMA },
).then(r => ({ module: m, impl: r }))

const built = []
for (const f of foundations) {
  built.push(await buildModule(f)) // sequential: parallel features build on this
}
if (budget.total && budget.remaining() < 80_000) {
  log('Budget low after foundations — deferring feature modules and reviews')
} else {
  built.push(...(await parallel(features.map(m => () => buildModule(m)))).filter(Boolean))
}

const implemented = built.filter(b => b.impl && b.impl.status !== 'blocked')
const blocked = built.filter(b => !b.impl || b.impl.status === 'blocked')
log(`${implemented.length}/${plan.modules.length} modules implemented${blocked.length ? `; blocked: ${blocked.map(b => b.module.name).join(', ')}` : ''}`)

// ---------------------------------------------------------------------------
// Phase 4: Review — one deep-code-review CHILD per implemented module, run
// concurrently (children share the run's concurrency cap; the harness
// interleaves their agents). Each child gets a target scoped to the module's
// file areas, and returns adversarially-verified findings — the conductor
// trusts the child's verification and never re-litigates it.
// ---------------------------------------------------------------------------

phase('Review')

const reviews = (await parallel(implemented.map(b => () =>
  workflow('deep-code-review', {
    target: `the uncommitted working-tree changes under these paths only: ${b.module.fileAreas.join(', ')}`,
  }).then(r => ({ module: b.module, review: r })),
))).filter(Boolean)

const withFindings = reviews.filter(r => r.review && r.review.confirmed && r.review.confirmed.length > 0)
log(`Reviews: ${reviews.length} modules reviewed, ${withFindings.length} with confirmed findings`)

// ---------------------------------------------------------------------------
// Phase 5: Stabilize — module-scoped repairs for confirmed findings (already
// adversarially verified by the child — repair, don't re-judge), then one
// global verify with an honest exit.
// ---------------------------------------------------------------------------

phase('Stabilize')

await parallel(withFindings.map(r => () =>
  agent(
    `Fix these confirmed code-review findings in the "${r.module.name}" module
     (file areas: ${r.module.fileAreas.join(', ')} — stay inside them).
     Findings (already adversarially verified — do not re-litigate, fix):
     ${JSON.stringify(r.review.confirmed, null, 2)}
     Run only the narrow checks for what you change.`,
    { label: `repair:${r.module.name}`, phase: 'Stabilize' },
  ),
))

const verification = await agent(
  `Global verification: run this repository's build/typecheck and full test
   suite (find the commands). The changes implement: ${JSON.stringify(plan.modules.map(m => m.name))}.
   Report pass/fail with failures clustered by root cause. Do not fix anything.`,
  { label: 'verify', phase: 'Stabilize', schema: VERIFY_SCHEMA },
)

return {
  backlog: { tickets: backlog.tickets.length, coverage: backlog.coverage, openQuestions: backlog.openQuestions },
  modules: built.map(b => ({
    name: b.module.name,
    status: b.impl ? b.impl.status : 'error',
    summary: b.impl ? b.impl.summary : null,
    reviewFindings: (reviews.find(r => r.module.name === b.module.name) || {}).review?.confirmed?.length ?? null,
  })),
  verification: verification ? verification.summary : 'verifier unavailable',
  deferred: plan.deferred || [],
  notes: [
    blocked.length ? `Blocked modules need attention: ${blocked.map(b => b.module.name).join(', ')}.` : null,
    verification && !verification.passed ? 'Global verification failed — see verification; a follow-up stabilize run or human review is needed.' : null,
  ].filter(Boolean).join(' ') || 'All modules implemented, reviewed, and verified.',
}

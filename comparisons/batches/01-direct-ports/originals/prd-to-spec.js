/**
 * prd-to-spec — the load-bearing middle step: PRD becomes an implementable technical spec
 * =======================================================================================
 *
 * USE CASE
 *   Teams that go straight from PRD to tickets discover the architecture in
 *   the tickets — the most expensive place to discover it. This workflow
 *   grounds itself in the existing codebase, drafts the spec through five
 *   technical lenses in parallel, optionally settles the single most
 *   contested architectural decision by composing the design-tournament
 *   workflow, then verifies the merged spec two ways: an implementability
 *   skeptic ("could a mid-level engineer build each section without asking a
 *   question?") and a fidelity checker walking PRD↔spec in both directions.
 *
 * COMPOSITION NOTE
 *   With args.decideArchitecture=true this becomes a CONDUCTOR (it calls
 *   workflow('design-tournament')) — invoke it directly, never from another
 *   script. Default false keeps it a composable leaf.
 *
 * ARGS  (required: prd)
 *   { prd: string, codebase?: string, decideArchitecture?: boolean, out?: string }
 *   - prd: path to the PRD, or the PRD text
 *   - codebase: where the code lives (default: current repo; "greenfield" to skip grounding)
 *   - decideArchitecture: run a design-tournament child on the most contested
 *     decision (adds ~8 agents)
 *
 * COST PROFILE
 *   1 grounding + 5 lenses + 1 merger + 2 verifiers + 1 repair ≈ 10 agents
 *   (+~8 with the tournament).
 *
 * OUTPUT
 *   { spec, decisions, contested, verification, openQuestions }
 */

export const meta = {
  name: 'prd-to-spec',
  description: 'Ground in the codebase, draft a technical spec through five lenses, optionally settle the top architecture decision via design-tournament, and verify implementability + PRD fidelity',
  whenToUse: 'The step between PRD and tickets: producing a spec an engineer can build from without re-deriving the architecture inside the tickets',
  phases: [
    { title: 'Ground', detail: 'existing architecture, conventions, integration surface' },
    { title: 'Draft', detail: 'five technical lenses in parallel' },
    { title: 'Decide', detail: 'contested decisions; optional tournament child' },
    { title: 'Merge', detail: 'one spec from lenses + decisions' },
    { title: 'Verify', detail: 'implementability skeptic ∥ PRD-fidelity checker' },
  ],
}

const GROUND_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: 'the existing architecture in one paragraph' },
    conventions: { type: 'array', items: { type: 'string' }, description: 'patterns the spec must respect (error handling, naming, layering...)' },
    integrationPoints: { type: 'array', items: { type: 'string' }, description: 'where new work will attach to existing code' },
    constraints: { type: 'array', items: { type: 'string' }, description: 'realities the PRD may not know about (framework limits, tech debt walls)' },
  },
}

const LENS_SCHEMA = {
  type: 'object',
  required: ['sections', 'contestedDecisions'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['heading', 'content', 'prdAnchors'],
        properties: {
          heading: { type: 'string' },
          content: { type: 'string', description: 'spec-grade markdown: concrete names, types, contracts' },
          prdAnchors: { type: 'array', items: { type: 'string' }, description: 'PRD requirements this section serves' },
        },
      },
    },
    contestedDecisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['decision', 'options', 'stakes'],
        properties: {
          decision: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          stakes: { enum: ['load-bearing', 'moderate', 'reversible'] },
        },
      },
      description: 'choices with real alternatives this lens could not settle alone',
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'gaps'],
  properties: {
    passed: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'problem', 'fix'],
        properties: {
          where: { type: 'string', description: 'spec section or PRD requirement' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

if (!args || !args.prd) {
  return { error: 'prd-to-spec requires args: { prd }. Optional: { codebase, decideArchitecture, out }' }
}
const prdRef = args.prd.includes('\n') ? `this PRD:\n---\n${args.prd}\n---` : `the PRD at ${args.prd} (read it fully)`
const greenfield = args.codebase === 'greenfield'

// ---------------------------------------------------------------------------
// Phase 1: Ground — the spec must fit the code that exists, not the code we
// wish existed. Skipped for greenfield.
// ---------------------------------------------------------------------------

phase('Ground')

const ground = greenfield ? null : await agent(
  `Ground an upcoming technical spec in reality. Codebase: ${args.codebase || 'the current repository'}.
   Read ${prdRef} for what is being planned, then map: the existing architecture
   (one paragraph), the conventions new code must respect, the integration
   points where this work will attach, and constraints the PRD may not know
   about (framework limits, load-bearing tech debt, performance walls). Report
   the map only — do not design anything.`,
  { label: 'ground', schema: GROUND_SCHEMA },
)
const groundCtx = ground
  ? `Existing architecture: ${ground.summary}\nConventions to respect: ${(ground.conventions || []).join('; ')}\nIntegration points: ${(ground.integrationPoints || []).join('; ')}\nConstraints: ${(ground.constraints || []).join('; ')}`
  : 'Greenfield — no existing codebase constraints.'

// ---------------------------------------------------------------------------
// Phase 2: Draft — five lenses. Barrier justified: the merge and the
// contested-decision tally need every lens.
// ---------------------------------------------------------------------------

phase('Draft')

const LENSES = [
  { key: 'data-model', charter: 'Entities, schemas, ownership, lifecycle, consistency requirements, indexes/queries the PRD implies, and migrations from the current state. Concrete field names and types. Ignore API shape and component structure.' },
  { key: 'api-contracts', charter: 'Every interface this work exposes or consumes: routes/RPCs with request/response shapes, error contracts, auth requirements, versioning stance. Concrete, not "an endpoint for X". Ignore storage and internals.' },
  { key: 'architecture', charter: 'Components and their responsibilities, how data flows between them, where state lives, what runs where (client/server/worker), and how this attaches to the integration points. Ignore field-level and route-level detail.' },
  { key: 'edge-semantics', charter: 'The behavior spec for the unhappy paths: for each PRD requirement, what happens on invalid input, permission failure, concurrent edits, partial failure, empty states, limits. This is where "handle errors gracefully" becomes decidable. Ignore structure.' },
  { key: 'operations', charter: 'What it takes to run it: config/secrets, feature flags and rollout, observability (logs/metrics/alerts this work must emit), performance budgets from the PRD\'s non-functional requirements, third-party integration setup. Ignore application logic.' },
]

const lensDrafts = (await parallel(LENSES.map(l => () =>
  agent(
    `Draft your slice of a technical spec.
     Read ${prdRef}
     ${groundCtx}
     Your lens: ${l.charter}
     Write spec-grade content: an engineer implements from it without inventing
     names or shapes. Anchor every section to the PRD requirements it serves.
     Where you face a choice with genuinely competitive alternatives you cannot
     settle from PRD + codebase alone, do NOT pick silently — record it in
     contestedDecisions with the options and stakes.`,
    { label: `lens:${l.key}`, schema: LENS_SCHEMA },
  ),
))).filter(Boolean)

const sections = lensDrafts.flatMap(d => d.sections)
const contested = lensDrafts.flatMap(d => d.contestedDecisions)
log(`${sections.length} spec sections drafted; ${contested.length} contested decisions`)

// ---------------------------------------------------------------------------
// Phase 3: Decide — rank contested decisions; optionally settle the top
// load-bearing one with a design-tournament CHILD workflow. Everything else
// gets decided by the merger with rationale (reversible choices don't earn
// tournaments).
// ---------------------------------------------------------------------------

phase('Decide')

const STAKES = { 'load-bearing': 0, moderate: 1, reversible: 2 }
contested.sort((a, b) => STAKES[a.stakes] - STAKES[b.stakes])
let tournament = null
if (args && args.decideArchitecture && contested.length > 0 && contested[0].stakes === 'load-bearing') {
  const top = contested[0]
  log(`Running design-tournament on: ${top.decision}`)
  tournament = await workflow('design-tournament', {
    brief: `${top.decision}. Options on the table (you may propose others): ${top.options.join(' | ')}. Context: ${groundCtx}. This decision serves the PRD at: ${args.prd}`,
  })
}

// ---------------------------------------------------------------------------
// Phase 4: Merge.
// ---------------------------------------------------------------------------

phase('Merge')

let spec = await agent(
  `Merge these lens drafts into one coherent technical spec.
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
  { label: 'merge', effort: 'high' },
)

// ---------------------------------------------------------------------------
// Phase 5: Verify — two checkers in parallel, different failure modes:
// implementability (can you build from it?) and fidelity (is it the PRD's
// product?). One repair round.
// ---------------------------------------------------------------------------

phase('Verify')

const [implGaps, fidelityGaps] = await parallel([
  () => agent(
    `Implementability audit. Read this spec as a mid-level engineer assigned to
     build it, section by section: could you implement WITHOUT asking a single
     question? Every place you would have to ask — a missing shape, an
     unnamed thing, an undefined behavior, two sections that contradict — is a
     gap with a concrete fix.
     Spec:\n---\n${spec}\n---`,
    { label: 'verify:implementability', effort: 'high', schema: VERIFY_SCHEMA },
  ),
  () => agent(
    `Fidelity audit, both directions. Read ${prdRef} and this spec.
     Direction 1: every PRD requirement (must AND should) maps to spec sections
     that actually satisfy its substance — flag missing or diluted coverage.
     Direction 2: every spec decision either traces to the PRD or is justified
     in the Decisions section — flag invented scope.
     Spec:\n---\n${spec}\n---`,
    { label: 'verify:fidelity', effort: 'high', schema: VERIFY_SCHEMA },
  ),
])

const gaps = [...(implGaps ? implGaps.gaps : []), ...(fidelityGaps ? fidelityGaps.gaps : [])]
if (gaps.length > 0) {
  log(`${gaps.length} verification gaps — one repair round`)
  const repaired = await agent(
    `Repair this spec. Gaps from two independent audits: ${JSON.stringify(gaps, null, 2)}
     Spec:\n---\n${spec}\n---
     Fix each gap in place; where a fix needs the product owner, add it to Open
     questions instead of guessing. Return the complete revised spec markdown.`,
    { label: 'repair', phase: 'Verify' },
  )
  if (repaired) spec = repaired
}

if (args && args.out) {
  await agent(`Write this spec to ${args.out} and return the path:\n${spec}`, { label: 'write', phase: 'Verify', effort: 'low' })
}

const oq = spec && spec.match(/#+\s*Open questions[^\n]*\n([\s\S]*?)(?=\n#+\s|$)/i)
return {
  spec,
  decisions: contested.map(c => c.decision),
  contested: tournament ? { settledByTournament: contested[0].decision, winner: tournament.winner } : null,
  verification: `${gaps.length} gaps found across implementability + fidelity audits${gaps.length ? ', repaired in one round' : ''}`,
  openQuestions: oq ? oq[1].split('\n').map(l => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean) : [],
}

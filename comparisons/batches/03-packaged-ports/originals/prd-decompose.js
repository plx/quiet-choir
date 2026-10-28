/**
 * prd-decompose — a PRD becomes an implementation-ready backlog, five lenses at a time
 * ====================================================================================
 *
 * USE CASE
 *   Turning a PRD into tickets is where scope quietly leaks: the happy path
 *   gets ticketed, the error states don't; the feature gets sized, the
 *   migration doesn't; analytics is remembered in sprint 3. This workflow
 *   reads the PRD through five specialized lenses simultaneously (stories,
 *   edge/error states, non-functional, dependencies/sequencing, instrumenta-
 *   tion), merges the overlapping output into deduplicated tickets with
 *   acceptance criteria, then runs a completeness critic BACKWARDS — from
 *   the PRD to the backlog — to catch what every lens missed.
 *
 * WHEN TO USE
 *   - Sprint planning off a fresh PRD or feature spec
 *   - Auditing an existing backlog against the PRD it claims to implement
 *   - De-risking an estimate: the ticket count IS the scope conversation
 *
 * ARGS  (required: prd)
 *   { prd: string, codebase?: string, out?: string }
 *   - prd: path to the PRD file, or the PRD text itself
 *   - codebase: repo context so tickets reference real modules (optional)
 *   - out: write the backlog markdown here (optional)
 *
 * PATTERNS DEMONSTRATED
 *   - Lens decomposition for DOCUMENTS (the review-dimensions pattern,
 *     applied to product artifacts instead of diffs)
 *   - Merge-by-agent, not merge-by-code: ticket dedup requires judgment
 *     (two lenses describing one ticket differently), unlike findings dedup
 *     which is mechanical — the comment at the merge explains the rule
 *   - Reverse-direction completeness critic: walks the SOURCE (PRD) checking
 *     coverage in the OUTPUT (backlog) — the direction that finds omissions
 *   - Single repair round with the critic's gaps as work items
 *
 * COST PROFILE
 *   5 lens readers + 1 merger + 1 critic + 1 repair ≈ 8 agents.
 *
 * OUTPUT
 *   { tickets: [...], sequencing, coverage, openQuestions }
 */

export const meta = {
  name: 'prd-decompose',
  description: 'Read a PRD through five parallel lenses, merge into deduplicated tickets with acceptance criteria, and verify coverage with a reverse-direction critic',
  whenToUse: 'Sprint planning from a PRD or spec — producing a backlog whose error states, migrations, and instrumentation are ticketed, not just the happy path',
  phases: [
    { title: 'Decompose', detail: 'five lenses read the PRD in parallel' },
    { title: 'Merge', detail: 'judgment-dedupe into tickets with ACs' },
    { title: 'Verify coverage', detail: 'PRD-to-backlog critic + repair round' },
  ],
}

const ITEMS_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description', 'prdAnchor'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          prdAnchor: { type: 'string', description: 'the PRD sentence/section this item comes from — every item must trace to the PRD' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          estimate: { enum: ['XS', 'S', 'M', 'L', 'XL'] },
        },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'ambiguities in the PRD this lens could not resolve' },
  },
}

const BACKLOG_SCHEMA = {
  type: 'object',
  required: ['tickets', 'sequencing'],
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'acceptanceCriteria', 'estimate', 'lane'],
        properties: {
          id: { type: 'string', description: 'T1, T2, ...' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          estimate: { enum: ['XS', 'S', 'M', 'L', 'XL'] },
          lane: { enum: ['feature', 'edge-cases', 'non-functional', 'infra-migration', 'instrumentation'] },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of blocking tickets' },
          prdAnchors: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    sequencing: { type: 'string', description: 'suggested milestone grouping and the critical path, one paragraph' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const COVERAGE_SCHEMA = {
  type: 'object',
  required: ['covered', 'gaps'],
  properties: {
    covered: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prdRequirement', 'problem'],
        properties: {
          prdRequirement: { type: 'string', description: 'the PRD text with no adequate ticket' },
          problem: { enum: ['missing', 'under-specified', 'wrong'] },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

if (!args || !args.prd) {
  return { error: 'prd-decompose requires args: { prd } — a file path or the PRD text itself.' }
}

const prdRef = args.prd.includes('\n') ? `this PRD text:\n---\n${args.prd}\n---` : `the PRD at ${args.prd} (read it fully)`
const codebase = (args && args.codebase) || null

// --------------------------------------------------------------------------
// Phase 1: Five lenses, one PRD. Same diversity logic as code-review
// dimensions: each lens has a charter AND an anti-charter, so five readers
// produce five different item sets instead of five copies of the happy path.
// Barrier justified: the merger needs every lens's items to dedupe.
// --------------------------------------------------------------------------

phase('Decompose')

const LENSES = [
  { key: 'stories', charter: 'User-facing capability, sliced into shippable stories. Each story = a user can now do X. Ignore infrastructure, error handling, and metrics — other lenses own those.' },
  { key: 'edges', charter: 'Everything that goes wrong: invalid input, permission denied, empty states, conflicts, offline/timeout, partial failure, concurrent edits, abuse. One item per distinct failure the product must handle GRACEFULLY (define what graceful means each time).' },
  { key: 'non-functional', charter: 'Performance targets, scale assumptions, security/privacy requirements, accessibility, i18n, compliance. Only what the PRD states or clearly implies — flag vague ones ("fast") as open questions rather than inventing numbers.' },
  { key: 'foundations', charter: 'What must exist before stories can build: schema changes, migrations, new services/queues, feature flags, third-party integrations, backfill jobs. Include teardown/rollback items where a migration implies one.' },
  { key: 'instrumentation', charter: 'How we know it works: analytics events with their triggers, success-metric dashboards from the PRD\'s goals section, alerts, A/B scaffolding if the PRD implies an experiment. If the PRD names a success metric, there must be an item that makes it measurable.' },
]

const lensReads = await parallel(LENSES.map(l => () =>
  agent(
    `Read ${prdRef}.
     ${codebase ? `Codebase context (reference real modules in items): ${codebase}` : ''}
     Your lens: ${l.charter}
     Extract work items visible through YOUR lens only. Every item must carry a
     prdAnchor — the PRD text it traces to; if you cannot anchor it, it goes in
     openQuestions instead. Write acceptance criteria as testable statements.
     Estimate: XS(hours) S(a day) M(2-3 days) L(a week) XL(should be split).`,
    { label: `lens:${l.key}`, schema: ITEMS_SCHEMA },
  ).then(r => ({ lens: l.key, ...r })),
))

const allItems = lensReads.filter(Boolean).flatMap(r => (r.items || []).map(i => ({ ...i, lens: r.lens })))
const allQuestions = [...new Set(lensReads.filter(Boolean).flatMap(r => r.openQuestions || []))]
log(`${allItems.length} raw items from ${lensReads.filter(Boolean).length} lenses, ${allQuestions.length} open questions`)

if (allItems.length === 0) {
  return { tickets: [], sequencing: null, coverage: 'No items extracted — is the PRD readable?', openQuestions: allQuestions }
}

// --------------------------------------------------------------------------
// Phase 2: Merge — BY AGENT, unlike code-review's mechanical (file,line)
// dedupe. Two lenses describing the same ticket use different words ("handle
// upload failure" vs "show retry UI on failed upload"), so ticket identity is
// a judgment call. Rule of thumb: dedupe by code when items share a natural
// key; dedupe by agent when identity itself requires reading.
// --------------------------------------------------------------------------

phase('Merge')

const backlog = await agent(
  `Merge these work items from five specialized readings of one PRD into a
   deduplicated backlog. Items describing the same work in different words
   become ONE ticket (union the acceptance criteria, keep all prdAnchors).
   Assign ids (T1...), lanes, and dependsOn edges (foundations before the
   stories needing them; instrumentation can trail its feature). Split any XL.
   Then write the sequencing paragraph: milestone grouping + the critical path.
   Items: ${JSON.stringify(allItems, null, 2)}
   Carry forward these open questions, deduplicated: ${JSON.stringify(allQuestions)}`,
  { label: 'merge', effort: 'high', schema: BACKLOG_SCHEMA },
)

if (!backlog) {
  return { tickets: [], sequencing: null, coverage: 'Merge failed', openQuestions: allQuestions }
}
log(`Merged into ${backlog.tickets.length} tickets`)

// --------------------------------------------------------------------------
// Phase 3: Reverse-direction critic. The lenses walked PRD -> items; the
// critic walks the PRD sentence by sentence asking "which ticket covers
// THIS?" Omissions hide in the forward direction and are exposed in reverse.
// One repair round, then ship the backlog with an honest coverage note.
// --------------------------------------------------------------------------

phase('Verify coverage')

const coverage = await agent(
  `Audit backlog coverage BACKWARDS. Read ${prdRef} section by section; for each
   requirement, commitment, or implied behavior, find the ticket(s) covering it
   in this backlog: ${JSON.stringify(backlog.tickets.map(t => ({ id: t.id, title: t.title, acceptanceCriteria: t.acceptanceCriteria, prdAnchors: t.prdAnchors })), null, 2)}
   Report gaps: PRD text with NO adequate ticket (missing), a ticket that exists
   but whose ACs don't actually cover the requirement (under-specified), or a
   ticket that contradicts the PRD (wrong). Judge coverage of the requirement's
   SUBSTANCE, not keyword overlap.`,
  { label: 'coverage-critic', effort: 'high', schema: COVERAGE_SCHEMA },
)

let finalBacklog = backlog
if (coverage && !coverage.covered && coverage.gaps.length > 0) {
  log(`Critic found ${coverage.gaps.length} coverage gaps — one repair round`)
  const repaired = await agent(
    `Repair this backlog. For each gap: add a ticket (next free Tn id) or amend
     the under-specified/wrong ticket's ACs. Keep everything else unchanged.
     Backlog: ${JSON.stringify(backlog, null, 2)}
     Gaps: ${JSON.stringify(coverage.gaps, null, 2)}
     Return the complete updated backlog.`,
    { label: 'repair', phase: 'Verify coverage', schema: BACKLOG_SCHEMA },
  )
  if (repaired) finalBacklog = repaired
}

if (args && args.out) {
  await agent(
    `Write this backlog as a clean markdown document to ${args.out}: a summary
     table (id, title, lane, estimate, dependsOn), then each ticket with
     description and acceptance criteria, then sequencing, then open questions.
     Backlog: ${JSON.stringify(finalBacklog, null, 2)}
     Write the file and return its path.`,
    { label: 'write-doc', phase: 'Verify coverage', effort: 'low' },
  )
}

return {
  tickets: finalBacklog.tickets,
  sequencing: finalBacklog.sequencing,
  coverage: coverage
    ? (coverage.covered ? 'Critic confirmed full PRD coverage.' : `${coverage.gaps.length} gaps found and repaired in one round — re-audit if the PRD is contractual.`)
    : 'Coverage critic unavailable.',
  openQuestions: finalBacklog.openQuestions || allQuestions,
}

/**
 * acceptance-qa-batch — check finished tickets, then attack their features
 * ==========================================================================
 *
 * USE CASE
 *   Unit-test green is not "the ticket is done". This workflow closes the loop
 *   the SDLC usually leaves open: it takes tickets WITH acceptance criteria
 *   (prd-decompose's output shape), and for each one an evidence agent
 *   DEMONSTRATES every criterion against the real code — running the app,
 *   the tests, the commands, capturing concrete evidence — then a breaker
 *   agent attacks the same feature's edges trying to defeat it. A ticket
 *   passes only when every AC is demonstrated AND the breaker comes back
 *   empty-handed. Demonstration and destruction are different skills; each
 *   ticket gets both.
 *
 * WHEN TO USE
 *   - After feature-factory or any implementation burst, before merge/release
 *   - Auditing "done" columns whose doneness nobody actually verified
 *
 * RELATION TO acceptance-qa-deep
 *   This is the BATCH/portfolio gate: many tickets at once, each proven with
 *   evidence and then attacked at the FEATURE level by a breaker. Use it to
 *   sweep a whole "done" column. Its sibling `acceptance-qa-deep` is the DEEP
 *   single-ticket gate: it decomposes one ticket's criteria into sub-checks,
 *   surfaces the implied/forgotten criteria, and runs a letter-vs-spirit
 *   skeptic per criterion. Rule of thumb: acceptance-qa-batch to triage the backlog,
 *   acceptance-qa-deep to interrogate the one ticket that must be airtight. (bug-hunt
 *   vs deep-code-review is the same breadth-vs-depth split.)
 *
 * ARGS  (required: tickets)
 *   { tickets: string, scope?: string, maxTickets?: number }
 *   - tickets: path to a backlog file (markdown/JSON with acceptance criteria)
 *     or the ticket content itself
 *   - scope: where the implementation lives (default: current repo)
 *   - maxTickets: cap (default 8; excess deferred loudly)
 *
 * COST PROFILE
 *   1 ingest + 2 agents per ticket (demonstrate, break) ≈ 2N+1; default cap
 *   ≈ 17 agents.
 *
 * OUTPUT
 *   { tickets: [{id, verdict, criteria, breaks}], passed, failed, deferred }
 */

export const meta = {
  name: 'acceptance-qa-batch',
  description: 'Per ticket: demonstrate every acceptance criterion against the real code with captured evidence, then attack the feature adversarially; pass = demonstrated AND unbroken',
  whenToUse: 'Acceptance QA on finished work — verifying tickets meet their own criteria before merge or release, beyond unit-test green',
  phases: [
    { title: 'Ingest', detail: 'parse tickets and acceptance criteria' },
    { title: 'Demonstrate', detail: 'evidence agent per ticket, AC by AC' },
    { title: 'Break', detail: 'adversary attacks passing tickets' },
  ],
}

const TICKETS_SCHEMA = {
  type: 'object',
  required: ['tickets'],
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    runContext: { type: 'string', description: 'how to run/exercise this project: commands, entry points, test invocations' },
  },
}

const DEMO_SCHEMA = {
  type: 'object',
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'status', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          status: { enum: ['demonstrated', 'failed', 'undemonstrable'] },
          evidence: { type: 'string', description: 'the command/test/output that proves it — concrete, reproducible' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const BREAK_SCHEMA = {
  type: 'object',
  required: ['breaks'],
  properties: {
    breaks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'reproduction', 'severity'],
        properties: {
          description: { type: 'string' },
          reproduction: { type: 'string', description: 'exact steps/inputs that trigger it' },
          severity: { enum: ['breaks-criterion', 'degrades', 'cosmetic'] },
        },
      },
    },
  },
}

if (!args || !args.tickets) {
  return { error: 'acceptance-qa-batch requires args: { tickets } — a backlog file path or ticket content with acceptance criteria. Optional: { scope, maxTickets }' }
}
const ticketsRef = args.tickets.includes('\n') ? `these tickets:\n---\n${args.tickets}\n---` : `the tickets at ${args.tickets} (read fully)`
const scope = (args && args.scope) || 'the current repository'
const maxTickets = (args && args.maxTickets) || 8

// ---------------------------------------------------------------------------
// Phase 1: Ingest — structure the tickets and, critically, work out HOW this
// project is exercised (the runContext every downstream agent needs).
// ---------------------------------------------------------------------------

phase('Ingest')

const ingested = await agent(
  `Parse ${ticketsRef} into structured tickets with their acceptance criteria.
   Skip tickets with no checkable criteria (note them). Then inspect ${scope}
   and report runContext: exactly how an agent can exercise this project —
   install/build commands, how to start it, how to run its tests, entry points.`,
  { label: 'ingest', effort: 'low', schema: TICKETS_SCHEMA },
)

if (!ingested || ingested.tickets.length === 0) {
  return { tickets: [], passed: 0, failed: 0, deferred: 0 }
}
const chosen = ingested.tickets.slice(0, maxTickets)
const deferred = ingested.tickets.length - chosen.length
if (deferred > 0) log(`Cap: verifying ${chosen.length} tickets, deferring ${deferred}`)

// ---------------------------------------------------------------------------
// Phases 2-3 as a pipeline: demonstrate -> break per ticket, independently.
// Demonstration and destruction are different skills, so they are different
// agents. The break stage runs only on tickets whose criteria all demonstrated
// — there is nothing to defend on a ticket that already failed its own ACs.
// New per-ticket, no cross-ticket dependency => pipeline, no barrier.
// ---------------------------------------------------------------------------

const results = await pipeline(
  chosen,

  // Stage 1: demonstrate every AC with reproducible evidence.
  (t) => agent(
    `Demonstrate that ticket ${t.id} ("${t.title}") meets its acceptance criteria,
     against the real implementation in ${scope}.
     Criteria: ${JSON.stringify(t.acceptanceCriteria)}
     How to exercise this project: ${ingested.runContext || 'discover it'}
     For each criterion, produce reproducible EVIDENCE it holds — the command run
     and its output, the test that exercises it, the request/response. Ground
     every verdict in what you actually ran or read, never in the ticket's own
     description. status: demonstrated / failed / undemonstrable (needs an
     environment you lack — say so, don't fake it).`,
    { label: `demo:${t.id}`, phase: 'Demonstrate', effort: 'high', schema: DEMO_SCHEMA },
  ).then(demo => ({ ticket: t, demo })),

  // Stage 2: adversary attacks the feature — but only if it earned defending.
  (r) => {
    if (!r || !r.demo) return r
    const allShown = r.demo.criteria.length > 0 && r.demo.criteria.every(c => c.status === 'demonstrated')
    if (!allShown) return { ...r, breakResult: { breaks: [] } } // already failing; no point attacking
    return agent(
      `Ticket ${r.ticket.id} ("${r.ticket.title}") passed its acceptance criteria.
       Now try to BREAK the feature. Exercise its edges in ${scope}: malformed and
       boundary inputs, permission and auth gaps, concurrency, empty/huge data,
       the interactions its criteria never mention. How to run it: ${ingested.runContext || 'discover it'}.
       Report only breaks you can REPRODUCE, each with exact steps. severity
       breaks-criterion means it defeats an acceptance criterion in a case the
       criterion should have covered. Coming back empty-handed is a real result.`,
      { label: `break:${r.ticket.id}`, phase: 'Break', effort: 'high', schema: BREAK_SCHEMA },
    ).then(breakResult => ({ ...r, breakResult }))
  },
)

// ---------------------------------------------------------------------------
// Verdicts, computed in code: a ticket passes only when every criterion is
// demonstrated AND the breaker found nothing that defeats a criterion.
// ---------------------------------------------------------------------------

phase('Break')

const graded = results.filter(Boolean).map(r => {
  const criteria = r.demo ? r.demo.criteria : []
  const breaks = (r.breakResult && r.breakResult.breaks) || []
  const allShown = criteria.length > 0 && criteria.every(c => c.status === 'demonstrated')
  const criterionBreak = breaks.some(b => b.severity === 'breaks-criterion')
  const undemonstrable = criteria.some(c => c.status === 'undemonstrable')
  const verdict = allShown && !criterionBreak ? (undemonstrable ? 'pass-pending-manual' : 'pass') : 'fail'
  return { id: r.ticket.id, title: r.ticket.title, verdict, criteria, breaks }
})

const passed = graded.filter(g => g.verdict === 'pass' || g.verdict === 'pass-pending-manual').length
const failed = graded.filter(g => g.verdict === 'fail').length
log(`QA: ${passed}/${graded.length} tickets pass${deferred ? `, ${deferred} deferred` : ''}`)

return { tickets: graded, passed, failed, deferred }

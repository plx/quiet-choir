/**
 * acceptance-qa-deep — does the finished work satisfy its ticket's acceptance criteria?
 * ======================================================================================
 *
 * USE CASE
 *   The gap between "tests pass" and "the ticket is done". Unit tests check the
 *   code the developer chose to test; acceptance QA checks each acceptance
 *   criterion of the ticket against the delivered behavior — including the
 *   criteria the developer forgot. Every criterion is decomposed into concrete
 *   checks, each check is VERIFIED against the running/reading of the actual
 *   code (not the developer's PR description), and criteria that pass get an
 *   adversarial second look for "passes narrowly / cheats the spirit".
 *
 * WHEN TO USE
 *   - Gating a ticket/PR as truly done against its ACs
 *   - QA on a feature-factory or feature-implement module before merge
 *   - Composed by higher-level workflows as the "is it done?" verdict
 *
 * RELATION TO acceptance-qa-batch
 *   This is the DEEP single-ticket gate: it decomposes ONE ticket's criteria
 *   into binary sub-checks, surfaces the implied/forgotten criteria, verifies
 *   each against the real code, and runs a letter-vs-spirit skeptic on every
 *   pass. Its sibling `acceptance-qa-batch` is the BATCH/portfolio gate: it sweeps
 *   many tickets at once, demonstrating each with evidence and then attacking
 *   the feature. Rule of thumb: acceptance-qa-batch to triage a whole "done" column,
 *   acceptance-qa-deep to interrogate the one ticket that must be airtight.
 *
 * ARGS  (required: criteria)
 *   { criteria: string, target?: string, ticket?: string }
 *   - criteria: the acceptance criteria (text, or path to the ticket)
 *   - target: what to check them against (paths/diff; default: uncommitted changes)
 *   - ticket: optional fuller ticket context (goal, non-goals)
 *
 * PATTERNS DEMONSTRATED
 *   - Criterion decomposition: each AC becomes binary-checkable sub-checks
 *   - Evidence-grounded verdicts: checks run/read code, never trust the PR text
 *   - Adversarial pass on GREENS: spirit-vs-letter skeptic on what "passed"
 *   - Pipeline per criterion (no barrier); honest partial verdicts
 *
 * COST PROFILE
 *   1 decompose + 1 checker per criterion + 1 spirit-skeptic per passing
 *   criterion + 1 verdict ≈ 8-14 agents.
 *
 * OUTPUT
 *   { verdict, criteria: [...], mustFix, summary }
 */

export const meta = {
  name: 'acceptance-qa-deep',
  description: 'Decompose a ticket\'s acceptance criteria into concrete checks, verify each against the actual delivered code, and adversarially re-check the passes for letter-vs-spirit',
  whenToUse: 'Gating whether finished work truly satisfies its ticket — the check "tests pass" does not make, including the criteria the developer forgot',
  phases: [
    { title: 'Decompose', detail: 'each AC -> binary-checkable sub-checks' },
    { title: 'Check', detail: 'verify each criterion against real code' },
    { title: 'Adversarial', detail: 'spirit-vs-letter re-check on passes' },
    { title: 'Verdict', detail: 'done / not-done with must-fixes' },
  ],
}

const DECOMP_SCHEMA = {
  type: 'object',
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'checks'],
        properties: {
          criterion: { type: 'string', description: 'one acceptance criterion, verbatim or normalized' },
          checks: { type: 'array', items: { type: 'string' }, description: 'binary, verifiable sub-checks that together prove the criterion' },
          kind: { enum: ['behavior', 'ui', 'api', 'data', 'performance', 'error-handling'] },
        },
      },
    },
    impliedCriteria: { type: 'array', items: { type: 'string' }, description: 'criteria the ticket clearly intends but did not spell out (empty states, error paths, permissions)' },
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  required: ['criterion', 'status', 'evidence'],
  properties: {
    criterion: { type: 'string' },
    status: { enum: ['pass', 'fail', 'partial', 'cannot-verify'] },
    evidence: { type: 'string', description: 'what in the ACTUAL code/behavior proves this — file:line, command output, not the PR description' },
    failingChecks: { type: 'array', items: { type: 'string' } },
  },
}

const SPIRIT_SCHEMA = {
  type: 'object',
  required: ['honest', 'reasoning'],
  properties: {
    honest: { type: 'boolean', description: 'true if the pass satisfies the criterion\'s INTENT, not just its letter' },
    reasoning: { type: 'string' },
    gotcha: { type: 'string', description: 'the narrow/cheating way it passes, if honest=false' },
  },
}

if (!args || !args.criteria) {
  return { error: 'acceptance-qa-deep requires args: { criteria } — the acceptance criteria text or ticket path. Optional: { target, ticket }' }
}
const criteriaRef = args.criteria.includes('\n') ? `these acceptance criteria:\n---\n${args.criteria}\n---` : `the acceptance criteria in ${args.criteria}`
const target = (args && args.target) || 'the uncommitted working-tree changes; if clean, the latest commit'

// ---------------------------------------------------------------------------
// Phase 1: Decompose — vague ACs into binary checks, AND surface the implied
// criteria the ticket meant but didn't write (the forgotten error path).
// ---------------------------------------------------------------------------

phase('Decompose')

const decomp = await agent(
  `Decompose ${criteriaRef} into verifiable checks.
   ${args.ticket ? `Fuller ticket context: ${args.ticket}` : ''}
   For each acceptance criterion, break it into binary sub-checks a QA engineer
   could each mark pass/fail by inspecting or running the code. Then add
   impliedCriteria: things this ticket clearly INTENDS but didn't spell out —
   the empty state, the permission check, the error path — because "done" means
   the intent, not just the bullet points.`,
  { label: 'decompose', effort: 'high', schema: DECOMP_SCHEMA },
)

if (!decomp || decomp.criteria.length === 0) {
  return { verdict: 'no-criteria', criteria: [], mustFix: [], summary: 'No acceptance criteria could be decomposed.' }
}
// Implied criteria join the checklist (flagged), so the forgotten ones count.
const allCriteria = [
  ...decomp.criteria,
  ...(decomp.impliedCriteria || []).map(c => ({ criterion: `(implied) ${c}`, checks: [c], kind: 'behavior' })),
]
log(`${decomp.criteria.length} stated + ${(decomp.impliedCriteria || []).length} implied criteria to verify`)

// ---------------------------------------------------------------------------
// Phases 2-3 as a pipeline: check -> adversarial-on-pass, per criterion.
// The adversarial stage runs ONLY on passes (fails are already actionable);
// it catches the "technically satisfies the words, misses the point" pass.
// ---------------------------------------------------------------------------

const results = await pipeline(
  allCriteria,

  (c) => agent(
    `Verify this acceptance criterion against the ACTUAL delivered work (${target}).
     Criterion: ${c.criterion}
     Sub-checks: ${JSON.stringify(c.checks)}
     Read the real code and run it where cheap. Ground your verdict in evidence
     from the code/behavior — file:line, command output — NOT in any PR
     description or commit message (those describe intent, not delivery). Status:
     pass (all sub-checks hold), fail, partial (some hold), or cannot-verify
     (needs a running environment you lack — say so, don't guess).`,
    { label: `check:${c.criterion.slice(0, 30)}`, phase: 'Check', effort: 'high', schema: CHECK_SCHEMA },
  ).then(v => ({ criterion: c, verdict: v })),

  (r) => {
    if (!r || !r.verdict || r.verdict.status !== 'pass') return r
    return agent(
      `A criterion was marked PASS. Check whether it passes in SPIRIT or only in
       letter. Criterion: ${r.criterion.criterion}
       Claimed-passing evidence: ${r.verdict.evidence}
       Look for the narrow pass: hardcoded to satisfy the check, works only for
       the happy example, satisfies the words while missing the intent, passes
       because a guard is disabled. honest=true only if a user relying on this
       criterion would actually be served.`,
      { label: `spirit:${r.criterion.criterion.slice(0, 25)}`, phase: 'Adversarial', effort: 'high', schema: SPIRIT_SCHEMA },
    ).then(s => ({ ...r, spirit: s }))
  },
)

// ---------------------------------------------------------------------------
// Phase 4: Verdict — computed in code from the checks, then narrated. A pass
// downgraded by the spirit skeptic counts as a fail for the gate.
// ---------------------------------------------------------------------------

phase('Verdict')

const graded = results.filter(Boolean).map(r => {
  let status = r.verdict ? r.verdict.status : 'cannot-verify'
  if (status === 'pass' && r.spirit && !r.spirit.honest) status = 'fail-spirit'
  return { criterion: r.criterion.criterion, status, evidence: r.verdict ? r.verdict.evidence : null, gotcha: r.spirit && !r.spirit.honest ? r.spirit.gotcha : null }
})

const failed = graded.filter(g => g.status === 'fail' || g.status === 'fail-spirit' || g.status === 'partial')
const unverifiable = graded.filter(g => g.status === 'cannot-verify')
const verdict = failed.length === 0 && unverifiable.length === 0 ? 'done'
  : failed.length === 0 ? 'done-pending-manual' // only cannot-verify items remain
  : 'not-done'

log(`Verdict: ${verdict} — ${graded.filter(g => g.status === 'pass').length}/${graded.length} clean pass, ${failed.length} failing, ${unverifiable.length} unverifiable`)

const summary = await agent(
  `Write a one-paragraph QA verdict for stakeholders.
   Overall: ${verdict}. Criteria results: ${JSON.stringify(graded, null, 2)}
   Lead with the verdict and why. If not-done, the must-fixes are the failing
   criteria — be specific and actionable. If done-pending-manual, name exactly
   what needs a human/environment to confirm. Return only the paragraph.`,
  { label: 'summary', effort: 'low' },
)

return {
  verdict,
  criteria: graded,
  mustFix: failed.map(f => ({ criterion: f.criterion, why: f.gotcha || 'failing checks — see evidence', evidence: f.evidence })),
  summary: summary || `${verdict}: ${failed.length} criteria failing.`,
}

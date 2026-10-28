/**
 * release-gate — an evidence-based go/no-go decision before you ship
 * ==================================================================
 *
 * USE CASE
 *   The decision release-notes doesn't make: SHOULD this ship? Release
 *   readiness fails in independent dimensions — tests red, coverage dropped on
 *   the diff, undocumented breaking changes, unaddressed security findings,
 *   missing migrations/rollback, silent perf regressions — and a human eyeballs
 *   a few and misses the rest. This workflow checks each readiness dimension in
 *   parallel with EVIDENCE (it runs things), a gatekeeper renders go / no-go /
 *   conditional-go from the collected evidence under an explicit rubric, and
 *   any blocker is adversarially confirmed so the gate doesn't cry wolf.
 *
 * WHEN TO USE
 *   - The final gate before cutting a release or promoting to prod
 *   - CI gate on a release branch
 *   - Composed after acceptance-qa-batch in a release conductor
 *
 * ARGS
 *   { range?: string, policy?: string, blockOn?: string[] }
 *   - range: what's shipping (git range; default: since last tag)
 *   - policy: house rules ("no High severity sec findings; coverage may not drop")
 *   - blockOn: dimensions that are hard blockers (default: tests, security)
 *
 * PATTERNS DEMONSTRATED
 *   - Evidence-gathering dimensions (each RUNS its check, not reads about it)
 *   - Decision from evidence under an explicit rubric (not vibes)
 *   - Adversarial confirmation of blockers (no false no-go)
 *   - Structural verdict computed in code from confirmed blockers
 *
 * COST PROFILE
 *   6 dimension checkers + 1 confirmer per blocker + 1 gatekeeper ≈ 8-12 agents.
 *
 * OUTPUT
 *   { decision, blockers, warnings, dimensions, rationale }
 */

export const meta = {
  name: 'release-gate',
  description: 'Check every release-readiness dimension with evidence (running the checks), render an evidence-based go/no-go/conditional decision, and adversarially confirm blockers',
  whenToUse: 'The go/no-go gate before shipping — tests, coverage-on-diff, breaking changes, security, migrations/rollback, and perf, decided from evidence not vibes',
  phases: [
    { title: 'Assess', detail: 'six readiness dimensions, with evidence' },
    { title: 'Confirm', detail: 'adversarially confirm each blocker' },
    { title: 'Decide', detail: 'go / no-go / conditional under the rubric' },
  ],
}

const DIMENSION_SCHEMA = {
  type: 'object',
  required: ['dimension', 'status', 'evidence'],
  properties: {
    dimension: { type: 'string' },
    status: { enum: ['pass', 'concern', 'blocker', 'not-applicable', 'cannot-check'] },
    evidence: { type: 'string', description: 'what was RUN/read and what it showed — command output, diff facts' },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const CONFIRM_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'reasoning'],
  properties: {
    confirmed: { type: 'boolean', description: 'true if this really should block the release' },
    reasoning: { type: 'string' },
    downgradeTo: { enum: ['concern', 'not-a-problem'], description: 'if not confirmed, what it really is' },
  },
}

const DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'rationale'],
  properties: {
    decision: { enum: ['go', 'no-go', 'conditional-go'] },
    conditions: { type: 'array', items: { type: 'string' }, description: 'for conditional-go: what must be true before shipping' },
    rationale: { type: 'string' },
  },
}

const range = (args && args.range) || 'changes since the most recent release tag'
const policy = (args && args.policy) || 'Default: tests must pass; no unaddressed high-severity security findings; breaking changes must be documented; migrations must have a rollback.'
const blockOn = (args && args.blockOn) || ['tests', 'security']

// ---------------------------------------------------------------------------
// Phase 1: Assess — six dimensions, each producing EVIDENCE by actually
// running/reading, not by asserting. Barrier justified: the gatekeeper decides
// from the full evidence set, and blocker confirmation needs it gathered.
// ---------------------------------------------------------------------------

phase('Assess')

const DIMENSIONS = [
  { key: 'tests', prompt: `Run the full test suite for ${range} (find the command). Report pass/fail counts and any failing test names. status "blocker" if anything fails, "pass" if green, "cannot-check" if the suite won't run (say why).` },
  { key: 'coverage-on-diff', prompt: `Assess test coverage of the CHANGED lines in ${range} specifically (not whole-repo coverage). Did the diff add untested logic, especially on error paths? status "concern" for notable gaps, "blocker" only if critical paths shipped untested.` },
  { key: 'breaking-changes', prompt: `Scan the diff of ${range} for breaking changes: removed/renamed public API, changed defaults, altered response shapes, migration-requiring schema changes. Cross-check each against the changelog/release notes. status "blocker" for UNDOCUMENTED breaking changes, "pass" if none or all documented.` },
  { key: 'security', prompt: `Check ${range} for security regressions: new unsanitized inputs at trust boundaries, new secrets in code, new vulnerable dependencies, weakened authz. status "blocker" for a real reachable issue, "concern" for hardening gaps. Evidence must name the code.` },
  { key: 'migrations-rollback', prompt: `If ${range} includes data or schema migrations: is each reversible or paired with a rollback plan? Are they ordered safely (expand-contract)? status "blocker" for an irreversible destructive migration with no rollback, "not-applicable" if there are no migrations.` },
  { key: 'performance', prompt: `Scan ${range} for likely performance regressions: new N+1 queries, unbounded loops on request paths, removed caching, sync work added to hot paths. status "concern" for plausible regressions (we rarely have prod numbers here), "blocker" only for an obvious catastrophe.` },
]

const assessments = (await parallel(DIMENSIONS.map(d => () =>
  agent(
    `Release-readiness check. Dimension: ${d.key}.
     ${d.prompt}
     House policy: ${policy}
     Ground your status in EVIDENCE — run the checks, read the diff, quote
     output. "cannot-check" (honestly) beats a guessed pass.`,
    { label: `assess:${d.key}`, effort: 'high', schema: DIMENSION_SCHEMA },
  ),
))).filter(Boolean)

const blockers = assessments.filter(a => a.status === 'blocker')
const concerns = assessments.filter(a => a.status === 'concern')
log(`Assessed ${assessments.length} dimensions: ${blockers.length} raw blockers, ${concerns.length} concerns`)

// ---------------------------------------------------------------------------
// Phase 2: Confirm — every blocker faces a skeptic, so the gate doesn't block
// a release on a false alarm. A downgraded blocker becomes a concern.
// ---------------------------------------------------------------------------

phase('Confirm')

const confirmed = (await parallel(blockers.map(b => () =>
  agent(
    `A release-gate dimension flagged a BLOCKER. Confirm whether it truly should
     stop the release. Dimension: ${b.dimension}. Evidence: ${b.evidence}
     Findings: ${JSON.stringify(b.findings)}
     Policy: ${policy}
     Verify against the actual code/output: is it real, reachable, and in scope
     for THIS release? A flaky test, a pre-existing issue not introduced here, or
     a documented-and-accepted risk is not a blocker. confirmed=true only if
     shipping with this is genuinely wrong.`,
    { label: `confirm:${b.dimension}`, effort: 'high', schema: CONFIRM_SCHEMA },
  ).then(c => ({ dimension: b, confirm: c })),
))).filter(Boolean)

const realBlockers = confirmed.filter(c => c.confirm && c.confirm.confirmed).map(c => c.dimension)
const downgraded = confirmed.filter(c => c.confirm && !c.confirm.confirmed)
log(`${realBlockers.length}/${blockers.length} blockers confirmed, ${downgraded.length} downgraded`)

// ---------------------------------------------------------------------------
// Phase 3: Decide — structural pre-verdict in code (confirmed blocker on a
// blockOn dimension => no-go), then the gatekeeper writes the rationale and
// any conditions. Code owns the gate logic; the agent owns the explanation.
// ---------------------------------------------------------------------------

phase('Decide')

const hardBlock = realBlockers.some(b => blockOn.includes(b.dimension) || blockOn.some(k => b.dimension.includes(k)))
const allConcerns = [...concerns, ...downgraded.map(d => d.dimension)]

const decision = await agent(
  `Render the release go/no-go decision and rationale.
   Confirmed blockers: ${JSON.stringify(realBlockers.map(b => ({ dimension: b.dimension, evidence: b.evidence })), null, 2)}
   Concerns (non-blocking but real): ${JSON.stringify(allConcerns.map(c => ({ dimension: c.dimension, findings: c.findings })), null, 2)}
   Hard-block dimensions (policy): ${blockOn.join(', ')}
   Structural pre-verdict from code: ${hardBlock ? 'NO-GO (a confirmed blocker hits a hard-block dimension)' : realBlockers.length ? 'confirmed blockers exist but none on hard-block dimensions — conditional-go likely' : 'no confirmed blockers — go or conditional-go on concerns'}
   Honor the pre-verdict for the decision; use conditional-go when shipping is
   OK provided named conditions are met first. Write a rationale a release
   manager can forward. Return decision + conditions + rationale.`,
  { label: 'gatekeeper', effort: 'high', schema: DECISION_SCHEMA },
)

const finalDecision = decision ? decision.decision : (hardBlock ? 'no-go' : realBlockers.length ? 'conditional-go' : 'go')

return {
  decision: finalDecision,
  blockers: realBlockers.map(b => ({ dimension: b.dimension, evidence: b.evidence })),
  warnings: allConcerns.map(c => ({ dimension: c.dimension, findings: c.findings })),
  dimensions: assessments.map(a => ({ dimension: a.dimension, status: a.status })),
  rationale: decision ? decision.rationale : `${finalDecision}: ${realBlockers.length} confirmed blockers.`,
  ...(decision && decision.conditions && decision.conditions.length ? { conditions: decision.conditions } : {}),
}

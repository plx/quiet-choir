/**
 * refactor-campaign — behavior-preserving refactoring under a characterization safety net
 * =======================================================================================
 *
 * USE CASE
 *   Refactoring's cardinal rule is "don't change behavior" — and the only
 *   honest way to keep that promise on code you don't fully trust is to pin
 *   the current behavior FIRST. This workflow finds refactoring targets by
 *   measurable pressure (complexity, duplication, coupling), pins each
 *   target's observable behavior with characterization tests that must pass
 *   against the CURRENT code, refactors only behind that net, and verifies
 *   the net is still green after. A target with no safety net is refactored
 *   in report-only mode or skipped — never blind.
 *
 * WHEN TO USE
 *   - Paying down a specific, measured chunk of technical debt
 *   - Making a module safe to change before building on it
 *   - Post-incident cleanup of code the incident implicated
 *
 * ARGS
 *   { scope?: string, goal?: string, maxTargets?: number, apply?: boolean }
 *   - goal: what "better" means here ("reduce coupling", "kill duplication")
 *   - apply: perform refactors behind green nets (default false = plan + nets only)
 *
 * PATTERNS DEMONSTRATED
 *   - Characterization-net-first: pin behavior BEFORE touching code
 *   - Safety gate per target: no green net -> no refactor (or report-only)
 *   - Pipeline per target (net -> refactor -> re-verify), independent targets
 *   - Behavior-preservation is the invariant, stated everywhere
 *
 * COST PROFILE
 *   1 survey + 1 ranker + 3 agents per target (net, refactor, verify).
 *   maxTargets=4 ≈ 14 agents.
 *
 * OUTPUT
 *   { refactored: [...], netOnly: [...], skipped: [...], summary }
 */

export const meta = {
  name: 'refactor-campaign',
  description: 'Find refactoring targets by measurable pressure, pin each target\'s behavior with characterization tests, refactor only behind a green net, and verify preservation',
  whenToUse: 'Behavior-preserving technical-debt paydown — where the safety net is the point, not an afterthought',
  phases: [
    { title: 'Survey', detail: 'find targets by complexity/duplication/coupling' },
    { title: 'Rank', detail: 'prioritize by payoff vs. risk' },
    { title: 'Refactor', detail: 'net -> refactor -> verify, per target' },
  ],
}

const TARGETS_SCHEMA = {
  type: 'object',
  required: ['targets'],
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['location', 'pressure', 'evidence'],
        properties: {
          location: { type: 'string', description: 'file or file:function' },
          pressure: { enum: ['complexity', 'duplication', 'coupling', 'long-method', 'primitive-obsession', 'god-object'] },
          evidence: { type: 'string', description: 'the measurable signal — cyclomatic count, N duplicate sites, fan-in/out' },
          testability: { enum: ['well-tested', 'thinly-tested', 'untested'], description: 'current test coverage of this code' },
        },
      },
    },
    testCommand: { type: 'string' },
  },
}

const RANK_SCHEMA = {
  type: 'object',
  required: ['ranked'],
  properties: {
    ranked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['location', 'refactoring', 'payoff', 'risk'],
        properties: {
          location: { type: 'string' },
          refactoring: { type: 'string', description: 'the specific named refactoring (extract method, replace conditional with polymorphism...)' },
          payoff: { enum: ['high', 'medium', 'low'] },
          risk: { enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const NET_SCHEMA = {
  type: 'object',
  required: ['status', 'netFile', 'behaviorsPinned'],
  properties: {
    status: { enum: ['green', 'cannot-pin'] },
    netFile: { type: 'string' },
    behaviorsPinned: { type: 'array', items: { type: 'string' }, description: 'observable behaviors now locked by characterization tests' },
    notes: { type: 'string' },
  },
}

const REFACTOR_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['refactored', 'net-held-reverted', 'skipped'] },
    summary: { type: 'string' },
    netStillGreen: { type: 'boolean' },
  },
}

const scope = (args && args.scope) || 'the repository'
const goal = (args && args.goal) || 'reduce complexity and duplication without changing behavior'
const maxTargets = (args && args.maxTargets) || 4
const apply = Boolean(args && args.apply)

// ---------------------------------------------------------------------------
// Phase 1: Survey — targets chosen by MEASURABLE pressure, not taste. Also
// records current testability, which gates the strategy per target later.
// ---------------------------------------------------------------------------

phase('Survey')

const survey = await agent(
  `Find refactoring targets in ${scope}. Goal: ${goal}.
   Choose targets by MEASURABLE pressure — cyclomatic complexity, duplication
   (N near-identical sites), coupling (fan-in/out), method length, primitive
   obsession, god objects — not by aesthetic preference. For each, record the
   evidence (the actual number/count) and how well-tested it currently is.
   Also report the repo's test command. Report up to 12 targets.`,
  { label: 'survey', schema: TARGETS_SCHEMA },
)

if (!survey || survey.targets.length === 0) {
  return { refactored: [], netOnly: [], skipped: [], summary: 'No measurable refactoring targets found.' }
}
const testCommand = survey.testCommand || 'the repo test command'
log(`${survey.targets.length} targets by pressure (${survey.targets.filter(t => t.testability === 'untested').length} untested)`)

// ---------------------------------------------------------------------------
// Phase 2: Rank by payoff vs. risk; pick top N.
// ---------------------------------------------------------------------------

phase('Rank')

const ranking = await agent(
  `Rank these refactoring targets by payoff-vs-risk and name the SPECIFIC
   refactoring for each (a named technique, not "clean up"). Untested code is
   higher risk — weight accordingly. Pick the top ${maxTargets}.
   Targets: ${JSON.stringify(survey.targets, null, 2)}`,
  { label: 'rank', effort: 'high', schema: RANK_SCHEMA },
)

if (!ranking || ranking.ranked.length === 0) {
  return { refactored: [], netOnly: [], skipped: [], summary: 'Ranking failed.' }
}
const chosen = ranking.ranked.slice(0, maxTargets)
const byLoc = new Map(survey.targets.map(t => [t.location, t]))
log(`Refactoring top ${chosen.length} targets${apply ? '' : ' (net + plan only — apply:false)'}`)

// ---------------------------------------------------------------------------
// Phase 3: Per-target pipeline — net FIRST, then refactor only if the net is
// green, then verify the net still holds. The safety gate is the whole point:
// a target we cannot pin does not get refactored blind.
// ---------------------------------------------------------------------------

const results = await pipeline(
  chosen,

  // Stage 1: characterization net against the CURRENT code.
  (t) => agent(
    `Pin the CURRENT observable behavior of ${t.location} with characterization
     tests — tests that capture what the code does NOW (bugs included; we are
     preserving behavior, not fixing it). These must PASS against the current,
     un-refactored code. Cover the real input/output pairs, edge cases, and side
     effects you can observe. Test command: ${testCommand}. Run them green before
     returning. If the behavior genuinely cannot be pinned (e.g. it needs live
     external systems), status "cannot-pin" — do not fake a net.`,
    { label: `net:${t.location.split('/').pop()}`, phase: 'Refactor', effort: 'high', schema: NET_SCHEMA },
  ).then(net => ({ target: t, ranked: chosen.find(c => c.location === t.location), net })),

  // Stage 2: refactor behind the net — gated. No green net => no refactor.
  (r) => {
    if (!r) return r
    const info = byLoc.get(r.target.location) || {}
    if (!r.net || r.net.status !== 'green') {
      return { ...r, refactor: { status: 'skipped', summary: `No safety net (${r.net ? r.net.notes : 'net failed'}) — not refactored blind.`, netStillGreen: false } }
    }
    if (!apply) {
      return { ...r, refactor: { status: 'net-held-reverted', summary: `Net green (${r.net.behaviorsPinned.length} behaviors pinned). Planned: ${r.ranked ? r.ranked.refactoring : 'refactoring'}. apply:false — not performed.`, netStillGreen: true } }
    }
    return agent(
      `Apply this refactoring to ${r.target.location}: ${r.ranked ? r.ranked.refactoring : 'the planned refactoring'}.
       Goal: ${goal}. A characterization net pins current behavior — file ${r.net.netFile},
       pinning: ${JSON.stringify(r.net.behaviorsPinned)}.
       Refactor WITHOUT changing behavior; the net must stay green. Run the net
       (${testCommand}) after refactoring. If it goes red, your change altered
       behavior — REVERT the refactor (keep the net) and report status
       "net-held-reverted". Preserving behavior beats completing the refactor.`,
      { label: `refactor:${r.target.location.split('/').pop()}`, phase: 'Refactor', effort: 'high', schema: REFACTOR_SCHEMA },
    ).then(ref => ({ ...r, refactor: ref }))
  },

  // Stage 3: independent verification that the net still holds.
  (r) => {
    if (!r || !r.refactor || r.refactor.status !== 'refactored') return r
    return agent(
      `Independently confirm the refactoring of ${r.target.location} preserved
       behavior: run the characterization net ${r.net.netFile} (${testCommand})
       and confirm green, then read the diff and confirm the changes are
       structural, not behavioral. If either fails, report netStillGreen=false.`,
      { label: `verify:${r.target.location.split('/').pop()}`, phase: 'Refactor', effort: 'high', schema: REFACTOR_SCHEMA },
    ).then(v => ({ ...r, refactor: { ...r.refactor, netStillGreen: v ? v.netStillGreen : false, verified: true } }))
  },
)

const done = results.filter(Boolean)
const refactored = done.filter(r => r.refactor && r.refactor.status === 'refactored' && r.refactor.netStillGreen)
const netOnly = done.filter(r => r.refactor && r.refactor.status === 'net-held-reverted')
const skipped = done.filter(r => !r.refactor || r.refactor.status === 'skipped' || (r.refactor.status === 'refactored' && !r.refactor.netStillGreen))

return {
  refactored: refactored.map(r => ({ location: r.target.location, refactoring: r.ranked ? r.ranked.refactoring : null, behaviorsPinned: r.net.behaviorsPinned.length })),
  netOnly: netOnly.map(r => ({ location: r.target.location, planned: r.ranked ? r.ranked.refactoring : null, behaviorsPinned: r.net.behaviorsPinned.length })),
  skipped: skipped.map(r => ({ location: r.target.location, why: r.refactor ? r.refactor.summary : 'pipeline error' })),
  summary: apply
    ? `${refactored.length} refactored behind green nets, ${skipped.length} skipped (no net or behavior changed). Characterization tests were added and left in place.`
    : `${netOnly.length} targets pinned with characterization nets and planned; re-run with apply:true to refactor behind them. ${skipped.length} could not be pinned.`,
}

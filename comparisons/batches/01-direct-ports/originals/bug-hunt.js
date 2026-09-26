/**
 * bug-hunt — exhaustive bug discovery that loops until the well runs dry
 * ======================================================================
 *
 * USE CASE
 *   "Find the bugs in this codebase" has no natural stopping point: a fixed
 *   fan-out of N finders misses the tail, and a single agent saturates long
 *   before the codebase does. This workflow keeps launching finder rounds —
 *   rotating through diverse lenses so each round looks somewhere new — and
 *   stops only when two consecutive rounds surface nothing unseen. Every
 *   fresh candidate faces a majority-vote panel of skeptics before it counts.
 *
 * WHEN TO USE
 *   - Auditing an unfamiliar or inherited codebase before building on it
 *   - Periodic deep sweeps of a mature codebase ("what are we sitting on?")
 *   - Pre-release hardening when you want the tail, not just the top 10
 *
 * ARGS
 *   { scope?: string, maxRounds?: number, votes?: number }
 *   - scope: what to hunt in ("src/", "the payment module", default: whole repo)
 *   - maxRounds: hard cap on finder rounds (default 4)
 *   - votes: skeptics per candidate, majority rules (default 3; use 1 for a
 *     cheap pass)
 *
 * PATTERNS DEMONSTRATED
 *   - Loop-until-dry: rounds continue until 2 consecutive rounds find nothing
 *     new — fixed counters miss the tail, this doesn't
 *   - Lens rotation: each round draws different lenses from a pool, indexed by
 *     round number (deterministic — workflow scripts have no Math.random)
 *   - Dedup vs `seen`, not vs `confirmed`: refuted findings must not reappear
 *     in later rounds or the loop never converges
 *   - Majority-vote adversarial verify: 2-of-3 skeptics must fail to refute
 *   - Budget-aware looping: respects a "+300k"-style session token target
 *
 * COST PROFILE
 *   Per round: 3 finders + (votes × fresh candidates) verifiers. A 3-round
 *   hunt on a mid-size repo typically runs 20-40 agents. Scale down with
 *   votes: 1, or up with a bigger token budget.
 *
 * OUTPUT
 *   { confirmed: [...], refuted: n, rounds: n, dry: boolean }
 */

export const meta = {
  name: 'bug-hunt',
  description: 'Loop diverse bug-finder rounds until two consecutive rounds find nothing new; majority-vote verify every candidate',
  whenToUse: 'Exhaustive bug discovery on a codebase or subsystem — when you want the tail of the distribution, not just the obvious top findings',
  phases: [
    { title: 'Hunt', detail: 'rotating-lens finder rounds' },
    { title: 'Verify', detail: 'majority-vote skeptic panel per candidate' },
  ],
}

const BUGS_SCHEMA = {
  type: 'object',
  required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'evidence', 'failureScenario'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs/state -> wrong output or crash' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
}

// A pool of lenses much larger than any single round uses. Each round takes a
// rotating slice, so round 2 hunts differently than round 1 even over the same
// files. Diversity is what makes later rounds productive — three identical
// finders converge on the same obvious bugs.
const LENS_POOL = [
  'error handling: swallowed exceptions, catch blocks that hide failures, missing error propagation, errors logged but not handled',
  'boundary conditions: off-by-one, empty collections, zero/negative numbers, unicode and encoding edges, max-size inputs',
  'concurrency: race conditions, shared mutable state, missing locks or atomicity, async ordering assumptions, TOCTOU',
  'resource lifecycle: leaks of handles/connections/subscriptions, missing cleanup on error paths, double-free/double-close',
  'state machines: invalid state transitions, initialization order, stale caches, partial updates that leave inconsistent state',
  'contract violations: callers that break callee assumptions, nullability mismatches, silently-widened types, ignored return values',
  'time and ordering: timezone bugs, DST edges, clock skew assumptions, sort stability, iteration-order dependence',
  'input validation: unvalidated external input reaching logic, type confusion at parse boundaries, injection into shells/queries/paths',
]

const scope = (args && args.scope) || 'the entire repository'
const maxRounds = (args && args.maxRounds) || 4
const votes = (args && args.votes) || 3
const majority = Math.floor(votes / 2) + 1
const LENSES_PER_ROUND = 3

const seen = new Set()          // every candidate ever surfaced (confirmed OR refuted)
const confirmed = []
let refutedCount = 0
let dryRounds = 0
let round = 0

// Key on file + normalized title so re-worded duplicates of the same bug from a
// later round still collide.
const keyOf = (b) => `${b.file}::${b.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`

while (dryRounds < 2 && round < maxRounds) {
  // Budget guard must check budget.total — with no target set, remaining() is
  // Infinity and this loop would run to maxRounds regardless of spend.
  if (budget.total && budget.remaining() < 60_000) {
    log(`Stopping early: token budget nearly exhausted (${Math.round(budget.remaining() / 1000)}k left)`)
    break
  }

  // Deterministic lens rotation: round 0 takes lenses 0-2, round 1 takes 3-5...
  const lenses = Array.from({ length: LENSES_PER_ROUND },
    (_, i) => LENS_POOL[(round * LENSES_PER_ROUND + i) % LENS_POOL.length])

  // Barrier is deliberate here: the dry-round decision needs the WHOLE round's
  // yield, and dedup-vs-seen must happen before any verifier spends tokens.
  const found = (await parallel(lenses.map((lens, i) =>
    () => agent(
      `Hunt for real bugs in ${scope}. Your lens this round: ${lens}.
       Round ${round + 1} of a multi-round hunt — prefer places a first-pass
       reviewer would skim past. Report only defects that produce wrong behavior
       at runtime, each with concrete evidence and a failure scenario. An empty
       list is a valid result.`,
      { label: `find:r${round + 1}:${i}`, phase: 'Hunt', schema: BUGS_SCHEMA },
    ),
  ))).filter(Boolean).flatMap(r => r.bugs)

  // Dedup against `seen`, never against `confirmed` — a refuted finding that
  // reappears must not get a second trial every round, or the hunt never dries.
  const fresh = found.filter(b => !seen.has(keyOf(b)))
  fresh.forEach(b => seen.add(keyOf(b)))

  if (fresh.length === 0) {
    dryRounds++
    log(`Round ${round + 1}: nothing new (${dryRounds}/2 dry rounds)`)
    round++
    continue
  }
  dryRounds = 0
  log(`Round ${round + 1}: ${found.length} reported, ${fresh.length} fresh candidates`)

  // Verify each fresh candidate with an independent skeptic panel. Panels for
  // different candidates all run concurrently.
  const judged = await parallel(fresh.map(b => () =>
    parallel(Array.from({ length: votes }, (_, v) => () =>
      agent(
        `Skeptic ${v + 1}/${votes}: try to REFUTE this bug claim by reading the code.
         Claim: ${b.title} (${b.severity}) at ${b.file}${b.line ? ':' + b.line : ''}
         Evidence: ${b.evidence}
         Failure scenario: ${b.failureScenario}
         Look for guards, unreachable paths, caller invariants, or covering tests
         that invalidate it. Default to refuted=true if you cannot confirm the
         failure scenario is reachable.`,
        { label: `verify:${b.file.split('/').pop()}:${v}`, phase: 'Verify', effort: 'high', schema: VERDICT_SCHEMA },
      ),
    )).then(verdicts => ({ bug: b, verdicts: verdicts.filter(Boolean) })),
  ))

  for (const j of judged.filter(Boolean)) {
    const upheld = j.verdicts.filter(v => !v.refuted).length
    if (upheld >= majority) confirmed.push({ ...j.bug, votes: `${upheld}/${j.verdicts.length} upheld` })
    else refutedCount++
  }
  log(`Round ${round + 1} verified: ${confirmed.length} total confirmed so far`)
  round++
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
return {
  confirmed: confirmed.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]),
  refuted: refutedCount,
  rounds: round,
  dry: dryRounds >= 2, // false = stopped on maxRounds/budget; the well may not be empty
}

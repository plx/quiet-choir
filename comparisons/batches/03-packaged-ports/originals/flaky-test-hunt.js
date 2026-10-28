/**
 * flaky-test-hunt — suspect sweep, empirical stress runs, root-cause diagnosis
 * ============================================================================
 *
 * USE CASE
 *   Flaky tests are diagnosed by rumor ("that one fails sometimes") and fixed
 *   by retry-wrapping. This workflow replaces rumor with evidence: three
 *   sweeps gather suspects (git history of retries/skips, smell-grep of test
 *   code, CI artifacts if present), each suspect is stress-run N times for an
 *   empirical flake rate, and only EMPIRICALLY flaky tests get a diagnosis
 *   agent — which must name a mechanism, not just wave at "timing".
 *
 * WHEN TO USE
 *   - CI red streaks nobody can explain
 *   - Before tightening CI retry policy (know what breaks first)
 *   - Inheriting a suite with a bad reputation
 *
 * ARGS
 *   { scope?: string, runs?: number, maxSuspects?: number, fix?: boolean }
 *   - runs: stress iterations per suspect (default 8)
 *   - maxSuspects: stress-run cap (default 10, corroborated suspects first)
 *   - fix: apply proposed fixes for diagnosed flakes (default false)
 *
 * PATTERNS DEMONSTRATED
 *   - Evidence over rumor: suspicion (cheap, parallel) is strictly separated
 *     from confirmation (empirical stress runs)
 *   - Multi-modal suspect gathering with corroboration boosting
 *   - Pipeline stress->diagnose: each suspect flows independently; a test
 *     with a 0% observed flake rate short-circuits out of its own chain
 *   - Diagnosis must name a mechanism from a closed taxonomy — "flaky" is
 *     not a diagnosis
 *
 * COST PROFILE
 *   3 sweeps + 1 stress runner per suspect + 1 diagnostician per confirmed
 *   flake (+1 fixer each with fix:true). Typically 10-20 agents.
 *
 * OUTPUT
 *   { confirmed: [...], cleared: [...], skipped, notes }
 */

export const meta = {
  name: 'flaky-test-hunt',
  description: 'Gather flaky-test suspects from git/CI/code smells, stress-run each for an empirical flake rate, then diagnose mechanisms for confirmed flakes',
  whenToUse: 'Unexplained CI red streaks, or auditing a test suite with a reputation for randomness',
  phases: [
    { title: 'Suspects', detail: 'git history ∥ smell grep ∥ CI artifacts' },
    { title: 'Stress', detail: 'N repeated runs per suspect' },
    { title: 'Diagnose', detail: 'mechanism + fix per confirmed flake' },
  ],
}

const SUSPECTS_SCHEMA = {
  type: 'object',
  required: ['suspects'],
  properties: {
    suspects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['test', 'file', 'evidence'],
        properties: {
          test: { type: 'string', description: 'test name/identifier as the runner sees it' },
          file: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    testCommand: { type: 'string', description: 'how to run a single test in this repo' },
  },
}

const STRESS_SCHEMA = {
  type: 'object',
  required: ['runs', 'failures', 'verdict'],
  properties: {
    runs: { type: 'number' },
    failures: { type: 'number' },
    verdict: { enum: ['flaky', 'stable', 'always-fails', 'could-not-run'] },
    failureOutput: { type: 'string', description: 'representative failure output, truncated' },
    timingNotes: { type: 'string', description: 'run durations if suggestive (e.g. failures correlate with slow runs)' },
  },
}

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  required: ['mechanism', 'explanation', 'proposedFix'],
  properties: {
    mechanism: {
      enum: ['shared-state', 'timing-timeout', 'async-race', 'external-dependency', 'random-data', 'resource-exhaustion', 'test-order-dependence', 'clock-dependence', 'unknown'],
    },
    explanation: { type: 'string', description: 'the causal story: WHY it fails only sometimes' },
    proposedFix: { type: 'string', description: 'a real fix — retry-wrapping only if the flake is genuinely external' },
    confidence: { enum: ['high', 'medium', 'low'] },
  },
}

const scope = (args && args.scope) || 'the test suite of this repository'
const runs = (args && args.runs) || 8
const maxSuspects = (args && args.maxSuspects) || 10
const applyFixes = Boolean(args && args.fix)

// --------------------------------------------------------------------------
// Phase 1: Three suspect sweeps, three kinds of evidence. Barrier justified:
// corroboration (same test flagged by 2+ modalities) drives the stress-run
// priority order, which needs all sweeps merged.
// --------------------------------------------------------------------------

phase('Suspects')

const sweeps = await parallel([
  () => agent(
    `Find flaky-test SUSPECTS in ${scope} via git history: log/blame for commits
     mentioning flaky/flake/retry/deflake/skip/quarantine/"fix test", tests whose
     files churn without behavior changes, and skip/only markers added then
     removed. Also report how to run a SINGLE test in this repo (exact command
     shape). Suspects only — do not run anything.`,
    { label: 'sweep:git-history', schema: SUSPECTS_SCHEMA },
  ),
  () => agent(
    `Find flaky-test SUSPECTS in ${scope} by grepping test code for flake smells:
     sleeps/arbitrary waits, real-clock time or "now" comparisons, unseeded
     randomness, real network/filesystem/ports, order-dependent shared fixtures,
     race-prone async patterns (unawaited promises, fire-and-forget), generous
     custom timeouts, and retry annotations already present. Report the specific
     smell per suspect. Do not run anything.`,
    { label: 'sweep:smells', schema: SUSPECTS_SCHEMA },
  ),
  () => agent(
    `Find flaky-test SUSPECTS from CI/test artifacts in this repo, if any exist:
     CI config with retry settings, junit/report XML, .github workflow logs
     checked into the repo, quarantine lists, test-results directories. If no
     artifacts exist, return an empty suspects list — do not guess.`,
    { label: 'sweep:ci-artifacts', schema: SUSPECTS_SCHEMA },
  ),
])

const merged = new Map()
for (const s of sweeps.filter(Boolean)) {
  for (const sus of s.suspects) {
    const key = `${sus.file}::${sus.test}`
    if (!merged.has(key)) merged.set(key, { ...sus, corroboration: 1 })
    else {
      const prev = merged.get(key)
      merged.set(key, { ...prev, evidence: `${prev.evidence} | ${sus.evidence}`, corroboration: prev.corroboration + 1 })
    }
  }
}
const testCommand = sweeps.filter(Boolean).map(s => s.testCommand).find(Boolean) || 'find the repo\'s single-test command'
let suspects = [...merged.values()].sort((a, b) => b.corroboration - a.corroboration)

if (suspects.length === 0) return { confirmed: [], cleared: [], skipped: 0, notes: 'No flaky-test suspects found by any modality.' }
const skippedCount = Math.max(0, suspects.length - maxSuspects)
if (skippedCount) log(`Cap: stress-running top ${maxSuspects} of ${suspects.length} suspects (corroboration-ranked)`)
suspects = suspects.slice(0, maxSuspects)
log(`${suspects.length} suspects to stress-run, ${runs} runs each`)

// --------------------------------------------------------------------------
// Phases 2-3 as a pipeline: stress -> diagnose per suspect, independently.
// A suspect that stress-runs stable short-circuits (returns early from its
// chain); the diagnostician only ever sees empirical failures — it reasons
// from evidence, not from the sweep's suspicion.
// --------------------------------------------------------------------------

const results = await pipeline(
  suspects,

  (sus) => agent(
    `Stress-run this test ${runs} times and report the empirical flake rate.
     Test: ${sus.test}  File: ${sus.file}
     Single-test command shape: ${testCommand}
     Run it ${runs} times sequentially (a shell loop is fine). Count failures.
     Capture one representative failure output if any occur, and note run
     durations if failures correlate with timing. If ALL runs fail it's broken,
     not flaky — verdict "always-fails". If the test can't be run in this
     environment (needs live services), verdict "could-not-run" — do not
     simulate results.`,
    { label: `stress:${sus.test.slice(0, 30)}`, phase: 'Stress', effort: 'low', schema: STRESS_SCHEMA },
  ).then(r => ({ suspect: sus, stress: r })),

  (r) => {
    if (!r || !r.stress || r.stress.verdict !== 'flaky') return r
    return agent(
      `Diagnose WHY this test is flaky. It failed ${r.stress.failures}/${r.stress.runs} stress runs.
       Test: ${r.suspect.test}  File: ${r.suspect.file}
       Sweep evidence: ${r.suspect.evidence}
       Failure output: ${r.stress.failureOutput || 'none captured'}
       Timing notes: ${r.stress.timingNotes || 'none'}
       Read the test AND the code under test. Name the mechanism from the schema's
       taxonomy and tell the causal story: what interleaving/state/timing makes it
       fail only sometimes. Propose a real fix targeting the mechanism —
       retry-wrapping is acceptable only for genuinely-external dependencies.
       ${applyFixes ? 'Then APPLY the fix, re-stress 5 runs, and report.' : 'Do not apply the fix.'}`,
      { label: `diagnose:${r.suspect.test.slice(0, 25)}`, phase: 'Diagnose', effort: 'high', schema: DIAGNOSIS_SCHEMA },
    ).then(d => ({ ...r, diagnosis: d }))
  },
)

const done = results.filter(Boolean)
const confirmed = done.filter(r => r.stress && r.stress.verdict === 'flaky').map(r => ({
  test: r.suspect.test,
  file: r.suspect.file,
  flakeRate: `${r.stress.failures}/${r.stress.runs}`,
  mechanism: r.diagnosis ? r.diagnosis.mechanism : 'undiagnosed',
  explanation: r.diagnosis ? r.diagnosis.explanation : null,
  proposedFix: r.diagnosis ? r.diagnosis.proposedFix : null,
  confidence: r.diagnosis ? r.diagnosis.confidence : null,
}))
const cleared = done.filter(r => r.stress && r.stress.verdict === 'stable').map(r => r.suspect.test)
const other = done.filter(r => r.stress && (r.stress.verdict === 'always-fails' || r.stress.verdict === 'could-not-run'))

log(`${confirmed.length} empirically flaky, ${cleared.length} cleared, ${other.length} broken/unrunnable`)

return {
  confirmed,
  cleared,
  skipped: skippedCount,
  notes: other.length
    ? `Also found: ${other.map(r => `${r.suspect.test} (${r.stress.verdict})`).join('; ')}. ${skippedCount ? `${skippedCount} suspects deferred — re-run with higher maxSuspects.` : ''}`
    : (skippedCount ? `${skippedCount} suspects deferred — re-run with higher maxSuspects.` : 'All suspects processed.'),
}

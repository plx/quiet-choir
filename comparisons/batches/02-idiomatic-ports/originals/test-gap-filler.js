/**
 * test-gap-filler — find the riskiest untested code, then write tests that earn their keep
 * ========================================================================================
 *
 * USE CASE
 *   "Improve coverage" usually produces tests for whatever was easiest to
 *   test. This workflow inverts that: two independent gap-finders (one
 *   tooling-driven, one risk-driven) surface untested code, a prioritizer
 *   ranks gaps by blast-radius-if-broken rather than by line count, and one
 *   writer per gap produces tests that must RUN GREEN before they count.
 *   Each writer proves its tests actually exercise the target — a test that
 *   passes against a stubbed-out target is rejected by its own author.
 *
 * WHEN TO USE
 *   - Legacy code you must change soon and dare not change untested
 *   - Post-incident hardening ("how was THAT not covered?")
 *   - Ratcheting a low-coverage repo upward, highest-risk-first
 *
 * ARGS
 *   { scope?: string, count?: number, framework?: string }
 *   - scope: where to look (default: whole repo)
 *   - count: how many gaps to fill (default 5)
 *   - framework: test framework hint (default: infer from the repo)
 *
 * PATTERNS DEMONSTRATED
 *   - Dual-modality gap discovery: coverage tooling (precise, blind to risk)
 *     + risk reading (judgment, blind to numbers) — merged before ranking
 *   - Prioritize-then-pipeline: one cheap ranking barrier, then each gap
 *     flows write -> run -> harden independently
 *   - Self-verifying writers: the writer must run its own tests and
 *     mutation-check them (break the target, watch the test fail)
 *   - Disjoint file sharding: gaps are grouped by TARGET FILE and each group is
 *     filled in sequence, because mutation-checking edits the target source —
 *     two agents breaking and restoring one file concurrently will revert each
 *     other's work, silently. Shards never share a path, so no worktree is
 *     needed; without the sharding, one would be.
 *
 * COST PROFILE
 *   2 finders + 1 ranker + 2 agents per gap (write+verify). Default count=5
 *   ≈ 13 agents.
 *
 * OUTPUT
 *   { filled: [...], failed: [...], skippedGaps, summary }
 */

export const meta = {
  name: 'test-gap-filler',
  description: 'Find untested high-risk code via coverage tooling + risk analysis, rank by blast radius, write and mutation-check tests per gap',
  whenToUse: 'Raising test coverage where it matters most — before risky changes, after incidents, or ratcheting a legacy repo',
  phases: [
    { title: 'Find gaps', detail: 'coverage tooling ∥ risk-based reading' },
    { title: 'Prioritize', detail: 'rank by blast radius, pick top N' },
    { title: 'Fill', detail: 'write, run, and mutation-check tests per gap' },
  ],
}

const GAPS_SCHEMA = {
  type: 'object',
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['target', 'file', 'why'],
        properties: {
          target: { type: 'string', description: 'function/class/module lacking tests' },
          file: { type: 'string' },
          why: { type: 'string', description: 'evidence it is untested + why that is scary' },
          riskHint: { enum: ['critical-path', 'error-handling', 'data-integrity', 'boundary', 'other'] },
        },
      },
    },
    testCommand: { type: 'string', description: 'how this repo runs tests' },
    framework: { type: 'string', description: 'detected test framework and conventions' },
  },
}

const RANKED_SCHEMA = {
  type: 'object',
  required: ['ranked'],
  properties: {
    ranked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['target', 'file', 'reason', 'testPlan'],
        properties: {
          target: { type: 'string' },
          file: { type: 'string' },
          reason: { type: 'string', description: 'why this gap outranks the ones below it' },
          testPlan: { type: 'string', description: '3-6 specific cases the tests must cover, failure paths first' },
        },
      },
    },
  },
}

const FILL_SCHEMA = {
  type: 'object',
  required: ['status', 'testFile', 'summary'],
  properties: {
    status: { enum: ['green', 'red', 'blocked'] },
    testFile: { type: 'string' },
    summary: { type: 'string' },
    casesCovered: { type: 'array', items: { type: 'string' } },
    mutationChecked: { type: 'boolean', description: 'true if the author verified tests fail when the target is broken' },
  },
}

const scope = (args && args.scope) || 'the entire repository'
const count = (args && args.count) || 5

// --------------------------------------------------------------------------
// Phase 1: Find gaps two ways at once. The tooling finder is precise but
// risk-blind; the risk finder has judgment but no numbers. Their union,
// deduped, is better than either. Barrier justified: ranking needs both.
// --------------------------------------------------------------------------

phase('Find gaps')

const [tooled, risky] = await parallel([
  () => agent(
    `Find untested code in ${scope} using the repo's own tooling. If a coverage
     tool is configured (nyc/istanbul, coverage.py, go cover, tarpaulin...), run
     it and read the report. If not, approximate: list source files/functions
     with no corresponding test file or no test that references them. Also report
     the repo's test command and framework conventions (runner, file naming,
     assertion style). Report up to 15 gaps with evidence.`,
    { label: 'gaps:tooling', schema: GAPS_SCHEMA },
  ),
  () => agent(
    `Find the SCARIEST untested code in ${scope} by reading, not by tooling.
     Look for: error/rollback paths, money/data-integrity logic, parsing of
     external input, concurrency, and anything with a comment like "careful" or
     a git history full of fixes — then check whether tests exercise it (grep the
     test tree for references; read the tests that exist to see if they cover the
     dangerous cases or just the happy path). Report up to 10 gaps; "tests exist
     but miss the failure paths" counts as a gap.`,
    { label: 'gaps:risk', schema: GAPS_SCHEMA },
  ),
])

const merged = new Map()
for (const src of [tooled, risky].filter(Boolean)) {
  for (const g of src.gaps) {
    const key = `${g.file}::${g.target}`
    if (!merged.has(key)) merged.set(key, g)
    else merged.set(key, { ...merged.get(key), why: `${merged.get(key).why} | also: ${g.why}`, corroborated: true })
  }
}
const gaps = [...merged.values()]
const testCommand = (tooled && tooled.testCommand) || (risky && risky.testCommand) || null
const framework = (args && args.framework) || (tooled && tooled.framework) || (risky && risky.framework) || 'infer from the repo'

if (gaps.length === 0) return { filled: [], failed: [], skippedGaps: 0, summary: 'No test gaps found.' }
log(`${gaps.length} unique gaps (${gaps.filter(g => g.corroborated).length} found by both modalities)`)

// --------------------------------------------------------------------------
// Phase 2: Prioritize. One cheap agent ranks by blast-radius-if-broken and
// writes a concrete test plan per chosen gap — the plan is what keeps the
// writers from drifting into happy-path-only tests.
// --------------------------------------------------------------------------

phase('Prioritize')

const ranking = await agent(
  `Rank these test gaps by blast radius: if this code silently broke, how bad
   and how invisible would the damage be? Corroborated gaps (found by both a
   coverage tool and a risk reader) get a boost. Pick the top ${count} and give
   each a concrete test plan of 3-6 cases, FAILURE PATHS FIRST — the plan should
   name specific inputs and expected outcomes, not "test edge cases".
   Gaps: ${JSON.stringify(gaps, null, 2)}`,
  { label: 'rank', effort: 'high', schema: RANKED_SCHEMA },
)

if (!ranking || ranking.ranked.length === 0) {
  return { filled: [], failed: [], skippedGaps: gaps.length, summary: 'Ranking failed — no tests written.' }
}
const chosen = ranking.ranked.slice(0, count)
log(`Filling ${chosen.length} gaps; ${gaps.length - chosen.length} lower-priority gaps deferred`)

// --------------------------------------------------------------------------
// Phase 3: Fill — write+run, then independently verify with fresh eyes; a
// writer grading its own homework passes things a verifier won't.
//
// SHARDED BY TARGET FILE, and that is load-bearing. The new TEST files are
// disjoint per gap, but both stages below mutation-check, which means both
// EDIT THE TARGET SOURCE: "temporarily break the target ... restore it". Two
// agents holding different gaps in the same file will snapshot, break and
// restore it concurrently, and one agent's "restore it exactly" writes back a
// snapshot taken before the other's work — silently reverting it. That is not
// hypothetical: it happened to this repo, and a real fix was lost mid-run.
//
// Grouping by file gives each file a single owner for the whole write→verify
// chain, so mutations of one file never interleave. Different files still run
// concurrently. Same disjoint-shard reasoning as api-migration.js, and it is
// why no worktree is needed: the shards cannot touch the same path.
// --------------------------------------------------------------------------

const byFile = new Map()
for (const gap of chosen) {
  const key = gap.file || '(unknown file)'
  if (!byFile.has(key)) byFile.set(key, [])
  byFile.get(key).push(gap)
}
const shards = [...byFile.values()]
if (shards.length < chosen.length) {
  log(`${chosen.length} gaps across ${shards.length} files; gaps sharing a file run in sequence so their mutation checks cannot collide`)
}

const results = (await pipeline(
  shards,

  // Write every gap in this file, one at a time. Sequential WITHIN the shard.
  async (gapsInFile) => {
    const written = []
    for (const gap of gapsInFile) written.push({ gap, fill: await writeTestsFor(gap) })
    return written
  },

  // Verify them, still one at a time, still the only agent touching this file.
  async (written) => {
    const out = []
    for (const { gap, fill } of written) out.push(await verifyTestsFor(gap, fill))
    return out
  },
)).filter(Boolean).flat()

function writeTestsFor(gap) {
  return agent(
    `Write tests for "${gap.target}" in ${gap.file}.
     Why it matters: ${gap.reason}
     Required cases (failure paths first): ${gap.testPlan}
     Framework/conventions: ${framework}
     ${testCommand ? `Test command: ${testCommand}` : 'Find the repo test command.'}

     Rules: follow the repo's existing test structure and naming; create a NEW
     test file (or extend the target's existing one — never touch other tests).
     RUN your tests until green. Then mutation-check: temporarily break the
     target (flip a condition), confirm at least one test fails, restore it, and
     re-run green. Tests that pass against broken code are worthless — rewrite
     them if that happens. Report status honestly: "red" beats fake green.

     RESTORE ${gap.file} BEFORE YOU REPORT, on every path — including when you
     give up. A mutation left in place is a defect you introduced, and it is
     invisible: the suite may still be green because the very gap you are here
     to fill means nothing tests it. Copy the file before you touch it and
     diff against that copy as your last act.`,
    { label: `write:${gap.target.slice(0, 25)}`, phase: 'Fill', schema: FILL_SCHEMA },
  )
}

function verifyTestsFor(gap, fill) {
  if (!fill || fill.status !== 'green') return Promise.resolve(fill)
  return agent(
    `Independently verify new tests in ${fill.testFile} for "${gap.target}" (${gap.file}).
     ${testCommand ? `Test command: ${testCommand}` : ''}
     1. Run them — confirm green.
     2. Your own mutation check: introduce a DIFFERENT bug into the target than
        a naive author would think of (wrong boundary, swapped branch), confirm
        a test fails, then restore the file exactly.
     3. Read the assertions: do they check outcomes, or just "doesn't throw"?
     Report status "green" only if all three hold; otherwise "red" with why.

     RESTORE ${gap.file} BEFORE YOU REPORT, on every path — including when you
     report red. Copy it before you touch it and diff against that copy last.`,
    { label: `check:${gap.target.slice(0, 25)}`, phase: 'Fill', effort: 'high', schema: FILL_SCHEMA },
  ).then(v => (v && v.status === 'green' ? { ...fill, verified: true } : { ...(v || fill), status: 'red' }))
}

const filled = results.filter(Boolean).filter(r => r.status === 'green')
const failedFills = results.filter(Boolean).filter(r => r.status !== 'green')

return {
  filled: filled.map(f => ({ testFile: f.testFile, cases: f.casesCovered, verified: Boolean(f.verified) })),
  failed: failedFills.map(f => ({ testFile: f.testFile, status: f.status, summary: f.summary })),
  skippedGaps: gaps.length - chosen.length,
  summary: `${filled.length}/${chosen.length} gaps filled with verified-green tests; ${gaps.length - chosen.length} known gaps deferred (re-run to continue).`,
}

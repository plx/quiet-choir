/**
 * dependency-upgrade — research and impact analysis converge on a fix loop
 * ========================================================================
 *
 * USE CASE
 *   Major-version upgrades fail for two independent reasons: you didn't know
 *   what the package changed (research gap) or you didn't know how much you
 *   depended on the changed parts (impact gap). This workflow closes both
 *   gaps in parallel — a researcher reads changelogs/migration guides while
 *   an impact analyst maps your actual usage — then joins them into a plan,
 *   applies it, and drives a bounded fix loop until the build and tests pass.
 *
 * WHEN TO USE
 *   - Major-version bumps of load-bearing dependencies
 *   - Clearing a backlog of security-flagged upgrades one package at a time
 *   - Framework upgrades (run with a generous budget)
 *
 * ARGS  (required: package)
 *   { package: string, toVersion?: string, maxFixRounds?: number }
 *
 * PATTERNS DEMONSTRATED
 *   - Parallel research + impact analysis with a JUSTIFIED barrier: the plan
 *     genuinely needs both halves (changes × usage = risk)
 *   - Bounded fix loop: verify -> cluster failures -> parallel fixers ->
 *     re-verify, max N rounds, honest failure report if the loop doesn't
 *     converge (no infinite churn)
 *   - Web research delegated to a subagent that can use WebSearch/WebFetch
 *     via ToolSearch — the workflow script itself never touches the network
 *
 * COST PROFILE
 *   2 analysts + 1 planner + 1 applier + per round (1 verifier + ≤3 fixers).
 *   Typically 8-15 agents for a well-documented package.
 *
 * OUTPUT
 *   { package, from, to, status, riskNotes, rounds, remaining }
 */

export const meta = {
  name: 'dependency-upgrade',
  description: 'Upgrade a dependency: parallel changelog research + usage impact analysis, then apply and drive a bounded verify/fix loop',
  whenToUse: 'Major-version dependency bumps where breaking changes are likely and usage is nontrivial',
  phases: [
    { title: 'Analyze', detail: 'changelog research ∥ usage impact map' },
    { title: 'Plan', detail: 'join both analyses into an upgrade plan' },
    { title: 'Apply', detail: 'perform the upgrade + mechanical fixes' },
    { title: 'Stabilize', detail: 'verify/fix loop until green or round cap' },
  ],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['currentMajor', 'targetVersion', 'breakingChanges'],
  properties: {
    currentMajor: { type: 'string' },
    targetVersion: { type: 'string' },
    breakingChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['change', 'affects'],
        properties: {
          change: { type: 'string' },
          affects: { type: 'string', description: 'which APIs/patterns this breaks' },
          migrationHint: { type: 'string' },
        },
      },
    },
    migrationGuideUrl: { type: 'string' },
    notes: { type: 'string' },
  },
}

const IMPACT_SCHEMA = {
  type: 'object',
  required: ['currentVersion', 'usageSites'],
  properties: {
    currentVersion: { type: 'string', description: 'exact installed version from the lockfile' },
    usageSites: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'apis'],
        properties: {
          file: { type: 'string' },
          apis: { type: 'array', items: { type: 'string' }, description: 'which of the package\'s APIs this file uses' },
          heaviness: { enum: ['light', 'moderate', 'heavy'] },
        },
      },
    },
    indirectExposure: { type: 'string', description: 'wrappers, adapters, or re-exports that concentrate usage' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['riskLevel', 'steps', 'riskNotes'],
  properties: {
    riskLevel: { enum: ['trivial', 'moderate', 'risky', 'reconsider'] },
    steps: { type: 'array', items: { type: 'string' }, description: 'ordered, concrete steps for the applier' },
    riskNotes: { type: 'string', description: 'where this upgrade is most likely to break things' },
    testFocus: { type: 'array', items: { type: 'string' }, description: 'areas the verifier should scrutinize hardest' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'summary'],
  properties: {
    passed: { type: 'boolean' },
    summary: { type: 'string' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
      description: 'clustered by root cause',
    },
  },
}

if (!args || !args.package) {
  return { error: 'dependency-upgrade requires args: { package }. Optional: { toVersion, maxFixRounds }' }
}
const pkg = args.package
const targetVersion = args.toVersion || 'latest stable'
const maxFixRounds = (args && args.maxFixRounds) || 3

// --------------------------------------------------------------------------
// Phase 1: Analyze — the two halves of upgrade risk, in parallel. The barrier
// after this is the textbook justified case: the plan is literally a join of
// (what changed) × (what we use).
// --------------------------------------------------------------------------

phase('Analyze')

const [research, impact] = await parallel([
  () => agent(
    `Research upgrading "${pkg}" to ${targetVersion}. Use web search / fetch tools
     (load them via ToolSearch if needed) to read the official changelog, release
     notes, and migration guide. Determine the installed major version from this
     repo's lockfile first, then enumerate every breaking change between it and
     the target — what it breaks and the official migration hint. Prioritize the
     package's own docs over blog posts.`,
    { label: 'research', schema: RESEARCH_SCHEMA },
  ),
  () => agent(
    `Map this repository's usage of the package "${pkg}". Read the lockfile for
     the exact installed version. Find every file importing/requiring it, note
     WHICH of its APIs each file touches and how heavily. Identify wrappers or
     adapter modules that concentrate the usage (those make upgrades cheaper —
     say so). Do not read the package's own docs; only this repo.`,
    { label: 'impact', schema: IMPACT_SCHEMA },
  ),
])

if (!research || !impact) {
  return { package: pkg, status: 'aborted', riskNotes: 'Analysis failed (research or impact agent unavailable) — no changes made.', rounds: 0, remaining: [] }
}
log(`${pkg}: ${impact.currentVersion} -> ${research.targetVersion}; ${research.breakingChanges.length} breaking changes, ${impact.usageSites.length} usage files`)

// --------------------------------------------------------------------------
// Phase 2: Plan — the join. Kept as its own cheap agent (not folded into the
// applier) so the plan is inspectable in the journal when things go wrong.
// --------------------------------------------------------------------------

phase('Plan')

const plan = await agent(
  `Create an upgrade plan for "${pkg}" ${impact.currentVersion} -> ${research.targetVersion}.
   Breaking changes: ${JSON.stringify(research.breakingChanges, null, 2)}
   Our usage: ${JSON.stringify(impact.usageSites, null, 2)}
   Indirect exposure: ${impact.indirectExposure || 'none noted'}

   Cross-reference: which breaking changes actually hit our usage? Produce
   ordered steps for an applier agent (bump manifest, run install, then each
   code change grouped sensibly), riskNotes, and testFocus areas. If the
   intersection is empty, say riskLevel "trivial" with a two-step plan. If the
   upgrade looks unwise (e.g. half the codebase is on removed APIs), say
   "reconsider" and explain in riskNotes.`,
  { label: 'plan', effort: 'high', schema: PLAN_SCHEMA },
)

if (!plan || plan.riskLevel === 'reconsider') {
  return {
    package: pkg, from: impact.currentVersion, to: research.targetVersion,
    status: 'not-attempted', riskNotes: plan ? plan.riskNotes : 'planner unavailable', rounds: 0,
    remaining: plan ? plan.steps : [],
  }
}

// --------------------------------------------------------------------------
// Phase 3: Apply — one agent executes the whole plan. Upgrades are not
// parallelizable at this stage: the manifest bump, install, and code changes
// form one dependent sequence.
// --------------------------------------------------------------------------

phase('Apply')

await agent(
  `Execute this dependency-upgrade plan for "${pkg}" (${impact.currentVersion} -> ${research.targetVersion}).
   Steps: ${JSON.stringify(plan.steps, null, 2)}
   Risk notes: ${plan.riskNotes}
   Use the repository's own package manager (respect the lockfile format). Make
   the code changes the plan calls for. Do not run the full test suite — the
   stabilize loop handles that. Report what you did.`,
  { label: 'apply' },
)

// --------------------------------------------------------------------------
// Phase 4: Stabilize — the bounded fix loop. Each round: one global verify,
// failures clustered by root cause, up to 3 parallel fixers on disjoint
// clusters, re-verify. Bounded because an upgrade that won't converge in 3
// rounds needs a human decision, not more agents.
// --------------------------------------------------------------------------

phase('Stabilize')

let rounds = 0
let verification = null

while (rounds < maxFixRounds) {
  rounds++
  verification = await agent(
    `Verify the "${pkg}" upgrade (round ${rounds}/${maxFixRounds}). Run the repo's
     build/typecheck and test suite (find the commands). Scrutinize especially:
     ${(plan.testFocus || []).join('; ') || 'all touched areas'}.
     Cluster failures by root cause — not one entry per failing test.`,
    { label: `verify:r${rounds}`, phase: 'Stabilize', schema: VERIFY_SCHEMA },
  )
  if (!verification || verification.passed) break

  const clusters = verification.failures.slice(0, 3)
  if (verification.failures.length > 3) log(`Round ${rounds}: fixing top 3 of ${verification.failures.length} clusters`)
  await parallel(clusters.map((f, i) => () =>
    agent(
      `Fix this failure cluster caused by upgrading "${pkg}" to ${research.targetVersion}:
       ${f.description}
       Files: ${(f.files || []).join(', ') || 'identify from the failure'}
       Known breaking changes for reference: ${JSON.stringify(research.breakingChanges)}
       Fix forward (adopt the new API) rather than pinning back. Edit in place;
       run only the narrow check for this cluster.`,
      { label: `fix:r${rounds}:${i}`, phase: 'Stabilize' },
    ),
  ))
}

const green = Boolean(verification && verification.passed)
return {
  package: pkg,
  from: impact.currentVersion,
  to: research.targetVersion,
  status: green ? 'upgraded' : 'unstable',
  riskNotes: plan.riskNotes,
  rounds,
  remaining: green ? [] : (verification ? verification.failures : ['verifier unavailable']),
}

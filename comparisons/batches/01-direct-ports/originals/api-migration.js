/**
 * api-migration — discover call sites, transform them in parallel, verify once
 * ============================================================================
 *
 * USE CASE
 *   Mechanical-but-judgment-requiring migrations: renaming an API, swapping a
 *   library, moving from callbacks to async/await, changing a function's
 *   contract. Codemods handle the 80% that's regular; the long tail needs a
 *   model reading each call site in context. This workflow shards the tail:
 *   discovery groups call sites by file, one transformer per file group runs
 *   concurrently, and a single verifier runs the build/tests once at the end
 *   (global checks are shared state — running them per-transformer would
 *   race and waste tokens).
 *
 * WHEN TO USE
 *   - Library/API swaps with tens-to-hundreds of call sites
 *   - Contract changes where each caller needs contextual judgment
 *   - Deprecation burn-downs
 *
 * ARGS  (required: from, to)
 *   { from: string, to: string, notes?: string, paths?: string, batchSize?: number }
 *   - from/to: the old and new API, in plain language or signatures
 *   - notes: migration guide content, gotchas, edge-case rules
 *   - paths: limit discovery (default: whole repo)
 *   - batchSize: max transformers per wave (default 8)
 *
 * PATTERNS DEMONSTRATED
 *   - Discover-then-shard: discovery output IS the work list
 *   - Same-repo parallel edits WITHOUT worktrees: transformers touch disjoint
 *     files by construction (grouped by file), so worktree isolation would be
 *     pure overhead — the comment in Phase 2 explains the decision rule
 *   - Wave batching with explicit logs instead of silent truncation
 *   - Single global verify + one repair round, instead of per-agent test runs
 *
 * COST PROFILE
 *   1 discovery + 1 transformer per file group (waved) + 1 verifier + up to 3
 *   repairers. A 30-file migration ≈ 35 agents; scale batchSize to taste.
 *
 * OUTPUT
 *   { migrated: [...], failed: [...], verification, notes }
 */

export const meta = {
  name: 'api-migration',
  description: 'Discover every call site of an old API, migrate file groups in parallel, then build/test once and repair fallout',
  whenToUse: 'Library swaps, API renames, and contract changes with many call sites needing contextual judgment — the long tail codemods cannot handle',
  phases: [
    { title: 'Discover', detail: 'find and group every call site' },
    { title: 'Transform', detail: 'one migrator per file group, in waves' },
    { title: 'Verify', detail: 'single build/test pass + repair round' },
  ],
}

const SITES_SCHEMA = {
  type: 'object',
  required: ['groups', 'totalSites'],
  properties: {
    totalSites: { type: 'number' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['files', 'siteCount'],
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'files migrated together (usually 1; more if tightly coupled)' },
          siteCount: { type: 'number' },
          notes: { type: 'string', description: 'anything unusual about these sites' },
        },
      },
    },
    buildCommand: { type: 'string', description: 'command that compiles/typechecks the repo, if any' },
    testCommand: { type: 'string', description: 'command that runs the test suite, if any' },
  },
}

const TRANSFORM_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['migrated', 'partial', 'blocked'] },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'sites left unmigrated and why' },
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
      description: 'distinct failure clusters, not one entry per failing test',
    },
  },
}

if (!args || !args.from || !args.to) {
  return { error: 'api-migration requires args: { from, to }. Example: { from: "moment(x).format(...)", to: "date-fns format(x, ...)" }' }
}

// --------------------------------------------------------------------------
// Phase 1: Discover. One agent finds every call site and — critically —
// groups them into disjoint file sets. Disjointness is what lets Phase 2 run
// concurrent editors in the SAME working tree safely.
// --------------------------------------------------------------------------

phase('Discover')

const discovery = await agent(
  `Find every call site that must change for this migration:
   FROM: ${args.from}
   TO:   ${args.to}
   ${args.notes ? `Migration notes: ${args.notes}` : ''}
   Search ${args.paths || 'the whole repository'} (grep for identifiers, imports,
   type references — include indirect uses like re-exports and mocks in tests).
   Group sites into DISJOINT file groups: normally one file per group, but if two
   files must change atomically (e.g. a module and its inseparable test), put
   them in one group. No file may appear in two groups. Also report the repo's
   build/typecheck command and test command if they exist.`,
  { label: 'discover', schema: SITES_SCHEMA },
)

if (!discovery || discovery.groups.length === 0) {
  return { migrated: [], failed: [], verification: 'nothing to do', notes: 'Discovery found no call sites.' }
}
log(`${discovery.totalSites} call sites across ${discovery.groups.length} file groups`)

// --------------------------------------------------------------------------
// Phase 2: Transform in waves.
//
// Why NO worktree isolation: worktrees exist for agents that would conflict
// editing the same files. These groups are disjoint by construction, so
// concurrent editors in one tree cannot collide — and worktrees would each pay
// setup cost plus a merge problem at the end. Decision rule: shared files ->
// worktrees; disjoint files -> same tree.
//
// Waves (batchSize at a time) keep failures visible early: if wave 1 comes
// back all-blocked, the migration notes are probably wrong — better to see
// that after 8 files than after 80.
// --------------------------------------------------------------------------

phase('Transform')

const batchSize = (args && args.batchSize) || 8
const migrated = []
const failed = []

for (let w = 0; w * batchSize < discovery.groups.length; w++) {
  const wave = discovery.groups.slice(w * batchSize, (w + 1) * batchSize)
  log(`Wave ${w + 1}: migrating ${wave.length} file groups`)

  const results = await parallel(wave.map(group => () =>
    agent(
      `Migrate these files from the old API to the new one. Edit files in place.
       FROM: ${args.from}
       TO:   ${args.to}
       ${args.notes ? `Migration notes: ${args.notes}` : ''}
       Files (yours alone — no other agent touches them): ${group.files.join(', ')}
       Expected sites: ~${group.siteCount}. ${group.notes || ''}

       Read each file fully before editing; match the surrounding style. Migrate
       every site. Update imports. Do NOT run the repo's build or tests — a
       dedicated verifier does that globally afterwards. If a site cannot be
       migrated mechanically, leave it working on the old API, mark status
       "partial", and list it in blockers with the reason.`,
      { label: `migrate:${group.files[0].split('/').pop()}`, phase: 'Transform', schema: TRANSFORM_SCHEMA },
    ).then(r => ({ group, result: r })),
  ))

  for (const r of results.filter(Boolean)) {
    if (r.result && r.result.status !== 'blocked') migrated.push({ files: r.group.files, ...r.result })
    else failed.push({ files: r.group.files, ...(r.result || { status: 'error', summary: 'agent failed' }) })
  }

  // Early abort if the wave face-planted — don't burn the remaining waves on
  // instructions that demonstrably don't work.
  if (results.filter(Boolean).every(r => r.result && r.result.status === 'blocked')) {
    log('Entire wave blocked — aborting remaining waves; migration notes likely need revision')
    break
  }
}

// --------------------------------------------------------------------------
// Phase 3: Verify once, globally. Build + tests are shared state: one runner.
// Failure clusters get one repair round (max 3 repairers), then re-verify.
// --------------------------------------------------------------------------

phase('Verify')

const verifyPrompt = (attempt) =>
  `Verify the ${args.from} -> ${args.to} migration (attempt ${attempt}).
   ${discovery.buildCommand ? `Build/typecheck: ${discovery.buildCommand}` : 'Find and run the build/typecheck command if one exists.'}
   ${discovery.testCommand ? `Tests: ${discovery.testCommand}` : 'Find and run the test suite if one exists.'}
   Also grep for leftover references to the OLD API outside the known blockers.
   Report pass/fail with distinct failure clusters (group by root cause).`

let verification = await agent(verifyPrompt(1), { label: 'verify', schema: VERIFY_SCHEMA })

if (verification && !verification.passed && verification.failures && verification.failures.length > 0) {
  const clusters = verification.failures.slice(0, 3)
  if (verification.failures.length > 3) log(`Repairing top 3 of ${verification.failures.length} failure clusters`)
  await parallel(clusters.map((f, i) => () =>
    agent(
      `Fix this failure cluster from the ${args.from} -> ${args.to} migration:
       ${f.description}
       Files involved: ${(f.files || []).join(', ') || 'identify from the failure'}
       Edit in place; run only the narrow check for this cluster, not the full suite.`,
      { label: `repair:${i}`, phase: 'Verify' },
    ),
  ))
  verification = await agent(verifyPrompt(2), { label: 're-verify', phase: 'Verify', schema: VERIFY_SCHEMA })
}

return {
  migrated,
  failed,
  verification: verification ? verification.summary : 'verifier unavailable',
  notes: failed.length > 0
    ? 'Some groups were blocked — see failed[].blockers; they still work on the old API.'
    : 'All discovered groups migrated.',
}

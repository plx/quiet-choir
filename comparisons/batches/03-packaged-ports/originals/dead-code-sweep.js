/**
 * dead-code-sweep — multi-modal candidate discovery, skeptical cross-check
 * ========================================================================
 *
 * USE CASE
 *   Dead code is easy to suspect and dangerous to confirm: an "unused" export
 *   may be consumed by dynamic import, reflection, a string-built route table,
 *   dependency injection, or an external package. This workflow finds
 *   candidates through three different search modalities (each blind to the
 *   others), then gives every candidate to a skeptic whose ONLY job is to
 *   find a living reference — with a hard default-to-keep bias. Only
 *   candidates that survive get removed (or reported, in the default
 *   report-only mode).
 *
 * WHEN TO USE
 *   - Periodic hygiene sweeps of a long-lived codebase
 *   - Before a big refactor: shrink the terrain first
 *   - After a feature removal that probably left orphans
 *
 * ARGS
 *   { scope?: string, apply?: boolean, maxCandidates?: number }
 *   - scope: where to sweep (default: whole repo)
 *   - apply: actually delete confirmed-dead code (default false = report only)
 *   - maxCandidates: cross-check cap (default 20; excess logged)
 *
 * PATTERNS DEMONSTRATED
 *   - Multi-modal sweep: three finders searching DIFFERENT ways (export
 *     analysis, entrypoint reachability, artifact staleness) — one angle
 *     never finds everything
 *   - Asymmetric-risk verification: the skeptic defaults to KEEP, because a
 *     false "dead" verdict breaks production and a false "alive" verdict
 *     costs nothing but disk space
 *   - Report-only default for a destructive operation; apply is opt-in
 *   - Verify-after-apply: build/tests run once after deletions
 *
 * COST PROFILE
 *   3 finders + 1 skeptic per candidate + (if apply) 1 remover + 1 verifier.
 *   Typically 10-25 agents.
 *
 * OUTPUT
 *   { confirmedDead: [...], kept: [...], applied: boolean, verification? }
 */

export const meta = {
  name: 'dead-code-sweep',
  description: 'Find dead-code candidates via three search modalities, cross-check each with a default-to-keep skeptic, optionally remove and verify',
  whenToUse: 'Codebase hygiene: finding provably-unused exports, files, and dependencies without breaking dynamic or reflective consumers',
  phases: [
    { title: 'Sweep', detail: 'three modality finders in parallel' },
    { title: 'Cross-check', detail: 'default-to-keep skeptic per candidate' },
    { title: 'Remove', detail: 'delete confirmed-dead code (opt-in) and verify' },
  ],
}

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['identifier', 'file', 'kind', 'evidence'],
        properties: {
          identifier: { type: 'string', description: 'function/class/file/dependency name' },
          file: { type: 'string' },
          kind: { enum: ['function', 'class', 'file', 'dependency', 'branch', 'config'] },
          evidence: { type: 'string', description: 'why this looks dead' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['alive', 'reasoning'],
  properties: {
    alive: { type: 'boolean', description: 'true if ANY plausible living reference exists' },
    reasoning: { type: 'string' },
    referenceFound: { type: 'string', description: 'where the living reference is, if alive' },
  },
}

const scope = (args && args.scope) || 'the entire repository'
const apply = Boolean(args && args.apply)
const maxCandidates = (args && args.maxCandidates) || 20

// --------------------------------------------------------------------------
// Phase 1: Multi-modal sweep. Three finders, three different definitions of
// "looks dead". The barrier is justified: cross-modality dedupe must happen
// before the per-candidate skeptics spend tokens.
// --------------------------------------------------------------------------

phase('Sweep')

const MODALITIES = [
  {
    key: 'exports',
    prompt: `Find exported-but-never-imported code in ${scope}: exports no other file imports, public functions/classes with zero call sites, package.json dependencies no file requires. Use grep/AST-level searching. Skip anything under 10 lines — not worth the sweep.`,
  },
  {
    key: 'reachability',
    prompt: `Find unreachable code in ${scope} by tracing from entry points (main/index files, route tables, CLI commands, scheduled jobs, exported package surface). Report files and large branches nothing reachable ever calls. Note feature flags that are permanently off.`,
  },
  {
    key: 'staleness',
    prompt: `Find stale artifacts in ${scope}: files untouched by git for a long time whose imports have all migrated elsewhere, "-old"/"-v1"/"backup"/"deprecated"-suffixed files, commented-out code blocks over 20 lines, config keys nothing reads.`,
  },
]

const sweeps = await parallel(MODALITIES.map(m => () =>
  agent(m.prompt, { label: `sweep:${m.key}`, schema: CANDIDATES_SCHEMA }),
))

const byKey = new Map()
for (const s of sweeps.filter(Boolean)) {
  for (const c of s.candidates) {
    const key = `${c.file}::${c.identifier}`
    // A candidate found by two modalities is a stronger candidate — track it.
    const prev = byKey.get(key)
    byKey.set(key, prev ? { ...prev, corroborated: true } : c)
  }
}
let candidates = [...byKey.values()]
log(`${candidates.length} unique candidates from ${sweeps.filter(Boolean).length} modalities`)

if (candidates.length > maxCandidates) {
  // Corroborated candidates win slots. Never truncate silently.
  candidates = [...candidates.filter(c => c.corroborated), ...candidates.filter(c => !c.corroborated)].slice(0, maxCandidates)
  log(`Cap: cross-checking top ${maxCandidates} of ${byKey.size} candidates (corroborated first). Re-run with a narrower scope for the rest.`)
}

if (candidates.length === 0) {
  return { confirmedDead: [], kept: [], applied: false }
}

// --------------------------------------------------------------------------
// Phase 2: Cross-check. The skeptic hunts for LIFE, not death — dynamic
// imports, string-built references, reflection, DI containers, external
// consumers, tests that pin behavior. The asymmetry is deliberate: this is
// the workflow's safety property, stated in the prompt and enforced by the
// default-to-alive instruction.
// --------------------------------------------------------------------------

phase('Cross-check')

const checked = await parallel(candidates.map(c => () =>
  agent(
    `A sweep flagged this as dead code. Try to prove it is ALIVE.
     Candidate: ${c.kind} "${c.identifier}" in ${c.file}
     Sweep's evidence: ${c.evidence}

     Hunt for living references the sweep would miss: dynamic import()/require
     with computed paths, string-keyed registries and route tables, reflection,
     dependency-injection wiring, template references, build/config consumption
     (webpack entries, CLI manifests), external consumers if this package is
     published, and tests that exercise it indirectly.
     If you find ANY plausible living reference — or if this is a published
     package's public API — verdict alive=true. When uncertain, alive=true.
     Deleting live code breaks production; keeping dead code costs nothing.`,
    { label: `check:${c.identifier.slice(0, 30)}`, effort: 'high', schema: VERDICT_SCHEMA },
  ).then(v => ({ ...c, verdict: v })),
))

const confirmedDead = checked.filter(Boolean).filter(c => c.verdict && !c.verdict.alive)
const kept = checked.filter(Boolean).filter(c => !c.verdict || c.verdict.alive)
log(`${confirmedDead.length} confirmed dead, ${kept.length} kept (living reference found or uncertain)`)

// --------------------------------------------------------------------------
// Phase 3: Remove — only when apply:true, and one agent does ALL deletions.
// Sequential-by-one-agent is deliberate for destructive edits: a single
// remover sees interactions between deletions (removing A orphans B's import)
// that parallel removers would each miss.
// --------------------------------------------------------------------------

if (!apply || confirmedDead.length === 0) {
  return { confirmedDead, kept: kept.map(k => ({ identifier: k.identifier, file: k.file, why: k.verdict ? k.verdict.referenceFound || k.verdict.reasoning : 'check failed — kept by default' })), applied: false }
}

phase('Remove')

await agent(
  `Delete this confirmed-dead code. Work through the list in order; after each
   deletion, clean up newly-orphaned imports/exports it leaves behind.
   ${JSON.stringify(confirmedDead.map(c => ({ kind: c.kind, identifier: c.identifier, file: c.file })), null, 2)}
   Do not delete anything not on this list. Do not run the full test suite.`,
  { label: 'remove' },
)

const verification = await agent(
  `Dead code was just deleted. Run the repository's build/typecheck and test
   suite (find the commands). Report pass/fail and any failure that implicates a
   deletion. Do NOT fix failures by re-adding code — report them.`,
  { label: 'verify', phase: 'Remove' },
)

return { confirmedDead, kept: kept.map(k => ({ identifier: k.identifier, file: k.file })), applied: true, verification }

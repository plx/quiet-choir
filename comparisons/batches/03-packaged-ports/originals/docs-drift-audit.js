/**
 * docs-drift-audit — extract checkable claims from docs, verify against code
 * ==========================================================================
 *
 * USE CASE
 *   Documentation rots one claim at a time: a renamed flag, a moved file, a
 *   default that changed, an example that no longer compiles. Nobody re-reads
 *   the whole doc set against the whole codebase — but a fleet can. This
 *   workflow inventories the docs, decomposes each into CHECKABLE claims
 *   ("the CLI accepts --force", "config lives in settings.json", "this
 *   example runs"), verifies each doc's claims against the actual code, and
 *   either reports the drift or patches it in place.
 *
 * WHEN TO USE
 *   - Before a release: does the README still tell the truth?
 *   - After a big refactor or rename sweep
 *   - Periodic hygiene on any docs-carrying repo
 *
 * ARGS
 *   { paths?: string, fix?: boolean, maxDocs?: number }
 *   - paths: where docs live (default: READMEs + docs/ + *.md repo-wide)
 *   - fix: patch drifted docs in place (default false = report only)
 *   - maxDocs: audit cap (default 10; excess logged, prioritized by audience)
 *
 * PATTERNS DEMONSTRATED
 *   - Claim decomposition: "audit this doc" becomes N binary-checkable facts —
 *     the difference between vibes and verification
 *   - Full pipeline, no barriers: each doc flows extract -> check -> fix
 *     independently; doc A is being fixed while doc B is still extracting
 *   - Batched verification: one checker per DOC (not per claim) — claims from
 *     one doc share context, so batching them is cheaper AND more accurate
 *   - Per-item phase labels via opts.phase inside pipeline stages
 *
 * COST PROFILE
 *   1 inventory + 2-3 agents per doc (extract, check, optionally fix).
 *   10 docs ≈ 21-31 agents; tune with maxDocs.
 *
 * OUTPUT
 *   { docs: [{doc, claims, drifted, fixed}], totals, skipped }
 */

export const meta = {
  name: 'docs-drift-audit',
  description: 'Decompose every doc into checkable claims, verify each against the code, and report or fix the drift',
  whenToUse: 'Pre-release doc truthfulness check, or after refactors that likely invalidated READMEs and guides',
  phases: [
    { title: 'Inventory', detail: 'find and prioritize doc files' },
    { title: 'Extract', detail: 'decompose docs into checkable claims' },
    { title: 'Check', detail: 'verify claims against the actual code' },
    { title: 'Fix', detail: 'patch drifted docs in place (opt-in)' },
  ],
}

const INVENTORY_SCHEMA = {
  type: 'object',
  required: ['docs'],
  properties: {
    docs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'audience', 'priority'],
        properties: {
          path: { type: 'string' },
          audience: { type: 'string', description: 'who reads this: end users, contributors, operators...' },
          priority: { enum: ['high', 'medium', 'low'], description: 'high = wrong claims here actively hurt people' },
        },
      },
    },
  },
}

const CLAIMS_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'kind', 'checkHint'],
        properties: {
          claim: { type: 'string', description: 'one atomic, checkable assertion the doc makes' },
          kind: { enum: ['command', 'path', 'api', 'config', 'behavior', 'example', 'version'] },
          checkHint: { type: 'string', description: 'how a checker would verify this against the repo' },
          quote: { type: 'string', description: 'the doc text making this claim' },
        },
      },
    },
  },
}

const CHECKED_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'status', 'reality'],
        properties: {
          claim: { type: 'string' },
          status: { enum: ['true', 'drifted', 'unverifiable'] },
          reality: { type: 'string', description: 'what the code actually does/has, with file evidence' },
          suggestedText: { type: 'string', description: 'replacement doc text if drifted' },
        },
      },
    },
  },
}

const fix = Boolean(args && args.fix)
const maxDocs = (args && args.maxDocs) || 10

// --------------------------------------------------------------------------
// Phase 1: Inventory — cheap, structural.
// --------------------------------------------------------------------------

phase('Inventory')

const inventory = await agent(
  `Inventory the documentation in ${(args && args.paths) || 'this repository: README files, docs/, *.md anywhere, plus doc-comments-as-docs like a CLI --help template if present'}.
   For each doc file: its audience and a priority (high = wrong claims actively
   hurt readers, e.g. install instructions; low = design notes). Skip generated
   files and changelogs — history doesn't drift.`,
  { label: 'inventory', effort: 'low', schema: INVENTORY_SCHEMA },
)

if (!inventory || inventory.docs.length === 0) {
  return { docs: [], totals: { docs: 0, claims: 0, drifted: 0, fixed: 0 }, skipped: [] }
}

const PRI = { high: 0, medium: 1, low: 2 }
const ordered = [...inventory.docs].sort((a, b) => PRI[a.priority] - PRI[b.priority])
const chosen = ordered.slice(0, maxDocs)
const skipped = ordered.slice(maxDocs).map(d => d.path)
if (skipped.length) log(`Cap: auditing ${chosen.length} docs, skipping ${skipped.length} lower-priority (${skipped.join(', ')})`)

// --------------------------------------------------------------------------
// Phases 2-4 as ONE pipeline: extract -> check -> fix per doc, no barriers.
// Nothing downstream needs cross-doc context, so this is the pure pipeline
// case — the README can be getting fixed while docs/deploy.md is still in
// extraction. Wall-clock = slowest single doc, not sum of slowest stages.
// --------------------------------------------------------------------------

const results = await pipeline(
  chosen,

  // Stage 1: Extract claims. effort:low — decomposition is mechanical reading.
  (doc) => agent(
    `Read ${doc.path} (audience: ${doc.audience}) and decompose it into atomic,
     CHECKABLE claims about this repository. A claim is checkable if a person
     with the repo could verify it true/false: commands and flags that should
     exist, file paths, API names and signatures, config keys and defaults,
     described behaviors, code examples that should run, version statements.
     Skip pure opinion and marketing ("blazing fast"). Include the doc text
     (quote) for each claim and a checkHint for the verifier.`,
    { label: `extract:${doc.path.split('/').pop()}`, phase: 'Extract', effort: 'low', schema: CLAIMS_SCHEMA },
  ),

  // Stage 2: Check ALL of this doc's claims in one agent. One-agent-per-claim
  // would explode cost for no accuracy gain — claims from the same doc are
  // verified against the same neighborhoods of code.
  (extracted, doc) => {
    if (!extracted || extracted.claims.length === 0) return { doc: doc.path, results: [] }
    return agent(
      `Verify these documentation claims against the ACTUAL code of this repo.
       Doc: ${doc.path}
       Claims: ${JSON.stringify(extracted.claims, null, 2)}
       For each: status "true" (code agrees), "drifted" (code disagrees — say what
       the reality is, with file evidence, and draft replacement doc text), or
       "unverifiable" (requires running external systems). Actually check —
       run --help for command claims, read the config parser for config claims,
       compile/run examples where cheap.`,
      { label: `check:${doc.path.split('/').pop()}`, phase: 'Check', schema: CHECKED_SCHEMA },
    ).then(checked => ({ doc: doc.path, results: checked ? checked.results : [] }))
  },

  // Stage 3: Fix (opt-in). Only runs for docs with drift; patches in place
  // using the checker's suggested text plus the checker's evidence.
  (checked, doc) => {
    const drifted = (checked.results || []).filter(r => r.status === 'drifted')
    if (!fix || drifted.length === 0) return { ...checked, fixed: 0 }
    return agent(
      `Update ${doc.path} to match reality. Drifted claims with verified reality
       and suggested replacement text: ${JSON.stringify(drifted, null, 2)}
       Edit the file in place. Keep the doc's voice and structure; change only
       what's wrong. Do not add new sections. Return a one-line summary per edit.`,
      { label: `fix:${doc.path.split('/').pop()}`, phase: 'Fix', effort: 'low' },
    ).then(() => ({ ...checked, fixed: drifted.length }))
  },
)

const docs = results.filter(Boolean).map(r => ({
  doc: r.doc,
  claims: (r.results || []).length,
  drifted: (r.results || []).filter(x => x.status === 'drifted').map(x => ({ claim: x.claim, reality: x.reality })),
  fixed: r.fixed || 0,
}))

const totals = {
  docs: docs.length,
  claims: docs.reduce((n, d) => n + d.claims, 0),
  drifted: docs.reduce((n, d) => n + d.drifted.length, 0),
  fixed: docs.reduce((n, d) => n + d.fixed, 0),
}
log(`${totals.claims} claims checked across ${totals.docs} docs: ${totals.drifted} drifted${fix ? `, ${totals.fixed} fixed` : ' (report-only mode)'}`)

return { docs, totals, skipped }

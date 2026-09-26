/**
 * release-notes — commit archaeology, audience-aware drafting, per-claim fact-check
 * =================================================================================
 *
 * USE CASE
 *   Release notes fail two ways: they're a raw commit dump nobody reads, or
 *   they're marketing prose that drifted from what actually shipped. This
 *   workflow shards the commit range across parallel summarizers that read
 *   DIFFS (not messages — messages lie), drafts notes for a specific
 *   audience, then fact-checks the draft line by line against the range:
 *   every claim must trace to a commit, every breaking change in the range
 *   must appear in the notes. Both directions, because notes can lie by
 *   omission too.
 *
 * WHEN TO USE
 *   - Cutting a versioned release of anything with users
 *   - Monthly "what shipped" posts for stakeholders
 *   - Backfilling a CHANGELOG from a range nobody documented
 *
 * ARGS  (required: since)
 *   { since: string, until?: string, audience?: string, out?: string }
 *   - since/until: git range bounds (until defaults to HEAD)
 *   - audience: who reads these (default "developers using this project as
 *     a dependency") — changes tone, selection, and what counts as relevant
 *   - out: write the notes here (e.g. "CHANGELOG.md" prepends conventionally)
 *
 * PATTERNS DEMONSTRATED
 *   - Shard-by-range over a manifest: commit list split in code, each
 *     summarizer reads its slice's DIFFS, coverage is arithmetic
 *   - Read-the-diff-not-the-message: summarizers verify what a commit DID
 *   - Bidirectional fact-check: claims->commits (no invention) AND
 *     commits->claims (no omission of breaking changes)
 *   - Single bounded repair round on fact-check failures
 *
 * COST PROFILE
 *   1 collector + ~1 summarizer per 25 commits + 1 drafter + 1 fact-checker
 *   (+1 repair). A 100-commit release ≈ 8 agents.
 *
 * OUTPUT
 *   { notes, factCheck, coverage, breaking }
 */

export const meta = {
  name: 'release-notes',
  description: 'Shard a commit range across diff-reading summarizers, draft audience-aware notes, and bidirectionally fact-check claims against commits',
  whenToUse: 'Cutting a release or backfilling a changelog — when the notes must be both readable and provably true to the range',
  phases: [
    { title: 'Collect', detail: 'resolve the range into a commit manifest' },
    { title: 'Summarize', detail: 'parallel diff-readers over commit slices' },
    { title: 'Draft', detail: 'audience-aware notes from the summaries' },
    { title: 'Fact-check', detail: 'claims<->commits in both directions' },
  ],
}

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['commitCount', 'range'],
  properties: {
    commitCount: { type: 'number' },
    range: { type: 'string', description: 'the exact resolved git range' },
    firstShas: { type: 'array', items: { type: 'string' }, description: 'oldest-first list of all shas (short) in the range' },
    versionHint: { type: 'string', description: 'current version from tags/manifest, if determinable' },
  },
}

const CHANGES_SCHEMA = {
  type: 'object',
  required: ['changes', 'commitsRead'],
  properties: {
    commitsRead: { type: 'number' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'description', 'shas', 'userVisible'],
        properties: {
          kind: { enum: ['feature', 'fix', 'breaking', 'performance', 'deprecation', 'internal'] },
          description: { type: 'string', description: 'what changed, from reading the DIFF' },
          shas: { type: 'array', items: { type: 'string' } },
          userVisible: { type: 'boolean' },
          migrationNote: { type: 'string', description: 'for breaking/deprecation: what a user must do' },
        },
      },
    },
  },
}

const FACTCHECK_SCHEMA = {
  type: 'object',
  required: ['passed', 'problems'],
  properties: {
    passed: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['direction', 'detail'],
        properties: {
          direction: { enum: ['unsupported-claim', 'omitted-change', 'wrong-emphasis'] },
          detail: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

if (!args || !args.since) {
  return { error: 'release-notes requires args: { since } — a tag, sha, or ref. Optional: { until, audience, out }' }
}
const until = (args && args.until) || 'HEAD'
const audience = (args && args.audience) || 'developers using this project as a dependency'

// --------------------------------------------------------------------------
// Phase 1: Collect — resolve the range once, get the sha manifest. Slicing
// happens in code so shards are provably disjoint and complete.
// --------------------------------------------------------------------------

phase('Collect')

const manifest = await agent(
  `Resolve the git range ${args.since}..${until} in this repository.
   Report: the exact range, total commit count, ALL short shas oldest-first
   (merge commits excluded if the repo squash-merges; included otherwise —
   match how this repo actually integrates changes), and the current version
   from tags or the package manifest if determinable. Do not summarize commits.`,
  { label: 'collect', effort: 'low', schema: MANIFEST_SCHEMA },
)

if (!manifest || !manifest.firstShas || manifest.firstShas.length === 0) {
  return { notes: null, factCheck: 'n/a', coverage: 'Empty range — nothing to release.', breaking: [] }
}
log(`${manifest.firstShas.length} commits in ${manifest.range}`)

// --------------------------------------------------------------------------
// Phase 2: Summarize — slice the manifest in code, one diff-reader per slice.
// The prompt's core rule: judge each commit by its DIFF; the message is a
// hint, not evidence. Barrier justified: the drafter needs all summaries.
// --------------------------------------------------------------------------

phase('Summarize')

const SLICE = 25
const slices = []
for (let i = 0; i < manifest.firstShas.length; i += SLICE) slices.push(manifest.firstShas.slice(i, i + SLICE))

const summaries = (await parallel(slices.map((shas, i) => () =>
  agent(
    `Summarize these ${shas.length} commits for release notes. Shas (oldest first):
     ${shas.join(' ')}
     For each commit read the DIFF (git show), not just the message — messages
     lie, drift, and say "fix typo" on 400-line changes. Group related commits
     into single changes (a feature + its 3 fixups = one change carrying all
     shas). Classify each change; mark userVisible honestly — internal refactors
     are not release-notes material for most audiences. For breaking changes and
     deprecations, write the migration note from the diff. Report commitsRead.`,
    { label: `summarize:${i + 1}/${slices.length}`, effort: 'low', schema: CHANGES_SCHEMA },
  ),
))).filter(Boolean)

const changes = summaries.flatMap(s => s.changes)
const commitsRead = summaries.reduce((n, s) => n + s.commitsRead, 0)
const breaking = changes.filter(c => c.kind === 'breaking' || c.kind === 'deprecation')
const coverage = `${commitsRead}/${manifest.firstShas.length} commits read`
log(`${changes.length} changes (${breaking.length} breaking/deprecation); coverage ${coverage}`)

// --------------------------------------------------------------------------
// Phase 3: Draft.
// --------------------------------------------------------------------------

phase('Draft')

let notes = await agent(
  `Draft release notes for the audience: ${audience}.
   Version context: ${manifest.versionHint || 'unknown — omit the version header'}
   Range: ${manifest.range}
   Changes: ${JSON.stringify(changes, null, 2)}
   Rules: breaking changes first with migration notes, then highlights (the 3-5
   changes this audience most cares about, one short paragraph each), then
   categorized lists (Features / Fixes / Performance / Deprecations). Skip
   non-userVisible changes unless the audience is "contributors". Every line
   must trace to the provided changes — add nothing, embellish nothing. Include
   sha references in parentheses. Return only markdown.`,
  { label: 'draft' },
)

// --------------------------------------------------------------------------
// Phase 4: Fact-check, both directions, against the RANGE — not against the
// summaries (the summarizers could have erred too). One repair round.
// --------------------------------------------------------------------------

phase('Fact-check')

const check = await agent(
  `Fact-check these release notes against the actual git range ${manifest.range}.
   NOTES:\n---\n${notes}\n---
   Direction 1 — every claim in the notes must be supported by a commit in the
   range: spot-check each claim's cited shas (git show), flag unsupported or
   exaggerated claims ("rewrote" for a rename, "fixed" for a partial fix).
   Direction 2 — every breaking change in the RANGE must appear in the notes:
   scan the range's diffs for removed/renamed public API, changed defaults,
   schema migrations; flag omissions. Also flag wrong-emphasis (a data-loss fix
   buried under a color tweak).`,
  { label: 'fact-check', effort: 'high', schema: FACTCHECK_SCHEMA },
)

if (check && !check.passed && check.problems.length > 0) {
  log(`Fact-check found ${check.problems.length} problems — one repair round`)
  notes = await agent(
    `Repair these release notes. Problems from fact-check: ${JSON.stringify(check.problems, null, 2)}
     NOTES:\n---\n${notes}\n---
     Apply each problem's fix, verifying against the repo (git show) where the
     fix involves a factual claim. Change nothing else. Return only the markdown.`,
    { label: 'repair', phase: 'Fact-check' },
  )
}

if (args && args.out) {
  await agent(
    `Add these release notes to ${args.out}. If the file exists and is a
     changelog, prepend the new entry after any title heading, preserving the
     existing format conventions; otherwise create it. Notes:\n${notes}
     Return the path written.`,
    { label: 'write', phase: 'Fact-check', effort: 'low' },
  )
}

return {
  notes,
  factCheck: check ? (check.passed ? 'passed' : `${check.problems.length} problems found and repaired`) : 'fact-checker unavailable',
  coverage,
  breaking: breaking.map(b => ({ description: b.description, migrationNote: b.migrationNote })),
}

/**
 * codebase-atlas — parallel deep-readers build an onboarding map of a repo
 * ========================================================================
 *
 * USE CASE
 *   Understanding a codebase is embarrassingly parallel — the auth subsystem
 *   and the billing subsystem can be read simultaneously — but a single
 *   context can't hold a large repo. This workflow surveys the repo into
 *   subsystems, deep-reads each one concurrently into a structured "card",
 *   synthesizes the cards into an onboarding atlas, and then runs a
 *   completeness critic whose complaints trigger one repair round.
 *
 * WHEN TO USE
 *   - Joining a project: produce the doc the team never wrote
 *   - Before a big refactor: know the terrain before you move it
 *   - Onboarding material that stays cheap to regenerate as code evolves
 *
 * ARGS
 *   { out?: string, maxSubsystems?: number }
 *   - out: path for the generated atlas (default "docs/atlas.md")
 *   - maxSubsystems: deep-read cap (default 8; excess logged, never silent)
 *
 * PATTERNS DEMONSTRATED
 *   - Survey-then-fan-out: a cheap structuring pass creates the work list
 *   - Justified barrier: synthesis genuinely needs every card at once
 *   - Completeness critic + single repair round: the critic's complaints
 *     become concrete work items, not just a score
 *   - No silent caps: dropped subsystems are logged and listed in the result
 *
 * COST PROFILE
 *   1 survey + ≤8 readers + 1 synthesis + 1 critic + ≤3 repair readers.
 *   Typically 8-14 agents.
 *
 * OUTPUT
 *   { atlasPath, subsystems: [...], skipped: [...], critique }
 */

export const meta = {
  name: 'codebase-atlas',
  description: 'Survey a repo into subsystems, deep-read each in parallel, and synthesize an onboarding atlas with a completeness-critic repair round',
  whenToUse: 'Onboarding to an unfamiliar codebase, or generating the architecture doc a project never had',
  phases: [
    { title: 'Survey', detail: 'partition the repo into subsystems' },
    { title: 'Deep-read', detail: 'one reader per subsystem' },
    { title: 'Synthesize', detail: 'merge cards into the atlas document' },
    { title: 'Critique', detail: 'completeness check + one repair round' },
  ],
}

const SURVEY_SCHEMA = {
  type: 'object',
  required: ['projectSummary', 'subsystems'],
  properties: {
    projectSummary: { type: 'string', description: '3-5 sentences: what this software is and does' },
    subsystems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'paths', 'importance'],
        properties: {
          name: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          importance: { enum: ['core', 'supporting', 'peripheral'] },
          hint: { type: 'string', description: 'one line on what this subsystem seems to do' },
        },
      },
    },
  },
}

const CARD_SCHEMA = {
  type: 'object',
  required: ['name', 'purpose', 'keyFiles', 'entryPoints', 'dependsOn', 'gotchas'],
  properties: {
    name: { type: 'string' },
    purpose: { type: 'string', description: '2-4 sentences, written for a new team member' },
    keyFiles: { type: 'array', items: { type: 'object', required: ['path', 'role'], properties: { path: { type: 'string' }, role: { type: 'string' } } } },
    entryPoints: { type: 'array', items: { type: 'string' }, description: 'where execution enters this subsystem' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'other subsystems or external services it needs' },
    dataFlows: { type: 'string', description: 'how data moves through it, one short paragraph' },
    gotchas: { type: 'array', items: { type: 'string' }, description: 'surprises: non-obvious invariants, footguns, historical scars' },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['complete', 'gaps'],
  properties: {
    complete: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'repairAction'],
        properties: {
          description: { type: 'string' },
          repairAction: { type: 'string', description: 'a concrete instruction a reader agent could execute' },
        },
      },
    },
    verdict: { type: 'string' },
  },
}

// --------------------------------------------------------------------------
// Phase 1: Survey — cheap, structural. Its output IS the fan-out work list.
// --------------------------------------------------------------------------

phase('Survey')

const outPath = (args && args.out) || 'docs/atlas.md'
const maxSubsystems = (args && args.maxSubsystems) || 8

const survey = await agent(
  `Survey this repository and partition it into subsystems for a team of readers.
   Look at directory structure, build config, and entry points — skim, don't
   deep-read. A subsystem is a coherent unit someone could study alone (an API
   layer, a persistence layer, a worker fleet, a CLI, a frontend app...). Rank
   each core/supporting/peripheral. Prefer 4-8 subsystems; merge tiny ones.`,
  { label: 'survey', effort: 'low', schema: SURVEY_SCHEMA },
)

if (!survey || survey.subsystems.length === 0) {
  return { atlasPath: null, subsystems: [], skipped: [], critique: 'Survey found no subsystems — is this a code repository?' }
}

// Cap the fan-out, loudly. Core subsystems win slots first.
const RANK = { core: 0, supporting: 1, peripheral: 2 }
const ordered = [...survey.subsystems].sort((a, b) => RANK[a.importance] - RANK[b.importance])
const chosen = ordered.slice(0, maxSubsystems)
const skipped = ordered.slice(maxSubsystems)
if (skipped.length > 0) log(`Cap: deep-reading ${chosen.length} subsystems, skipping ${skipped.map(s => s.name).join(', ')}`)
log(`Survey: ${survey.projectSummary}`)

// --------------------------------------------------------------------------
// Phase 2: Deep-read — the parallel heart. Readers are independent by
// construction (the survey partitioned the repo), so no coordination needed.
// This barrier is justified: synthesis needs every card to draw the
// cross-subsystem dependency picture.
// --------------------------------------------------------------------------

phase('Deep-read')

const cards = (await parallel(chosen.map(sub => () =>
  agent(
    `Deep-read the "${sub.name}" subsystem of this repository.
     Its paths: ${sub.paths.join(', ')}. Hint: ${sub.hint || 'none'}.
     Project context: ${survey.projectSummary}

     Read the actual code — not just filenames. Produce a card for a new team
     member: purpose, key files with each file's role, entry points, what it
     depends on, how data flows through it, and gotchas (non-obvious invariants,
     footguns, things that would surprise someone editing this next week).
     Gotchas are the most valuable field — dig for them.`,
    { label: `read:${sub.name}`, schema: CARD_SCHEMA },
  ),
))).filter(Boolean)

log(`${cards.length}/${chosen.length} subsystem cards complete`)

// --------------------------------------------------------------------------
// Phase 3: Synthesize — one writer, all cards. It also writes the file so the
// atlas lands on disk even if the session moves on.
// --------------------------------------------------------------------------

phase('Synthesize')

await agent(
  `Write an onboarding atlas for this repository to the file ${outPath}
   (create parent directories if needed).

   Project summary: ${survey.projectSummary}
   Subsystem cards: ${JSON.stringify(cards, null, 2)}

   Structure: (1) What this is — the project summary, sharpened; (2) System map —
   a mermaid diagram of subsystems and their dependsOn edges; (3) one section per
   subsystem from its card, gotchas rendered prominently; (4) "Start here" — the
   3 files a new engineer should read first, with one line each on why.
   Write the file, then return just the absolute path you wrote.`,
  { label: 'write-atlas', effort: 'low' },
)

// --------------------------------------------------------------------------
// Phase 4: Critique + one repair round. The critic compares the atlas against
// the repo with fresh eyes. Its gaps are executable repair actions; we run up
// to 3 of them and ask the synthesizer to weave the results in. One round only
// — critics can always find more, and the second round's yield rarely pays.
// --------------------------------------------------------------------------

phase('Critique')

const critique = await agent(
  `Read ${outPath} and audit it for completeness against the actual repository.
   What would a new engineer still be missing? Check: subsystems present in the
   code but absent from the atlas, dependency edges that are wrong, entry points
   that don't match reality, and load-bearing config/infrastructure the atlas
   ignores. For each gap give a repairAction a reader agent could execute.
   Skipped-by-budget subsystems (expected, still worth listing): ${skipped.map(s => s.name).join(', ') || 'none'}.`,
  { label: 'critic', effort: 'high', schema: CRITIQUE_SCHEMA },
)

if (critique && !critique.complete && critique.gaps.length > 0) {
  const repairs = critique.gaps.slice(0, 3)
  if (critique.gaps.length > 3) log(`Repairing top 3 of ${critique.gaps.length} gaps`)
  const patches = (await parallel(repairs.map((gap, i) => () =>
    agent(
      `Repair task for the atlas at ${outPath}: ${gap.repairAction}
       Context — the gap: ${gap.description}
       Research the answer in the repository and return the corrected/additional
       markdown content (not a diff), ready to merge into the atlas.`,
      { label: `repair:${i}`, phase: 'Critique' },
    ),
  ))).filter(Boolean)

  await agent(
    `Merge these repair patches into the atlas at ${outPath}, keeping its structure
     and voice. Patches: ${JSON.stringify(patches)}. Rewrite the file in place and
     return the path.`,
    { label: 'merge-repairs', effort: 'low', phase: 'Critique' },
  )
}

return {
  atlasPath: outPath,
  subsystems: cards.map(c => ({ name: c.name, purpose: c.purpose })),
  skipped: skipped.map(s => s.name),
  critique: critique ? (critique.verdict || (critique.complete ? 'complete' : `${critique.gaps.length} gaps found, top 3 repaired`)) : 'critic unavailable',
}

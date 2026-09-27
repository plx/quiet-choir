/**
 * research-synthesis — multi-modal sweep, deep reads, cited synthesis, gap-driven round two
 * =========================================================================================
 *
 * USE CASE
 *   Real research questions ("should we adopt X?", "how do teams solve Y at
 *   scale?", "what's the state of the art in Z?") die from single-modality
 *   search: web search finds what's SEO-visible, code search finds what's
 *   local, registry/issue-tracker search finds what's maintained — each
 *   modality is blind to the others' territory. This workflow sweeps all
 *   modalities in parallel for LEADS (cheap), deep-reads only the leads that
 *   survive deduplication and ranking (expensive), synthesizes with per-claim
 *   citations, and lets a completeness critic trigger exactly one more
 *   targeted sweep for whatever the first round missed.
 *
 * WHEN TO USE
 *   - Technology adoption decisions needing evidence, not vibes
 *   - "What is the current state of X" surveys with citations
 *   - Due diligence on a library/tool/approach before betting on it
 *
 * ARGS  (required: question)
 *   { question: string, context?: string, depth?: 'quick' | 'standard' | 'deep' }
 *   - question: the research question
 *   - context: local grounding ("we run Postgres 14 and Django")
 *   - depth: leads deep-read per round — quick=4, standard=8, deep=14
 *
 * PATTERNS DEMONSTRATED
 *   - Leads-then-reads: separating cheap discovery from expensive reading,
 *     with ranking (and credibility tiers) between them
 *   - Multi-modal sweep where each modality's charter names its blind spot
 *   - Per-claim citation discipline enforced by schema, not by exhortation
 *   - Completeness critic driving EXACTLY one supplementary round with
 *     targeted (not repeated) queries
 *   - Web tools loaded by subagents via ToolSearch — the orchestration
 *     script itself never fetches anything
 *
 * COST PROFILE
 *   4 sweepers + N readers + 1 synthesizer + 1 critic (+ up to 3 round-two
 *   readers + 1 re-synthesizer). standard depth ≈ 15 agents.
 *
 * OUTPUT
 *   { answer, sources, confidence, gaps }
 */

export const meta = {
  name: 'research-synthesis',
  description: 'Multi-modal lead sweep, ranked deep-reads with per-claim citations, synthesis, and one critic-driven supplementary round',
  whenToUse: 'Technology decisions, state-of-the-art surveys, and due diligence questions that deserve cited evidence over a single search pass',
  phases: [
    { title: 'Sweep', detail: 'four modalities hunt for leads' },
    { title: 'Deep-read', detail: 'ranked leads get full readings' },
    { title: 'Synthesize', detail: 'cited answer from the readings' },
    { title: 'Critique', detail: 'gap check + one targeted extra round' },
  ],
}

const LEADS_SCHEMA = {
  type: 'object',
  required: ['leads'],
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'kind', 'promise'],
        properties: {
          ref: { type: 'string', description: 'URL, package name, file path, or issue link — enough for a reader to find it' },
          kind: { enum: ['official-docs', 'source-code', 'issue-thread', 'benchmark', 'writeup', 'discussion', 'paper', 'local-code'] },
          promise: { type: 'string', description: 'what this lead likely contains that answers the question' },
          credibility: { enum: ['primary', 'secondary', 'anecdotal'] },
        },
      },
    },
  },
}

const READING_SCHEMA = {
  type: 'object',
  required: ['ref', 'findings', 'useful'],
  properties: {
    ref: { type: 'string' },
    useful: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'support'],
        properties: {
          claim: { type: 'string', description: 'one specific fact/result relevant to the question' },
          support: { type: 'string', description: 'where in the source this comes from — section, code location, data point' },
          caveat: { type: 'string', description: 'scope limits: version, scale, age of the info' },
        },
      },
    },
    contradicts: { type: 'string', description: 'anything here that contradicts common belief or other likely sources' },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['adequate', 'gaps'],
  properties: {
    adequate: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['gap', 'huntInstruction'],
        properties: {
          gap: { type: 'string', description: 'what the answer is missing or asserting without evidence' },
          huntInstruction: { type: 'string', description: 'a TARGETED search/read instruction — not "search more"' },
        },
      },
    },
  },
}

if (!args || !args.question) {
  return { error: 'research-synthesis requires args: { question }. Optional: { context, depth: quick|standard|deep }' }
}
const question = args.question
const context = (args && args.context) || null
const READS = { quick: 4, standard: 8, deep: 14 }[(args && args.depth) || 'standard'] || 8

// --------------------------------------------------------------------------
// Phase 1: Sweep — four modalities, each charter naming what the OTHERS miss.
// Sweepers return leads, not answers: discovery is cheap, reading is not,
// and the ranking between them is where the token budget gets protected.
// --------------------------------------------------------------------------

phase('Sweep')

const MODALITIES = [
  { key: 'web', charter: `Web search (load WebSearch/WebFetch via ToolSearch). Hunt official docs, engineering blog writeups, benchmarks, and papers. Your blind spot is recency-vs-SEO: a 2019 blog post outranks last month's changelog — check dates, prefer primary sources, and note versions.` },
  { key: 'source', charter: `Source code and releases. For any library/tool the question involves: its repo, changelog, release cadence, open-vs-closed issue ratio, test quality. Code doesn't lie about capabilities the way marketing pages do. Use web fetch (via ToolSearch) for remote repos.` },
  { key: 'practitioners', charter: `Practitioner discussions: issue threads, forum/HN/SO discussions, postmortems mentioning the topic. This is where "works great until 10k QPS" lives — the failure modes official docs omit. Mark everything here anecdotal unless corroborated.` },
  { key: 'local', charter: context ? `The local context: ${context}. Search the local repository/environment for current usage, constraints, and integration points that would make general advice inapplicable. This modality grounds the answer in OUR reality.` : `Skip — no local context provided. Return an empty leads list.` },
]

const sweeps = await parallel(MODALITIES.map(m => () =>
  agent(
    `Research question: ${question}
     ${context ? `Context: ${context}` : ''}
     Your modality: ${m.charter}
     Return LEADS ONLY — refs a deep-reader can follow, each with what it
     promises and a credibility tier. Do not read anything in depth; 8-12 good
     leads beat 30 mediocre ones.`,
    { label: `sweep:${m.key}`, effort: 'low', schema: LEADS_SCHEMA },
  ),
))

const seenRefs = new Set()
const leads = []
for (const s of sweeps.filter(Boolean)) {
  for (const l of s.leads) {
    const norm = l.ref.toLowerCase().replace(/\/+$/, '')
    if (!seenRefs.has(norm)) { seenRefs.add(norm); leads.push(l) }
  }
}
// Rank: primary sources first, then secondary; anecdotal reads last and only
// at deep depth. Mechanical rule, so it lives in code.
const CRED = { primary: 0, secondary: 1, anecdotal: 2 }
leads.sort((a, b) => CRED[a.credibility] - CRED[b.credibility])
const toRead = leads.slice(0, READS)
log(`${leads.length} unique leads; deep-reading top ${toRead.length} (${leads.length - toRead.length} deferred)`)

if (toRead.length === 0) {
  return { answer: 'No leads found — the question may need rephrasing or the modalities lack the required tools.', sources: [], confidence: 'none', gaps: [] }
}

// --------------------------------------------------------------------------
// Phase 2: Deep-read — one reader per lead. The schema forces claim+support
// pairs: a reading that returns prose without per-claim anchors is useless
// to a synthesizer that must cite.
// --------------------------------------------------------------------------

phase('Deep-read')

const readLead = (l) => agent(
  `Deep-read this source for the research question: ${question}
   Source: ${l.ref} (${l.kind}; expected: ${l.promise})
   Load web tools via ToolSearch if the ref is remote. Extract every finding
   relevant to the question as claim+support pairs — support says exactly where
   in the source the claim comes from. Note caveats (version, scale, age).
   Flag anything contradicting common belief. If the source turns out to be
   useless or inaccessible, say useful=false — do not pad.`,
  { label: `read:${l.ref.slice(0, 40)}`, phase: 'Deep-read', effort: 'low', schema: READING_SCHEMA },
)

const readings = (await parallel(toRead.map(l => () => readLead(l)))).filter(Boolean).filter(r => r.useful)
log(`${readings.length}/${toRead.length} sources yielded findings`)

// --------------------------------------------------------------------------
// Phase 3: Synthesize — every substantive claim in the answer must carry a
// [ref] citation drawn from the readings. Contradictions between sources are
// surfaced as contradictions, never silently averaged.
// --------------------------------------------------------------------------

phase('Synthesize')

const synthesize = (extraReadings) => agent(
  `Synthesize an evidence-based answer.
   Question: ${question}
   ${context ? `Context (the answer must fit this reality): ${context}` : ''}
   Readings: ${JSON.stringify([...readings, ...(extraReadings || [])], null, 2)}

   Rules: every substantive claim carries a citation [ref]. Where sources
   disagree, present the disagreement and which source is better-placed to be
   right (primary beats secondary beats anecdotal; recent beats stale for
   fast-moving topics) — do not average contradictions into mush. Distinguish
   "the evidence shows" from "the evidence suggests" from "no evidence found".
   Structure: direct answer first (one paragraph), then the evidence, then
   caveats and what we could not determine. Return markdown.`,
  { label: 'synthesize', effort: 'high', phase: 'Synthesize' },
)

let answer = await synthesize()

// --------------------------------------------------------------------------
// Phase 4: Critique -> ONE targeted supplementary round. The critic's gaps
// come with hunt instructions; up to 3 hunters run them, and the synthesizer
// revises once. One round is a design choice: critics always find more, and
// the second round's marginal yield rarely justifies a third.
// --------------------------------------------------------------------------

phase('Critique')

const critique = await agent(
  `Critique this research answer for completeness and evidential honesty.
   Question: ${question}
   Answer:\n---\n${answer}\n---
   Sources consulted: ${readings.map(r => r.ref).join(', ')}
   Hunt for: claims with no citation, obvious source types never consulted
   (e.g. the official changelog for a version-sensitive claim), the question's
   sub-parts left unanswered, and one-source claims that need corroboration.
   For each gap write a TARGETED huntInstruction — a specific search or a
   specific document to read, not "do more research".`,
  { label: 'critic', effort: 'high', schema: CRITIQUE_SCHEMA },
)

let gaps = []
if (critique && !critique.adequate && critique.gaps.length > 0) {
  gaps = critique.gaps.map(g => g.gap)
  const hunts = critique.gaps.slice(0, 3)
  if (critique.gaps.length > 3) log(`Hunting top 3 of ${critique.gaps.length} gaps`)
  const extra = (await parallel(hunts.map((g, i) => () =>
    agent(
      `Targeted research hunt for a gap in an answer to: ${question}
       Gap: ${g.gap}
       Instruction: ${g.huntInstruction}
       Load web tools via ToolSearch if needed. Return claim+support findings
       for exactly this gap; useful=false if the hunt comes up genuinely empty.`,
      { label: `hunt:${i + 1}`, phase: 'Critique', schema: READING_SCHEMA },
    ),
  ))).filter(Boolean).filter(r => r.useful)

  if (extra.length > 0) {
    answer = await synthesize(extra)
    readings.push(...extra)
  }
}

const primaryCount = toRead.filter(l => l.credibility === 'primary').length
return {
  answer,
  sources: readings.map(r => r.ref),
  confidence: primaryCount >= 3 && (!critique || critique.adequate || gaps.length <= 1) ? 'high'
    : readings.length >= 4 ? 'moderate' : 'low',
  gaps,
}

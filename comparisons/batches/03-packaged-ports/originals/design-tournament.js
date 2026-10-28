/**
 * design-tournament — forced-diverse proposals, a judge panel, and a synthesis
 * ============================================================================
 *
 * USE CASE
 *   One designer iterating on one idea explores a needle of the solution
 *   space; asking the same agent for "three options" produces one idea
 *   wearing three hats. This workflow forces genuine diversity by giving
 *   each proposer a different DESIGN PHILOSOPHY as its identity, has an
 *   independent judge panel score every proposal against an explicit rubric
 *   (judges never see each other's scores), and synthesizes the winner while
 *   explicitly grafting the best ideas from the losers — the runner-up
 *   usually got something important more right than the winner did.
 *
 * WHEN TO USE
 *   - Architecture decisions with a wide option space (storage model, API
 *     shape, sync strategy, plugin system)
 *   - Product/feature design before committing a sprint to one direction
 *   - Any "we keep going back and forth on this" decision — externalize it
 *
 * ARGS  (required: brief)
 *   { brief: string, context?: string, judges?: number, out?: string }
 *   - brief: the design problem, constraints, and success criteria
 *   - context: repo paths or background the proposers should study first
 *   - judges: panel size (default 3)
 *   - out: write the final design doc here (default: return only)
 *
 * PATTERNS DEMONSTRATED
 *   - Judge panel (generate N ways -> score -> synthesize), the pattern for
 *     wide solution spaces where one-attempt-iterated gets stuck in a basin
 *   - Forced diversity via assigned philosophies, not "be creative" prompts
 *   - Independent judging: each judge scores ALL proposals but sees no other
 *     judge — agreement then carries signal
 *   - Anonymized proposals (A/B/C/D) so judges can't favor a philosophy by
 *     its label
 *   - Synthesis-with-grafts: the loser's best idea survives the tournament
 *
 * COST PROFILE
 *   4 proposers + `judges` judges + 1 synthesizer ≈ 8 agents. Cheap for what
 *   it buys; the value is in the diversity, not the count.
 *
 * OUTPUT
 *   { winner, scoreboard, design, grafts, dissent }
 */

export const meta = {
  name: 'design-tournament',
  description: 'Four proposers with forced-diverse design philosophies, an independent judge panel scoring a fixed rubric, and a synthesis that grafts the losers\' best ideas',
  whenToUse: 'Architecture and product decisions with a wide option space, where a single-track designer would anchor on the first workable idea',
  phases: [
    { title: 'Propose', detail: 'four philosophies design independently' },
    { title: 'Judge', detail: 'independent panel scores every proposal' },
    { title: 'Synthesize', detail: 'winner + grafts -> final design doc' },
  ],
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['title', 'summary', 'components', 'tradeoffs', 'risks'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'the design in one paragraph' },
    components: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'responsibility'],
        properties: {
          name: { type: 'string' },
          responsibility: { type: 'string' },
          interfaces: { type: 'string', description: 'what it exposes to / consumes from other components' },
        },
      },
    },
    dataFlow: { type: 'string', description: 'how a representative request/interaction moves through the design' },
    tradeoffs: { type: 'array', items: { type: 'string' }, description: 'what this design deliberately sacrifices' },
    risks: { type: 'array', items: { type: 'string' }, description: 'where this design most likely fails' },
    migrationPath: { type: 'string', description: 'how to get there from the current state, if context given' },
  },
}

const SCORES_SCHEMA = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['proposal', 'fitness', 'simplicity', 'evolvability', 'operability', 'rationale'],
        properties: {
          proposal: { type: 'string', description: 'the proposal letter: A, B, C, or D' },
          fitness: { type: 'number', description: '1-10: solves the actual brief, including its awkward corners' },
          simplicity: { type: 'number', description: '1-10: fewest concepts that could work; no speculative generality' },
          evolvability: { type: 'number', description: '1-10: survives the requirements changing' },
          operability: { type: 'number', description: '1-10: debuggable, observable, deployable by real humans' },
          rationale: { type: 'string', description: 'one paragraph; must cite specifics from the proposal' },
          bestIdea: { type: 'string', description: 'the single strongest idea in this proposal, even if it loses overall' },
        },
      },
    },
  },
}

if (!args || !args.brief) {
  return { error: 'design-tournament requires args: { brief }. Optional: { context, judges, out }' }
}

const brief = args.brief
const context = (args && args.context) || null
const judgeCount = (args && args.judges) || 3

// Philosophies are identities, not suggestions. Each one biases every design
// decision differently — that bias is the diversity mechanism. A "be creative,
// give me something different" prompt converges; an identity doesn't.
const PHILOSOPHIES = [
  { key: 'A', name: 'ship-simplest', identity: 'You believe the best design is the one a mid-level engineer ships correctly in two weeks and anyone can debug at 3am. Boring technology, few moving parts, obvious data flow. You would rather cut scope than add a concept.' },
  { key: 'B', name: 'evolvability', identity: 'You believe requirements always change and the design\'s job is to make the NEXT change cheap. Strong interfaces, replaceable parts, explicit extension points where change is likely — and you are disciplined about not adding ones where it is not.' },
  { key: 'C', name: 'data-first', identity: 'You believe designs live or die on their data model. Get the schema, ownership, consistency, and lifecycle of every piece of state right and the components fall out of it. You design the data model first and treat code as its custodian.' },
  { key: 'D', name: 'failure-first', identity: 'You believe the design IS its failure modes. You start from what breaks — partial failures, retries, races, bad input, overload — and build the happy path inside whatever structure survives that analysis. Explicit invariants, idempotency, observability.' },
]

// --------------------------------------------------------------------------
// Phase 1: Propose — four independent designs. Proposers never see each
// other. Barrier justified: judges need all proposals at once.
// --------------------------------------------------------------------------

phase('Propose')

const proposals = (await parallel(PHILOSOPHIES.map(p => () =>
  agent(
    `${p.identity}

     Design a solution for this brief, in character, as your philosophy demands.
     BRIEF: ${brief}
     ${context ? `CONTEXT — study this first: ${context}` : ''}
     Be concrete: real component names, real interfaces, a walked-through data
     flow. State honestly what your design sacrifices (tradeoffs) and where it
     most likely fails (risks). Do not hedge toward a "balanced" design — the
     panel needs your philosophy expressed, not diluted.`,
    { label: `propose:${p.name}`, schema: PROPOSAL_SCHEMA },
  ).then(prop => ({ letter: p.key, philosophy: p.name, proposal: prop })),
))).filter(r => r && r.proposal)

if (proposals.length < 2) {
  return { winner: null, scoreboard: [], design: null, grafts: [], dissent: 'Fewer than 2 proposals produced — tournament aborted.' }
}
log(`${proposals.length} proposals in: ${proposals.map(p => `${p.letter}=${p.proposal.title}`).join(', ')}`)

// --------------------------------------------------------------------------
// Phase 2: Judge — every judge scores EVERY proposal, independently, against
// the same rubric. Proposals are presented anonymized (letter only, no
// philosophy name) so judges evaluate the design, not the brand.
// --------------------------------------------------------------------------

phase('Judge')

const anonymized = proposals.map(p => ({ letter: p.letter, ...p.proposal }))

const panels = (await parallel(Array.from({ length: judgeCount }, (_, j) => () =>
  agent(
    `You are judge ${j + 1} of ${judgeCount} on an independent design panel.
     BRIEF: ${brief}
     ${context ? `CONTEXT: ${context}` : ''}
     Score EVERY proposal below on the rubric (1-10 each axis). Judge against the
     brief, not against your personal taste. Your rationale must cite specifics —
     a score without a cited mechanism is invalid. Also name each proposal's
     single best idea, even for proposals you score low overall.
     PROPOSALS: ${JSON.stringify(anonymized, null, 2)}`,
    { label: `judge:${j + 1}`, effort: 'high', schema: SCORES_SCHEMA },
  ),
))).filter(Boolean)

// Tally in plain code — aggregation is arithmetic, not judgment.
const tally = new Map(proposals.map(p => [p.letter, { letter: p.letter, philosophy: p.philosophy, title: p.proposal.title, total: 0, votes: 0, bestIdeas: [] }]))
for (const panel of panels) {
  for (const s of panel.scores) {
    const t = tally.get(s.proposal)
    if (!t) continue
    t.total += (s.fitness + s.simplicity + s.evolvability + s.operability)
    t.votes++
    if (s.bestIdea) t.bestIdeas.push(s.bestIdea)
  }
}
const scoreboard = [...tally.values()]
  .map(t => ({ ...t, avg: t.votes ? Math.round((t.total / t.votes) * 10) / 10 : 0 }))
  .sort((a, b) => b.avg - a.avg)
const winner = scoreboard[0]
log(`Scoreboard: ${scoreboard.map(s => `${s.letter}(${s.philosophy})=${s.avg}`).join('  ')}`)

// --------------------------------------------------------------------------
// Phase 3: Synthesize — the winner is the SKELETON, not the whole answer.
// The synthesizer must consider every losing proposal's best ideas (as named
// by the judges) and graft the compatible ones, recording what it grafted
// and what it rejected. Dissent (a judge who scored the winner low) is
// surfaced, not averaged away.
// --------------------------------------------------------------------------

phase('Synthesize')

const winnerProposal = proposals.find(p => p.letter === winner.letter)
const losers = proposals.filter(p => p.letter !== winner.letter)

const design = await agent(
  `Synthesize the final design document.
   BRIEF: ${brief}
   ${context ? `CONTEXT: ${context}` : ''}

   WINNING proposal (${winner.avg}/40 avg) — use as the skeleton:
   ${JSON.stringify(winnerProposal.proposal, null, 2)}

   LOSING proposals' best ideas, as identified by independent judges:
   ${JSON.stringify(losers.map(l => ({ from: l.proposal.title, ideas: (tally.get(l.letter) || {}).bestIdeas })), null, 2)}

   For each losing idea: graft it into the design if compatible, or explicitly
   reject it with one sentence of why. Produce a markdown design doc: decision
   summary, component architecture, data flow, failure handling, tradeoffs
   accepted, rejected alternatives (with the scoreboard), and open questions.
   ${args.out ? `Write the doc to ${args.out} and return the markdown as well.` : 'Return the markdown.'}`,
  { label: 'synthesize', effort: 'high' },
)

// Surface dissent: a judge who scored the winner far below the panel mean is
// signal about a real weakness, not noise to average away.
const dissent = []
for (let j = 0; j < panels.length; j++) {
  const s = panels[j].scores.find(x => x.proposal === winner.letter)
  if (s) {
    const judgeTotal = s.fitness + s.simplicity + s.evolvability + s.operability
    if (judgeTotal <= winner.avg - 6) dissent.push(`Judge ${j + 1} scored the winner ${judgeTotal}/40 (panel avg ${winner.avg}): ${s.rationale}`)
  }
}

return {
  winner: { letter: winner.letter, philosophy: winner.philosophy, title: winner.title, avg: winner.avg },
  scoreboard: scoreboard.map(s => ({ letter: s.letter, philosophy: s.philosophy, title: s.title, avg: s.avg })),
  design,
  grafts: losers.map(l => ({ from: l.proposal.title, judgesLiked: (tally.get(l.letter) || {}).bestIdeas })),
  dissent: dissent.length ? dissent : 'No strong dissent — panel was aligned on the winner.',
}

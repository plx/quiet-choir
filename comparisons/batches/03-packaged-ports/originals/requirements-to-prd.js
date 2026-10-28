/**
 * requirements-to-prd — raw requirements become a critiqued PRD with explicit unknowns
 * ====================================================================================
 *
 * USE CASE
 *   The inputs to a PRD are never a PRD: meeting notes, a founder's voice memo,
 *   a support-ticket pile, a competitor teardown. Four extraction lenses read
 *   the raw material in parallel, a writer drafts the PRD, and — the part that
 *   earns the fan-out — three adversarial critics attack the draft (ambiguity,
 *   scope, feasibility) before a revision pass. What can't be resolved from
 *   the inputs becomes `openQuestions` rather than silent invention.
 *
 * INTERACTION (checkpoint pattern)
 *   Workflows cannot ask the user questions mid-run. This one checkpoints
 *   instead: it returns openQuestions + assumptions; the session surfaces them
 *   to the human, and their answers come back via args.answers on a re-run
 *   (resume caching makes that second pass cheap).
 *
 * ARGS  (required: input)
 *   { input: string, product?: string, answers?: string, out?: string }
 *   - input: path(s) to raw requirement material, or the text itself
 *   - product: one-line product context ("B2B invoicing SaaS, 200 customers")
 *   - answers: responses to a previous run's openQuestions, woven in as
 *     first-class requirements
 *   - out: write the PRD here (optional)
 *
 * COST PROFILE
 *   4 extractors + 1 drafter + 3 critics + 1 reviser ≈ 9 agents.
 *
 * OUTPUT
 *   { prd, assumptions, openQuestions, conflicts, critiqueSummary }
 */

export const meta = {
  name: 'requirements-to-prd',
  description: 'Extract raw requirements through four lenses, draft a PRD, attack it with ambiguity/scope/feasibility critics, and surface unknowns as open questions',
  whenToUse: 'Turning meeting notes, briefs, transcripts, or feedback piles into a PRD honest enough to build from — with unknowns surfaced, not invented',
  phases: [
    { title: 'Extract', detail: 'four lenses over the raw material' },
    { title: 'Draft', detail: 'one writer, PRD structure' },
    { title: 'Attack', detail: 'ambiguity, scope, and feasibility critics' },
    { title: 'Revise', detail: 'apply critiques; unresolvables become questions' },
  ],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['point', 'source'],
        properties: {
          point: { type: 'string', description: 'one extracted requirement/goal/constraint' },
          source: { type: 'string', description: 'where in the raw material this comes from — quote or location' },
          confidence: { enum: ['stated', 'implied', 'inferred'] },
        },
      },
    },
    unknowns: { type: 'array', items: { type: 'string' }, description: 'things the material raises but does not answer' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'places the material contradicts itself' },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['problem', 'severity', 'fix'],
        properties: {
          problem: { type: 'string', description: 'quote the offending PRD text' },
          severity: { enum: ['blocking', 'major', 'minor'] },
          fix: { type: 'string', description: 'concrete rewrite, cut, or question to surface — never "clarify this"' },
        },
      },
    },
  },
}

if (!args || !args.input) {
  return { error: 'requirements-to-prd requires args: { input } — path(s) to raw requirement material, or the text itself. Optional: { product, answers, out }' }
}
const material = args.input.includes('\n') ? `this raw material:\n---\n${args.input}\n---` : `the raw requirement material at: ${args.input} (read all of it)`
const product = (args && args.product) || null
const answers = (args && args.answers) || null

// ---------------------------------------------------------------------------
// Phase 1: Extract — four lenses, charters + anti-charters. Confidence tiers
// matter downstream: "stated" survives critique untouched; "inferred" is what
// the feasibility critic hunts. Barrier justified: the drafter needs all four.
// ---------------------------------------------------------------------------

phase('Extract')

const LENSES = [
  { key: 'user-needs', charter: 'What users need to DO and why: jobs, workflows, pains, the moments of truth. Ignore business metrics and technical constraints — other lenses own those.' },
  { key: 'business', charter: 'Goals, success metrics, pricing/packaging implications, competitive positioning, deadlines with reasons. Ignore feature details unless tied to a goal.' },
  { key: 'constraints', charter: 'Hard boundaries: technical constraints, compliance/privacy, platform requirements, performance/scale expectations, budget/team limits. Only what the material states or clearly implies — flag vague ones as unknowns.' },
  { key: 'unknowns', charter: 'Your PRIMARY output is the unknowns and conflicts lists: every decision the material leaves open, every contradiction between sources, every "TBD" hiding in confident prose. Findings only for meta-requirements the other lenses would miss.' },
]

const extractions = (await parallel(LENSES.map(l => () =>
  agent(
    `Read ${material}
     ${product ? `Product context: ${product}` : ''}
     ${answers ? `The product owner has ANSWERED a previous round of questions — treat these answers as first-class stated requirements:\n---\n${answers}\n---` : ''}
     Your lens: ${l.charter}
     Every finding carries its source and a confidence tier: stated (the material
     says it), implied (a reasonable reader agrees), inferred (you are guessing —
     be sparing). Do not invent requirements to fill gaps; gaps go in unknowns.`,
    { label: `extract:${l.key}`, schema: EXTRACT_SCHEMA },
  ),
))).filter(Boolean)

const findings = extractions.flatMap(e => e.findings)
const unknowns = [...new Set(extractions.flatMap(e => e.unknowns || []))]
const conflicts = [...new Set(extractions.flatMap(e => e.conflicts || []))]
log(`${findings.length} findings (${findings.filter(f => f.confidence === 'inferred').length} inferred), ${unknowns.length} unknowns, ${conflicts.length} conflicts`)

if (findings.length === 0) {
  return { prd: null, assumptions: [], openQuestions: unknowns, conflicts, critiqueSummary: 'No requirements extracted — is the input readable?' }
}

// ---------------------------------------------------------------------------
// Phase 2: Draft.
// ---------------------------------------------------------------------------

phase('Draft')

const draft = await agent(
  `Draft a PRD from these extracted requirements.
   ${product ? `Product context: ${product}` : ''}
   Findings (with confidence tiers): ${JSON.stringify(findings, null, 2)}
   Known conflicts (present them as decisions-needed, do not silently pick a side): ${JSON.stringify(conflicts)}
   Structure: Problem & context / Goals and success metrics / Users and jobs /
   Requirements (must vs should, each traceable to findings) / Non-functional
   requirements / Explicitly out of scope / Open questions / Assumptions.
   Every "inferred"-tier finding you rely on must appear in Assumptions. The
   Open questions section starts from these unknowns: ${JSON.stringify(unknowns)}.
   Return only the PRD markdown.`,
  { label: 'draft', effort: 'high' },
)

// ---------------------------------------------------------------------------
// Phase 3: Attack — three critics, three failure modes of PRDs. Same anti-
// charter logic as review dimensions: each critic ignores the others' turf.
// ---------------------------------------------------------------------------

phase('Attack')

const CRITICS = [
  { key: 'ambiguity', charter: 'Hunt text an engineer and a designer would read differently: unquantified adjectives ("fast", "simple"), requirements without acceptance shape, pronouns with unclear referents, "support X" without defining support. Ignore scope and feasibility.' },
  { key: 'scope', charter: 'Hunt scope failure: requirements that are three features wearing one bullet, missing cut-lines, "phase 2" work hiding in phase 1, and goals no requirement actually serves. Propose concrete cuts. Ignore wording quality.' },
  { key: 'feasibility', charter: 'Hunt wishful thinking: requirements that contradict the stated constraints, assumptions doing load-bearing work without evidence, success metrics that cannot be measured with what exists, dependencies on unbuilt or unnamed systems. Ignore style.' },
]

const critiques = (await parallel(CRITICS.map(c => () =>
  agent(
    `Attack this PRD draft. Your charter: ${c.charter}
     Draft:\n---\n${draft}\n---
     Every issue quotes the offending text and gives a concrete fix — a rewrite,
     a cut, or a question to put to the product owner. "Blocking" means building
     from this text as-is would produce the wrong product.`,
    { label: `attack:${c.key}`, effort: 'high', schema: CRITIQUE_SCHEMA },
  ),
))).filter(Boolean)

const issues = critiques.flatMap(c => c.issues)
log(`Critics raised ${issues.length} issues (${issues.filter(i => i.severity === 'blocking').length} blocking)`)

// ---------------------------------------------------------------------------
// Phase 4: Revise — one pass. Fixes that need the product owner become open
// questions, not guesses; that is the honesty valve of the whole workflow.
// ---------------------------------------------------------------------------

phase('Revise')

const revised = await agent(
  `Revise this PRD to address the critics' issues.
   Draft:\n---\n${draft}\n---
   Issues: ${JSON.stringify(issues, null, 2)}
   Apply every fix you can make WITHOUT new information from the product owner.
   Where a fix requires their input, add a precise question to Open Questions
   (with the decision's consequences) instead of guessing. Keep Assumptions
   honest — anything you decided unilaterally goes there.
   ${args.out ? `Write the final PRD to ${args.out} as well.` : ''}
   Return only the final PRD markdown.`,
  { label: 'revise', effort: 'high' },
)

const finalPrd = revised || draft
// Pull the structured lists back out of the document so the session can
// surface them without re-reading the PRD (checkpoint pattern).
const section = (title) => {
  const m = finalPrd && finalPrd.match(new RegExp(`#+\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n#+\\s|$)`, 'i'))
  return m ? m[1].split('\n').map(l => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean) : []
}

return {
  prd: finalPrd,
  assumptions: section('Assumptions'),
  openQuestions: section('Open Questions'),
  conflicts,
  critiqueSummary: `${issues.length} issues raised, ${issues.filter(i => i.severity === 'blocking').length} blocking. Re-run with args.answers to resolve the open questions.`,
}

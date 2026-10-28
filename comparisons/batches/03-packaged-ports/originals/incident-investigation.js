/**
 * incident-investigation — parallel evidence collection, competing hypotheses, falsification
 * ==========================================================================================
 *
 * USE CASE
 *   Post-incident (or mid-incident, read-only) investigation fails in a
 *   predictable way: the first plausible story becomes THE story, and all
 *   subsequent evidence gets read in its favor. This workflow structures the
 *   investigation against that bias: four evidence collectors work in
 *   parallel WITHOUT a hypothesis (diffs, logs/artifacts, config/infra,
 *   dependencies), a generator produces MULTIPLE competing hypotheses from
 *   the pooled evidence, and each hypothesis gets a dedicated FALSIFIER
 *   whose job is to kill it. The surviving hypothesis — the one that
 *   resisted falsification — anchors the report. Read-only throughout: an
 *   investigation that mutates the system is contaminating its own crime
 *   scene.
 *
 * WHEN TO USE
 *   - Post-incident review with a repo, logs, and a symptom description
 *   - "It broke sometime this week and nobody knows why"
 *   - Pre-blameless-postmortem evidence gathering
 *
 * ARGS  (required: incident)
 *   { incident: string, window?: string, artifacts?: string }
 *   - incident: symptom description — what happened, when noticed, impact
 *   - window: suspected time/commit window (default: last 7 days of changes)
 *   - artifacts: where logs/dumps/traces live, if any
 *
 * PATTERNS DEMONSTRATED
 *   - Hypothesis-free evidence collection: collectors gather facts BEFORE
 *     any story exists, so the story can't select the facts
 *   - Competing-hypotheses generation (3-5, mutually distinct by charter)
 *   - Falsification assignment: one adversarial agent PER hypothesis trying
 *     to disprove it — confirmation is cheap, surviving refutation is signal
 *   - Justified barriers at both joins (evidence pool, verdict comparison)
 *   - Read-only discipline stated in every prompt
 *
 * COST PROFILE
 *   4 collectors + 1 generator + 1 falsifier per hypothesis + 1 reporter
 *   ≈ 9-11 agents.
 *
 * OUTPUT
 *   { rootCause, confidence, timeline, survivors, falsified, report }
 */

export const meta = {
  name: 'incident-investigation',
  description: 'Hypothesis-free parallel evidence collection, competing root-cause hypotheses, one falsifier per hypothesis, and a survivors-only report',
  whenToUse: 'Post-incident root-cause analysis from a repo plus symptoms — structured to resist first-plausible-story bias',
  phases: [
    { title: 'Evidence', detail: 'four hypothesis-free collectors' },
    { title: 'Hypothesize', detail: 'generate competing explanations' },
    { title: 'Falsify', detail: 'one dedicated falsifier per hypothesis' },
    { title: 'Report', detail: 'timeline + root cause from survivors' },
  ],
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fact', 'source', 'timestamp'],
        properties: {
          fact: { type: 'string', description: 'one observable fact — no interpretation' },
          source: { type: 'string', description: 'sha, file, log line, config path' },
          timestamp: { type: 'string', description: 'when this fact occurred/changed, best effort; "unknown" allowed' },
          oddity: { type: 'boolean', description: 'true if this fact is surprising regardless of any hypothesis' },
        },
      },
    },
  },
}

const HYPOTHESES_SCHEMA = {
  type: 'object',
  required: ['hypotheses'],
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'story', 'mechanism', 'predictions'],
        properties: {
          id: { type: 'string', description: 'H1, H2, ...' },
          story: { type: 'string', description: 'the causal chain from trigger to symptom' },
          mechanism: { type: 'string', description: 'the specific technical mechanism' },
          predictions: { type: 'array', items: { type: 'string' }, description: 'checkable facts that MUST hold if true — the falsifier attacks these' },
          priorPlausibility: { enum: ['high', 'medium', 'low'] },
        },
      },
      description: '3-5 mutually DISTINCT hypotheses; each must differ in mechanism, not phrasing',
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reasoning'],
  properties: {
    verdict: { enum: ['falsified', 'survives', 'untestable'] },
    reasoning: { type: 'string' },
    checkedPredictions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prediction', 'held'],
        properties: { prediction: { type: 'string' }, held: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
  },
}

if (!args || !args.incident) {
  return { error: 'incident-investigation requires args: { incident } — symptom description, when noticed, impact. Optional: { window, artifacts }' }
}
const incident = args.incident
const window = (args && args.window) || 'the last 7 days of repository history'
const artifacts = (args && args.artifacts) || null

const READ_ONLY = 'STRICTLY READ-ONLY: run no command that mutates the repo, files, services, or state. You are investigating a crime scene, not cleaning it.'

// --------------------------------------------------------------------------
// Phase 1: Evidence — four collectors, four domains, ZERO hypotheses. The
// prompts deliberately withhold speculation requests: collectors report
// facts and flag oddities, and the barrier pools everything before any
// story exists to bias selection.
// --------------------------------------------------------------------------

phase('Evidence')

const COLLECTORS = [
  { key: 'diffs', prompt: `Collect change evidence from ${window}: every commit touching code plausibly related to the symptom, plus any commit that is large, rushed (odd hours, "hotfix"/"revert" messages), or touches shared infrastructure. Read the diffs. Report facts with shas and timestamps.` },
  { key: 'logs', prompt: `Collect runtime evidence${artifacts ? ` from: ${artifacts}` : ' from any logs, crash dumps, or traces checked into or referenced by this repo'}. Extract error messages, stack traces, timing patterns, and the first-occurrence timestamp of anything anomalous. If no artifacts exist, say so — report zero facts rather than inferring runtime behavior from code.` },
  { key: 'config', prompt: `Collect configuration/infrastructure evidence from ${window}: changes to config files, environment templates, feature flags, CI/CD definitions, infrastructure-as-code, container/build definitions. Config changes are underrepresented in incident stories precisely because they are quiet — be thorough. Facts with sources and timestamps.` },
  { key: 'deps', prompt: `Collect dependency evidence from ${window}: lockfile changes, version bumps, new/removed packages, toolchain updates (runtime versions, compiler flags). For each bump note whether it crossed a major version. Facts with sources and timestamps.` },
]

const pools = await parallel(COLLECTORS.map(c => () =>
  agent(
    `Incident under investigation: ${incident}
     ${READ_ONLY}
     ${c.prompt}
     Report FACTS ONLY — no interpretation, no story, no suspects. Flag as
     oddity anything surprising on its own terms.`,
    { label: `evidence:${c.key}`, schema: EVIDENCE_SCHEMA },
  ).then(r => ({ domain: c.key, facts: r ? r.facts : [] })),
))

const evidence = pools.filter(Boolean).flatMap(p => p.facts.map(f => ({ ...f, domain: p.domain })))
const oddities = evidence.filter(f => f.oddity)
log(`${evidence.length} facts collected (${oddities.length} flagged as odd) across ${pools.filter(Boolean).length} domains`)

if (evidence.length === 0) {
  return { rootCause: null, confidence: 'none', timeline: null, survivors: [], falsified: [], report: 'No evidence collected — check window and artifacts args.' }
}

// --------------------------------------------------------------------------
// Phase 2: Hypothesize — one generator, all evidence, MULTIPLE stories. The
// schema's `predictions` field is the crucial part: a hypothesis without
// falsifiable predictions is a vibe, and the falsifiers need attack surface.
// --------------------------------------------------------------------------

phase('Hypothesize')

const hypo = await agent(
  `Generate competing root-cause hypotheses for this incident.
   Incident: ${incident}
   Evidence (facts only, from four independent collectors):
   ${JSON.stringify(evidence, null, 2)}

   Produce 3-5 hypotheses with genuinely DIFFERENT mechanisms (not one story in
   five phrasings). At least one should involve the quiet domains (config/deps)
   and at least one should challenge the obvious suspect. For each: the causal
   story, the mechanism, and 2-4 PREDICTIONS — specific checkable facts that
   must hold if the hypothesis is true ("the error rate started after sha X
   deployed", "the bad output only occurs for inputs over 1MB"). Predictions
   are what the falsifiers will attack; vague predictions make the hypothesis
   untestable, which is a defect.`,
  { label: 'hypothesize', effort: 'high', schema: HYPOTHESES_SCHEMA },
)

if (!hypo || hypo.hypotheses.length === 0) {
  return { rootCause: null, confidence: 'none', timeline: null, survivors: [], falsified: [], report: 'Hypothesis generation failed.' }
}
log(`${hypo.hypotheses.length} competing hypotheses: ${hypo.hypotheses.map(h => h.id).join(', ')}`)

// --------------------------------------------------------------------------
// Phase 3: Falsify — one dedicated adversary per hypothesis, all concurrent.
// Note the assignment: each falsifier gets ONE hypothesis to kill and the
// others only as context. An agent asked to "evaluate all five" reverts to
// picking a favorite; an agent asked to kill one is thorough about that one.
// --------------------------------------------------------------------------

phase('Falsify')

const verdicts = (await parallel(hypo.hypotheses.map(h => () =>
  agent(
    `Your single job: FALSIFY hypothesis ${h.id}.
     ${READ_ONLY}
     Incident: ${incident}
     Hypothesis: ${h.story}
     Mechanism: ${h.mechanism}
     Predictions to attack: ${JSON.stringify(h.predictions)}
     Rival hypotheses (context only — do not evaluate them): ${hypo.hypotheses.filter(x => x.id !== h.id).map(x => x.story).join(' | ')}

     Check each prediction against the actual repo/logs/config. A prediction
     that fails falsifies the hypothesis. A prediction you cannot check is
     "untestable" — say so rather than assuming it holds. Verdict "survives"
     ONLY if every checkable prediction held under a genuine attempt to break
     it. Falsifying a hypothesis is a success, not a failure.`,
    { label: `falsify:${h.id}`, effort: 'high', schema: VERDICT_SCHEMA },
  ).then(v => ({ hypothesis: h, verdict: v })),
))).filter(r => r && r.verdict)

const survivors = verdicts.filter(v => v.verdict.verdict === 'survives')
const falsified = verdicts.filter(v => v.verdict.verdict === 'falsified')
const untestable = verdicts.filter(v => v.verdict.verdict === 'untestable')
log(`Falsification: ${survivors.length} survive, ${falsified.length} falsified, ${untestable.length} untestable`)

// --------------------------------------------------------------------------
// Phase 4: Report. Confidence derives from the STRUCTURE of the outcome, in
// code — not from a model's self-reported feeling: exactly one survivor with
// others falsified = high; multiple survivors = the report must say what
// evidence would discriminate them; zero survivors = honest "unknown".
// --------------------------------------------------------------------------

phase('Report')

const confidence = survivors.length === 1 && falsified.length >= 1 ? 'high'
  : survivors.length === 1 ? 'medium'
  : survivors.length > 1 ? 'split'
  : 'none'

const report = await agent(
  `Write the incident-investigation report in markdown.
   Incident: ${incident}
   Evidence pool (cite facts by source): ${JSON.stringify(evidence, null, 2)}
   Verdicts: ${JSON.stringify(verdicts.map(v => ({ id: v.hypothesis.id, story: v.hypothesis.story, verdict: v.verdict.verdict, reasoning: v.verdict.reasoning, checked: v.verdict.checkedPredictions })), null, 2)}
   Structural confidence: ${confidence}

   Structure: (1) Timeline — merge the evidence timestamps into an ordered
   narrative from first cause to detection; (2) Root cause — ${
     confidence === 'high' ? 'the surviving hypothesis, stated as the finding, with its verified predictions as proof'
     : confidence === 'split' ? 'the surviving hypotheses AND the specific evidence that would discriminate between them — do not pick a favorite'
     : confidence === 'none' ? 'state honestly that all hypotheses were falsified or untestable; list what evidence is missing'
     : 'the surviving hypothesis with the caveat that no rival was affirmatively falsified'
   }; (3) Falsified explanations — each dead hypothesis and what killed it
   (this section prevents the next investigator from re-walking dead ends);
   (4) Prevention — 2-4 concrete changes that would have prevented or caught
   this sooner. Cite evidence sources throughout.`,
  { label: 'report', effort: 'high' },
)

return {
  rootCause: survivors.length === 1 ? survivors[0].hypothesis.story : null,
  confidence,
  timeline: 'see report',
  survivors: survivors.map(s => ({ id: s.hypothesis.id, story: s.hypothesis.story })),
  falsified: falsified.map(f => ({ id: f.hypothesis.id, story: f.hypothesis.story, killedBy: f.verdict.reasoning })),
  report,
}

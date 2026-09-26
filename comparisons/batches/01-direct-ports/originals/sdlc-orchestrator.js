/**
 * sdlc-orchestrator — a resumable driver that chains the whole lifecycle, one checkpoint at a time
 * ================================================================================================
 *
 * USE CASE
 *   The capstone conductor: drive a feature from raw requirements to a gated
 *   release by running the library's workflows in sequence, with the human in
 *   the loop at every decision. It is NOT a fire-and-forget megascript — two
 *   properties of the harness make that impossible, and this design turns both
 *   into features:
 *
 *   1. NESTING IS ONE LEVEL. Two SDLC workflows are themselves conductors
 *      (prd-to-spec's optional design tournament; feature-factory always). This
 *      driver cannot call those via workflow() — it would nest two deep and
 *      throw. So it RUNS the eight leaf workflows inline and HANDS OFF the two
 *      conductor stages to the session to run as their own top-level workflows.
 *      Each handoff is also exactly where a human wants to weigh in anyway.
 *
 *   2. WORKFLOWS CAN'T ASK QUESTIONS MID-RUN. So this one is resumable: it runs
 *      stages until it hits a checkpoint — open questions, a failed gate, a
 *      handoff, or a budget pause — then RETURNS its full state. You (the
 *      session) resolve the checkpoint and re-invoke with the returned state
 *      plus answers. It skips completed stages and continues.
 *
 * WHEN TO USE
 *   - Driving a feature end-to-end with human checkpoints, as a team standard
 *   - Also useful in "plan" mode: one run with autoApprove=false stops at the
 *     first checkpoint and shows you the whole tailored stage plan
 *
 * ARGS
 *   { goal?, state?, answers?, inputs?, completed?, autoApprove?, plan? }
 *   - goal: what you're building (required on the FIRST call)
 *   - state: the object THIS workflow returned last time — pass it back verbatim
 *     to resume (omit on the first call)
 *   - answers: { stageKey: "answers to that stage's open questions" }
 *   - inputs: { requirements: path, ... } source material for early stages
 *   - completed: { stageKey: { path, summary } } — record a HANDOFF stage the
 *     session just finished (e.g. feature-factory), so the driver advances past it
 *   - autoApprove: run through non-blocking checkpoints without stopping
 *     (default false; blocking questions and handoffs always stop)
 *   - plan: if true, only produce the tailored stage plan and stop (no execution)
 *
 * COST PROFILE
 *   Dominated entirely by the child workflows it runs (each is a full
 *   multi-agent workflow). The orchestrator's OWN agents are cheap: 1 intake +
 *   1 gate per completed stage. Reserve a large budget; it pauses when low.
 *
 * OUTPUT (always resumable)
 *   checkpoint: { status:'checkpoint', reason, stage, ..., state, resume }
 *   complete:   { status:'complete', stagesRun, artifacts, state }
 */

export const meta = {
  name: 'sdlc-orchestrator',
  description: 'Resumable lifecycle driver: runs leaf SDLC workflows inline, hands off conductor stages (spec, implementation) to the session, and pauses at every human checkpoint with full resumable state',
  whenToUse: 'Driving a feature from requirements to a gated release with human checkpoints — the capstone that chains the library\'s workflows',
  phases: [
    { title: 'Intake', detail: 'assess entry point + tailor the stage plan' },
    { title: 'Drive', detail: 'run/hand-off stages until a checkpoint' },
  ],
}

const INTAKE_SCHEMA = {
  type: 'object',
  required: ['entryStage', 'plan', 'flags'],
  properties: {
    entryStage: { type: 'string', description: 'the stage key to start at, given what already exists' },
    plan: { type: 'array', items: { type: 'string' }, description: 'ordered stage keys to run, pruned to what this project needs' },
    flags: {
      type: 'object',
      properties: {
        greenfield: { type: 'boolean' },
        hasUI: { type: 'boolean' },
        hasFeedbackSource: { type: 'boolean' },
      },
    },
    rationale: { type: 'string' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['gate', 'summary'],
  properties: {
    gate: { enum: ['pass', 'concerns', 'blocked'] },
    blockingQuestions: { type: 'array', items: { type: 'string' }, description: 'questions the human must answer before the next stage is safe' },
    summary: { type: 'string' },
  },
}

if (!args || (!args.goal && !args.state)) {
  return { error: 'sdlc-orchestrator requires args.goal on the first call, or args.state to resume. Optional: { answers, inputs, completed, autoApprove, plan }' }
}

// ---------------------------------------------------------------------------
// Stage registry — the canonical lifecycle. `kind` encodes the nesting rule:
//   'run'     -> a LEAF workflow; safe to execute inline via workflow()
//   'handoff' -> a CONDUCTOR (calls workflow() itself); the session must run it
//                as its own top-level invocation and report back via args.completed
// argsFrom(state) builds each stage's inputs from artifacts prior stages wrote
// to disk (every stage writes to a known path; downstream reads the path).
// ---------------------------------------------------------------------------

const P = (state) => state.paths || {}
const STAGES = [
  { key: 'requirements', kind: 'run', workflow: 'requirements-to-prd', produces: 'prd',
    argsFrom: (s) => ({ input: (s.inputs && s.inputs.requirements) || s.goal, product: s.goal, answers: s.answers && s.answers.requirements, out: P(s).prd || 'docs/prd.md' }) },
  { key: 'spec', kind: 'handoff', ref: 'prd-to-spec', produces: 'spec',
    hint: (s) => ({ prd: P(s).prd || 'docs/prd.md', decideArchitecture: true, out: P(s).spec || 'docs/spec.md' }),
    why: 'prd-to-spec can spawn a design-tournament child — a conductor. It must run as its own top-level workflow (nesting is one level), and the architecture decision is a natural human checkpoint.' },
  { key: 'roadmap', kind: 'run', workflow: 'roadmap-plan', produces: 'roadmap',
    argsFrom: (s) => ({ spec: P(s).spec || 'docs/spec.md', priorities: s.answers && s.answers.roadmap, out: P(s).roadmap || 'docs/roadmap.md' }) },
  { key: 'backlog', kind: 'run', workflow: 'prd-decompose', produces: 'backlog',
    argsFrom: (s) => ({ prd: P(s).spec || 'docs/spec.md', codebase: '.', out: P(s).backlog || 'docs/backlog.md' }) },
  { key: 'bootstrap', kind: 'run', workflow: 'project-bootstrap', produces: 'bootstrap',
    appliesIf: (s) => s.flags && s.flags.greenfield,
    argsFrom: (s) => ({ spec: P(s).spec || 'docs/spec.md', apply: true }) },
  { key: 'implement', kind: 'handoff', ref: 'feature-factory', produces: 'implementation',
    hint: (s) => ({ prd: P(s).spec || 'docs/spec.md', codebase: '.' }),
    why: 'feature-factory is a conductor (it composes prd-decompose + deep-code-review per module). It must run as its own top-level workflow, and completing a build is the checkpoint before QA.' },
  { key: 'qa', kind: 'run', workflow: 'acceptance-qa-batch', produces: 'qa',
    argsFrom: (s) => ({ tickets: P(s).backlog || 'docs/backlog.md', scope: '.' }) },
  { key: 'release-gate', kind: 'run', workflow: 'release-gate', produces: 'gate',
    argsFrom: (s) => ({ policy: s.answers && s.answers['release-gate'] }) },
  { key: 'release-notes', kind: 'run', workflow: 'release-notes', produces: 'notes',
    appliesIf: (s) => s.gateWentGo !== false,
    argsFrom: (s) => ({ since: (s.inputs && s.inputs.since) || 'the previous release tag', out: 'CHANGELOG.md' }) },
  { key: 'feedback', kind: 'run', workflow: 'feedback-synthesis', produces: 'feedback',
    appliesIf: (s) => s.flags && s.flags.hasFeedbackSource,
    argsFrom: (s) => ({ source: (s.inputs && s.inputs.feedback) || 'the project feedback corpus' }) },
]
const stageByKey = new Map(STAGES.map(s => [s.key, s]))

// ---------------------------------------------------------------------------
// State bootstrap. On the first call we run intake to tailor the plan; on
// resume we trust the state the caller passed back.
// ---------------------------------------------------------------------------

let state = args.state || null

if (!state) {
  phase('Intake')
  const intake = await agent(
    `Assess the entry point for driving this goal through the software lifecycle,
     then tailor the stage plan.
     GOAL: ${args.goal}
     ${args.inputs ? `Provided inputs: ${JSON.stringify(args.inputs)}` : ''}
     Inspect the current repository: does a PRD already exist? a spec? code? CI?
     Decide the entryStage (skip stages whose output already exists) from this
     ordered set: ${STAGES.map(s => s.key).join(' -> ')}.
     Set flags: greenfield (no substantial code yet), hasUI (the product has a
     user interface — pulls in design work you should flag), hasFeedbackSource
     (a feedback corpus exists to synthesize). Return the pruned, ordered plan.`,
    { label: 'intake', effort: 'high', schema: INTAKE_SCHEMA },
  )
  if (!intake) return { status: 'error', reason: 'intake-failed', message: 'Could not assess the project; no changes made.' }

  // Prune to applicable stages, honoring the intake plan order where given.
  const planned = (intake.plan && intake.plan.length ? intake.plan : STAGES.map(s => s.key))
    .filter(k => stageByKey.has(k))
  state = {
    goal: args.goal,
    flags: intake.flags || {},
    inputs: args.inputs || {},
    answers: args.answers || {},
    paths: {},
    plan: planned,
    cursor: Math.max(0, planned.indexOf(intake.entryStage)),
    artifacts: {},
    log: [`intake: ${intake.rationale || 'plan tailored'}`],
  }

  if (args.plan) {
    // Plan-only mode: show the tailored chain and stop.
    return {
      status: 'plan',
      goal: state.goal,
      stagePlan: planned.map(k => ({ stage: k, kind: stageByKey.get(k).kind, ...(stageByKey.get(k).kind === 'handoff' ? { why: stageByKey.get(k).why } : {}) })),
      flags: state.flags,
      uiNote: state.flags.hasUI ? 'This product has a UI — run design-tournament / a UI design pass alongside the spec stage.' : undefined,
      state,
      resume: 'Re-invoke with this state (and drop args.plan) to begin executing.',
    }
  }
}

// Merge in anything the caller resolved since last time.
if (args.answers) state.answers = { ...state.answers, ...args.answers }
if (args.completed) {
  for (const [k, v] of Object.entries(args.completed)) {
    state.artifacts[k] = v
    if (v && v.path) state.paths[stageByKey.get(k)?.produces || k] = v.path
    state.log.push(`handoff completed: ${k}`)
  }
}

// ---------------------------------------------------------------------------
// Drive — advance through the plan until a checkpoint. Inherently sequential:
// each stage consumes the prior stage's artifact. The multi-agent power lives
// in the child workflows, not in this loop.
// ---------------------------------------------------------------------------

phase('Drive')

const stagesRunThisCall = []

while (state.cursor < state.plan.length) {
  const stage = stageByKey.get(state.plan[state.cursor])

  // Skip stages that don't apply or are already done (e.g. resumed handoffs).
  if (!stage || (stage.appliesIf && !stage.appliesIf(state)) || state.artifacts[stage.key]) {
    state.cursor++
    continue
  }

  // Budget guard between stages — child workflows are expensive.
  if (budget.total && budget.remaining() < 120_000) {
    return checkpoint('budget', stage, { message: `Paused before "${stage.key}" — token budget low (${Math.round(budget.remaining() / 1000)}k left). Re-invoke with more budget to continue.` })
  }

  // HANDOFF: a conductor stage the session must run itself (nesting rule).
  if (stage.kind === 'handoff') {
    return checkpoint('handoff', stage, {
      message: `Run "${stage.ref}" as its own top-level workflow, then re-invoke sdlc-orchestrator with args.completed = { "${stage.key}": { path, summary } }.`,
      runThisNext: { workflow: stage.ref, args: stage.hint(state) },
      why: stage.why,
    })
  }

  // RUN: execute the leaf workflow inline. (Dynamic dispatch by name — every
  // 'run' stage is a leaf by construction, so this never nests two deep.)
  log(`Stage: ${stage.key} (running ${stage.workflow})`)
  const result = await workflow(stage.workflow, stage.argsFrom(state))
  state.artifacts[stage.key] = { summary: summarize(stage.key, result) }
  if (stage.produces && stage.argsFrom(state).out) state.paths[stage.produces] = stage.argsFrom(state).out
  if (stage.key === 'release-gate') state.gateWentGo = !result || result.decision !== 'no-go'
  stagesRunThisCall.push(stage.key)

  // Gate: assess the stage's output and decide whether the human must weigh in
  // before the next stage. This is the checkpoint valve.
  const gate = await agent(
    `A lifecycle stage just finished. Decide whether the human must weigh in
     before the next stage runs.
     Stage: ${stage.key}. Goal: ${state.goal}.
     Its result: ${JSON.stringify(result).slice(0, 3000)}
     Next stage: ${state.plan[state.cursor + 1] || 'none — this is the last'}.
     gate "blocked" (with blockingQuestions) if the result raises open questions
     or failures the next stage would build on wrongly (e.g. a no-go release
     decision, unanswered PRD questions, a failed QA verdict). "concerns" for
     non-blocking notes. "pass" if it's safe to proceed.`,
    { label: `gate:${stage.key}`, effort: 'high', schema: GATE_SCHEMA },
  )
  state.log.push(`${stage.key}: ${gate ? gate.gate : 'gate-unknown'} — ${gate ? gate.summary : ''}`)
  state.cursor++

  const blocking = gate && gate.gate === 'blocked'
  if (blocking || (gate && gate.gate === 'concerns' && !args.autoApprove)) {
    return checkpoint(blocking ? 'gate-blocked' : 'review', stage, {
      questions: (gate && gate.blockingQuestions) || [],
      summary: gate ? gate.summary : '',
      message: blocking
        ? `Answer these before continuing, then re-invoke with args.answers["${stage.plan?.[state.cursor] || 'next'}"] and this state.`
        : `Non-blocking review point after "${stage.key}". Re-invoke to continue (or set autoApprove to skip these).`,
    })
  }
}

return {
  status: 'complete',
  goal: state.goal,
  stagesRun: Object.keys(state.artifacts),
  artifacts: state.artifacts,
  paths: state.paths,
  log: state.log,
  state,
  note: 'Lifecycle plan complete. Loop back to `requirements` with new feedback to plan the next iteration.',
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function checkpoint(reason, stage, extra) {
  return {
    status: 'checkpoint',
    reason,
    stage: stage.key,
    stagesRunThisCall,
    ...extra,
    state,            // pass this back verbatim to resume
    resume: 'Re-invoke sdlc-orchestrator with args.state set to the returned `state` (plus any args.answers / args.completed the checkpoint asks for).',
  }
}

function summarize(key, result) {
  if (!result) return `${key}: (no result)`
  if (typeof result === 'string') return result.slice(0, 300)
  // Pull the most decision-relevant field per stage.
  const pick = result.decision || result.verdict || result.summary || result.critiqueSummary || result.verification || result.notes
  return typeof pick === 'string' ? pick.slice(0, 300) : `${key}: done (${Object.keys(result).slice(0, 4).join(', ')})`
}

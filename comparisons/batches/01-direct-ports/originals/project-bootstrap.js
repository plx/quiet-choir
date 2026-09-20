/**
 * project-bootstrap — stand up dev environment, tooling, and CI from a spec
 * =========================================================================
 *
 * USE CASE
 *   The unglamorous day-zero work that a team either does well once or suffers
 *   for the project's whole life: toolchain, linting/formatting, test harness,
 *   CI/CD, pre-commit hooks, containerization. This workflow decides the stack
 *   from the spec (or detects it from an existing repo), sets up each concern
 *   in parallel where the concerns are independent, then PROVES the setup works
 *   by running it — a green pipeline, not a claimed one. Idempotent by design:
 *   it detects and augments existing setup rather than clobbering it.
 *
 * WHEN TO USE
 *   - Day zero of a new project, from a spec or PRD
 *   - Retrofitting CI/linting/tests onto a repo that grew without them
 *
 * ARGS
 *   { spec?: string, stack?: string, concerns?: string[], apply?: boolean }
 *   - spec: path/text describing what's being built (informs stack choice)
 *   - stack: override detection ("Python 3.12 + FastAPI", "Node/TS + Vite")
 *   - concerns: subset to set up (default: all detected-relevant)
 *   - apply: write files and run setup (default false = plan only)
 *
 * PATTERNS DEMONSTRATED
 *   - Detect-then-plan: read reality before proposing (idempotency)
 *   - Independent-concern fan-out with a written barrier defense
 *   - Prove-by-running: the verifier executes lint/test/build, never asserts
 *   - Report-only default for a filesystem-mutating workflow
 *
 * COST PROFILE
 *   1 detect + 1 planner + 1 setter per concern + 1 verifier + 1 repair ≈ 8-10.
 *
 * OUTPUT
 *   { stack, concerns: [...], verification, applied, followups }
 */

export const meta = {
  name: 'project-bootstrap',
  description: 'Detect or choose the stack, set up toolchain/lint/tests/CI/containers in parallel, then prove the pipeline runs green — idempotent, report-only by default',
  whenToUse: 'Standing up a new project\'s dev environment and CI from a spec, or retrofitting tooling onto a repo that lacks it',
  phases: [
    { title: 'Detect', detail: 'read existing setup + choose stack' },
    { title: 'Plan', detail: 'one setup plan across concerns' },
    { title: 'Set up', detail: 'one agent per independent concern' },
    { title: 'Prove', detail: 'run lint/test/build/CI-dry-run' },
  ],
}

const DETECT_SCHEMA = {
  type: 'object',
  required: ['stack', 'existing', 'relevantConcerns'],
  properties: {
    stack: { type: 'string', description: 'the chosen or detected stack, specific versions where knowable' },
    existing: { type: 'array', items: { type: 'string' }, description: 'tooling already present — do not clobber these' },
    relevantConcerns: { type: 'array', items: { enum: ['toolchain', 'lint-format', 'test-harness', 'ci-cd', 'pre-commit', 'containerization', 'env-config'] } },
    packageManager: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['concerns', 'verifyCommands'],
  properties: {
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['concern', 'action', 'files'],
        properties: {
          concern: { type: 'string' },
          action: { enum: ['create', 'augment', 'skip-present'] },
          files: { type: 'array', items: { type: 'string' }, description: 'files this concern owns — disjoint from other concerns' },
          detail: { type: 'string' },
        },
      },
    },
    verifyCommands: { type: 'array', items: { type: 'string' }, description: 'commands that prove the setup works (lint, test, build, ci dry-run)' },
  },
}

const SETUP_SCHEMA = {
  type: 'object',
  required: ['concern', 'status', 'filesWritten'],
  properties: {
    concern: { type: 'string' },
    status: { enum: ['done', 'partial', 'skipped'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const PROVE_SCHEMA = {
  type: 'object',
  required: ['green', 'results'],
  properties: {
    green: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'passed'],
        properties: { command: { type: 'string' }, passed: { type: 'boolean' }, output: { type: 'string' } },
      },
    },
  },
}

const apply = Boolean(args && args.apply)

// ---------------------------------------------------------------------------
// Phase 1: Detect — idempotency starts here. Read what exists so setup
// augments rather than overwrites.
// ---------------------------------------------------------------------------

phase('Detect')

const detect = await agent(
  `Decide the tech stack and inventory existing tooling for a project bootstrap.
   ${args && args.spec ? `Spec: ${args.spec.includes('\n') ? args.spec : `read ${args.spec}`}` : 'No spec provided — infer intent from any existing code.'}
   ${args && args.stack ? `Stack is specified: ${args.stack} — use it.` : 'Choose an appropriate, conventional stack (favor boring, well-supported choices).'}
   Read the repo: what tooling already exists (package manager, linter, test
   runner, CI config, containers)? List it as "existing" — the setup phase must
   NOT clobber these. Then list which bootstrap concerns are relevant.`,
  { label: 'detect', schema: DETECT_SCHEMA },
)

if (!detect) return { stack: null, concerns: [], verification: null, applied: false, followups: ['Detection failed.'] }
const wanted = (args && args.concerns) ? detect.relevantConcerns.filter(c => args.concerns.includes(c)) : detect.relevantConcerns
log(`Stack: ${detect.stack}. Concerns: ${wanted.join(', ')}. Existing: ${detect.existing.join(', ') || 'none'}`)

// ---------------------------------------------------------------------------
// Phase 2: Plan — one planner assigns each concern disjoint files (so Phase 3
// can parallelize) and marks create/augment/skip per concern.
// ---------------------------------------------------------------------------

phase('Plan')

const plan = await agent(
  `Plan the bootstrap for a ${detect.stack} project (package manager: ${detect.packageManager || 'detect'}).
   Concerns to set up: ${wanted.join(', ')}
   Already present (augment or skip — never overwrite): ${detect.existing.join(', ') || 'none'}
   Assign each concern the specific files it owns; file sets MUST be disjoint so
   the concerns can be set up in parallel. For each concern choose create (new),
   augment (extend existing), or skip-present. Provide the exact commands that
   would PROVE the finished setup works (install, lint, test, build, and a CI
   config dry-run/validation if applicable).`,
  { label: 'plan', effort: 'high', schema: PLAN_SCHEMA },
)

if (!plan) return { stack: detect.stack, concerns: [], verification: null, applied: false, followups: ['Planning failed.'] }

if (!apply) {
  return {
    stack: detect.stack,
    concerns: plan.concerns.map(c => ({ concern: c.concern, action: c.action, files: c.files })),
    verification: `Plan only (apply:false). Would run: ${plan.verifyCommands.join(' && ')}`,
    applied: false,
    followups: ['Re-run with apply:true to write files and prove the pipeline.'],
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Set up — parallel over concerns. Barrier justified: the prove
// phase must see ALL concerns in place before running the pipeline (a test
// harness with no toolchain installed proves nothing). Disjoint files (from
// the plan) make concurrent writers in one tree safe.
// ---------------------------------------------------------------------------

phase('Set up')

const active = plan.concerns.filter(c => c.action !== 'skip-present')
const results = (await parallel(active.map(c => () =>
  agent(
    `Set up the "${c.concern}" concern for a ${detect.stack} project. Action: ${c.action}.
     Files you own (touch ONLY these): ${c.files.join(', ')}
     Detail: ${c.detail || ''}
     Use conventional, current configurations for this stack. If augmenting,
     preserve everything already in the file and add only what's missing. Do NOT
     run install/build/test — a dedicated prover does that once, globally.`,
    { label: `setup:${c.concern}`, phase: 'Set up', schema: SETUP_SCHEMA },
  ),
))).filter(Boolean)
log(`${results.filter(r => r.status === 'done').length}/${active.length} concerns set up`)

// ---------------------------------------------------------------------------
// Phase 4: Prove — run the pipeline. A bootstrap that claims success without a
// green run is exactly the failure mode this phase exists to prevent.
// ---------------------------------------------------------------------------

phase('Prove')

let prove = await agent(
  `Prove the project setup works. Run these commands in order and report each
   one's pass/fail with output: ${JSON.stringify(plan.verifyCommands)}
   Install first if needed. Do not fix failures — report them. "green" is true
   only if every command passed.`,
  { label: 'prove', schema: PROVE_SCHEMA },
)

if (prove && !prove.green) {
  const failed = prove.results.filter(r => !r.passed)
  log(`${failed.length} setup checks failed — one repair round`)
  await agent(
    `Fix the failing project-setup checks (config errors, missing deps, wrong
     paths — NOT by disabling the check): ${JSON.stringify(failed, null, 2)}
     Stack: ${detect.stack}. Edit the relevant config files, then stop.`,
    { label: 'repair', phase: 'Prove' },
  )
  prove = await agent(
    `Re-run the verification commands and report: ${JSON.stringify(plan.verifyCommands)}`,
    { label: 're-prove', phase: 'Prove', schema: PROVE_SCHEMA },
  )
}

return {
  stack: detect.stack,
  concerns: results.map(r => ({ concern: r.concern, status: r.status, files: r.filesWritten })),
  verification: prove ? (prove.green ? 'green — pipeline runs' : `red — ${prove.results.filter(r => !r.passed).map(r => r.command).join(', ')} failing`) : 'prover unavailable',
  applied: true,
  followups: prove && prove.green ? [] : ['Setup applied but the pipeline is not green — see verification; human attention needed.'],
}

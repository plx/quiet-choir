// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'project-bootstrap',
  description:
    'Detect or choose the stack, set up toolchain/lint/tests/CI/containers in parallel, then prove the pipeline runs green — idempotent, report-only by default',
  whenToUse:
    "Standing up a new project's dev environment and CI from a spec, or retrofitting tooling onto a repo that lacks it",
  phases: [
    { title: 'Detect', detail: 'read existing setup + choose stack' },
    { title: 'Plan', detail: 'one setup plan across concerns' },
    { title: 'Set up', detail: 'one agent per independent concern' },
    { title: 'Prove', detail: 'run lint/test/build/CI-dry-run' },
  ],
};
export const input = z.object({
  ...executionInput,
  apply: z.boolean().optional(),
  spec: z.string().optional(),
  stack: z.string().optional(),
  concerns: z.array(z.string()).optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const DETECT_SCHEMA = z
      .object({
        stack: z
          .string()
          .describe('the chosen or detected stack, specific versions where knowable'),
        existing: z.array(z.string()).describe('tooling already present — do not clobber these'),
        relevantConcerns: z.array(
          z.enum([
            'toolchain',
            'lint-format',
            'test-harness',
            'ci-cd',
            'pre-commit',
            'containerization',
            'env-config',
          ]),
        ),
        packageManager: z.string().optional(),
      })
      .catchall(z.json());

    const PLAN_SCHEMA = z
      .object({
        concerns: z.array(
          z
            .object({
              concern: z.string(),
              action: z.enum(['create', 'augment', 'skip-present']),
              files: z
                .array(z.string())
                .describe('files this concern owns — disjoint from other concerns'),
              detail: z.string().optional(),
            })
            .catchall(z.json()),
        ),
        verifyCommands: z
          .array(z.string())
          .describe('commands that prove the setup works (lint, test, build, ci dry-run)'),
      })
      .catchall(z.json());

    const SETUP_SCHEMA = z
      .object({
        concern: z.string(),
        status: z.enum(['done', 'partial', 'skipped']),
        filesWritten: z.array(z.string()),
        notes: z.string().optional(),
      })
      .catchall(z.json());

    const PROVE_SCHEMA = z
      .object({
        green: z.boolean(),
        results: z.array(
          z
            .object({ command: z.string(), passed: z.boolean(), output: z.string().optional() })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const apply = Boolean(args && args.apply);

    // ---------------------------------------------------------------------------
    // Phase 1: Detect — idempotency starts here. Read what exists so setup
    // augments rather than overwrites.
    // ---------------------------------------------------------------------------

    port.phase('Detect');

    const detect = await ctx.claude
      .object(port.id('agent-1', 'detect'), {
        ...args.$claude,
        prompt: `Decide the tech stack and inventory existing tooling for a project bootstrap.
   ${args && args.spec ? `Spec: ${args.spec.includes('\n') ? args.spec : `read ${args.spec}`}` : 'No spec provided — infer intent from any existing code.'}
   ${args && args.stack ? `Stack is specified: ${args.stack} — use it.` : 'Choose an appropriate, conventional stack (favor boring, well-supported choices).'}
   Read the repo: what tooling already exists (package manager, linter, test
   runner, CI config, containers)? List it as "existing" — the setup phase must
   NOT clobber these. Then list which bootstrap concerns are relevant.`,
        schema: DETECT_SCHEMA,
      })
      .then((result) => result.output);

    if (!detect)
      return {
        stack: null,
        concerns: [],
        verification: null,
        applied: false,
        followups: ['Detection failed.'],
      };
    const wanted =
      args && args.concerns
        ? detect.relevantConcerns.filter((c) => args.concerns.includes(c))
        : detect.relevantConcerns;
    port.log(
      `Stack: ${detect.stack}. Concerns: ${wanted.join(', ')}. Existing: ${detect.existing.join(', ') || 'none'}`,
    );

    // ---------------------------------------------------------------------------
    // Phase 2: Plan — one planner assigns each concern disjoint files (so Phase 3
    // can parallelize) and marks create/augment/skip per concern.
    // ---------------------------------------------------------------------------

    port.phase('Plan');

    const plan = await ctx.claude
      .object(port.id('agent-2', 'plan'), {
        ...args.$claude,
        prompt: `Plan the bootstrap for a ${detect.stack} project (package manager: ${detect.packageManager || 'detect'}).
   Concerns to set up: ${wanted.join(', ')}
   Already present (augment or skip — never overwrite): ${detect.existing.join(', ') || 'none'}
   Assign each concern the specific files it owns; file sets MUST be disjoint so
   the concerns can be set up in parallel. For each concern choose create (new),
   augment (extend existing), or skip-present. Provide the exact commands that
   would PROVE the finished setup works (install, lint, test, build, and a CI
   config dry-run/validation if applicable).`,
        schema: PLAN_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!plan)
      return {
        stack: detect.stack,
        concerns: [],
        verification: null,
        applied: false,
        followups: ['Planning failed.'],
      };

    if (!apply) {
      return {
        stack: detect.stack,
        concerns: plan.concerns.map((c) => ({
          concern: c.concern,
          action: c.action,
          files: c.files,
        })),
        verification: `Plan only (apply:false). Would run: ${plan.verifyCommands.join(' && ')}`,
        applied: false,
        followups: ['Re-run with apply:true to write files and prove the pipeline.'],
      };
    }

    // ---------------------------------------------------------------------------
    // Phase 3: Set up — parallel over concerns. Barrier justified: the prove
    // phase must see ALL concerns in place before running the pipeline (a test
    // harness with no toolchain installed proves nothing). Disjoint files (from
    // the plan) make concurrent writers in one tree safe.
    // ---------------------------------------------------------------------------

    port.phase('Set up');

    const active = plan.concerns.filter((c) => c.action !== 'skip-present');
    const results = (
      await port.parallel(
        'parallel-1',
        active.map(
          (c) => () =>
            ctx.claude
              .object(port.id('agent-3', `setup:${c.concern}`), {
                ...args.$claude,
                prompt: `Set up the "${c.concern}" concern for a ${detect.stack} project. Action: ${c.action}.
     Files you own (touch ONLY these): ${c.files.join(', ')}
     Detail: ${c.detail || ''}
     Use conventional, current configurations for this stack. If augmenting,
     preserve everything already in the file and add only what's missing. Do NOT
     run install/build/test — a dedicated prover does that once, globally.`,
                schema: SETUP_SCHEMA,
                // Original phase: 'Set up' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);
    port.log(
      `${results.filter((r) => r.status === 'done').length}/${active.length} concerns set up`,
    );

    // ---------------------------------------------------------------------------
    // Phase 4: Prove — run the pipeline. A bootstrap that claims success without a
    // green run is exactly the failure mode this phase exists to prevent.
    // ---------------------------------------------------------------------------

    port.phase('Prove');

    let prove = await ctx.claude
      .object(port.id('agent-4', 'prove'), {
        ...args.$claude,
        prompt: `Prove the project setup works. Run these commands in order and report each
   one's pass/fail with output: ${JSON.stringify(plan.verifyCommands)}
   Install first if needed. Do not fix failures — report them. "green" is true
   only if every command passed.`,
        schema: PROVE_SCHEMA,
      })
      .then((result) => result.output);

    if (prove && !prove.green) {
      const failed = prove.results.filter((r) => !r.passed);
      port.log(`${failed.length} setup checks failed — one repair round`);
      await ctx.claude
        .text(port.id('agent-5', 'repair'), {
          ...args.$claude,
          prompt: `Fix the failing project-setup checks (config errors, missing deps, wrong
     paths — NOT by disabling the check): ${JSON.stringify(failed, null, 2)}
     Stack: ${detect.stack}. Edit the relevant config files, then stop.`,

          // Original phase: 'Prove' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
      prove = await ctx.claude
        .object(port.id('agent-6', 're-prove'), {
          ...args.$claude,
          prompt: `Re-run the verification commands and report: ${JSON.stringify(plan.verifyCommands)}`,
          schema: PROVE_SCHEMA,
          // Original phase: 'Prove' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    return {
      stack: detect.stack,
      concerns: results.map((r) => ({
        concern: r.concern,
        status: r.status,
        files: r.filesWritten,
      })),
      verification: prove
        ? prove.green
          ? 'green — pipeline runs'
          : `red — ${prove.results
              .filter((r) => !r.passed)
              .map((r) => r.command)
              .join(', ')} failing`
        : 'prover unavailable',
      applied: true,
      followups:
        prove && prove.green
          ? []
          : [
              'Setup applied but the pipeline is not green — see verification; human attention needed.',
            ],
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});

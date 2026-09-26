// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'dependency-upgrade',
  description:
    'Upgrade a dependency: parallel changelog research + usage impact analysis, then apply and drive a bounded verify/fix loop',
  whenToUse:
    'Major-version dependency bumps where breaking changes are likely and usage is nontrivial',
  phases: [
    { title: 'Analyze', detail: 'changelog research ∥ usage impact map' },
    { title: 'Plan', detail: 'join both analyses into an upgrade plan' },
    { title: 'Apply', detail: 'perform the upgrade + mechanical fixes' },
    { title: 'Stabilize', detail: 'verify/fix loop until green or round cap' },
  ],
};
export const input = z.object({
  ...executionInput,
  package: z.string().optional(),
  toVersion: z.string().optional(),
  maxFixRounds: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const RESEARCH_SCHEMA = z
      .object({
        currentMajor: z.string(),
        targetVersion: z.string(),
        breakingChanges: z.array(
          z
            .object({
              change: z.string(),
              affects: z.string().describe('which APIs/patterns this breaks'),
              migrationHint: z.string().optional(),
            })
            .catchall(z.json()),
        ),
        migrationGuideUrl: z.string().optional(),
        notes: z.string().optional(),
      })
      .catchall(z.json());

    const IMPACT_SCHEMA = z
      .object({
        currentVersion: z.string().describe('exact installed version from the lockfile'),
        usageSites: z.array(
          z
            .object({
              file: z.string(),
              apis: z.array(z.string()).describe("which of the package's APIs this file uses"),
              heaviness: z.enum(['light', 'moderate', 'heavy']).optional(),
            })
            .catchall(z.json()),
        ),
        indirectExposure: z
          .string()
          .describe('wrappers, adapters, or re-exports that concentrate usage')
          .optional(),
      })
      .catchall(z.json());

    const PLAN_SCHEMA = z
      .object({
        riskLevel: z.enum(['trivial', 'moderate', 'risky', 'reconsider']),
        steps: z.array(z.string()).describe('ordered, concrete steps for the applier'),
        riskNotes: z.string().describe('where this upgrade is most likely to break things'),
        testFocus: z
          .array(z.string())
          .describe('areas the verifier should scrutinize hardest')
          .optional(),
      })
      .catchall(z.json());

    const VERIFY_SCHEMA = z
      .object({
        passed: z.boolean(),
        summary: z.string(),
        failures: z
          .array(
            z
              .object({ description: z.string(), files: z.array(z.string()).optional() })
              .catchall(z.json()),
          )
          .describe('clustered by root cause')
          .optional(),
      })
      .catchall(z.json());

    if (!args || !args.package) {
      return {
        error:
          'dependency-upgrade requires args: { package }. Optional: { toVersion, maxFixRounds }',
      };
    }
    const pkg = args.package;
    const targetVersion = args.toVersion || 'latest stable';
    const maxFixRounds = (args && args.maxFixRounds) || 3;

    // --------------------------------------------------------------------------
    // Phase 1: Analyze — the two halves of upgrade risk, in parallel. The barrier
    // after this is the textbook justified case: the plan is literally a join of
    // (what changed) × (what we use).
    // --------------------------------------------------------------------------

    port.phase('Analyze');

    const [research, impact] = await port.parallel('parallel-1', [
      () =>
        ctx.claude
          .object(port.id('agent-1', 'research'), {
            ...args.$claude,
            prompt: `Research upgrading "${pkg}" to ${targetVersion}. Use web search / fetch tools
     (load them via ToolSearch if needed) to read the official changelog, release
     notes, and migration guide. Determine the installed major version from this
     repo's lockfile first, then enumerate every breaking change between it and
     the target — what it breaks and the official migration hint. Prioritize the
     package's own docs over blog posts.`,
            schema: RESEARCH_SCHEMA,
          })
          .then((result) => result.output),
      () =>
        ctx.claude
          .object(port.id('agent-2', 'impact'), {
            ...args.$claude,
            prompt: `Map this repository's usage of the package "${pkg}". Read the lockfile for
     the exact installed version. Find every file importing/requiring it, note
     WHICH of its APIs each file touches and how heavily. Identify wrappers or
     adapter modules that concentrate the usage (those make upgrades cheaper —
     say so). Do not read the package's own docs; only this repo.`,
            schema: IMPACT_SCHEMA,
          })
          .then((result) => result.output),
    ]);

    if (!research || !impact) {
      return {
        package: pkg,
        status: 'aborted',
        riskNotes: 'Analysis failed (research or impact agent unavailable) — no changes made.',
        rounds: 0,
        remaining: [],
      };
    }
    port.log(
      `${pkg}: ${impact.currentVersion} -> ${research.targetVersion}; ${research.breakingChanges.length} breaking changes, ${impact.usageSites.length} usage files`,
    );

    // --------------------------------------------------------------------------
    // Phase 2: Plan — the join. Kept as its own cheap agent (not folded into the
    // applier) so the plan is inspectable in the journal when things go wrong.
    // --------------------------------------------------------------------------

    port.phase('Plan');

    const plan = await ctx.claude
      .object(port.id('agent-3', 'plan'), {
        ...args.$claude,
        prompt: `Create an upgrade plan for "${pkg}" ${impact.currentVersion} -> ${research.targetVersion}.
   Breaking changes: ${JSON.stringify(research.breakingChanges, null, 2)}
   Our usage: ${JSON.stringify(impact.usageSites, null, 2)}
   Indirect exposure: ${impact.indirectExposure || 'none noted'}

   Cross-reference: which breaking changes actually hit our usage? Produce
   ordered steps for an applier agent (bump manifest, run install, then each
   code change grouped sensibly), riskNotes, and testFocus areas. If the
   intersection is empty, say riskLevel "trivial" with a two-step plan. If the
   upgrade looks unwise (e.g. half the codebase is on removed APIs), say
   "reconsider" and explain in riskNotes.`,
        schema: PLAN_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!plan || plan.riskLevel === 'reconsider') {
      return {
        package: pkg,
        from: impact.currentVersion,
        to: research.targetVersion,
        status: 'not-attempted',
        riskNotes: plan ? plan.riskNotes : 'planner unavailable',
        rounds: 0,
        remaining: plan ? plan.steps : [],
      };
    }

    // --------------------------------------------------------------------------
    // Phase 3: Apply — one agent executes the whole plan. Upgrades are not
    // parallelizable at this stage: the manifest bump, install, and code changes
    // form one dependent sequence.
    // --------------------------------------------------------------------------

    port.phase('Apply');

    await ctx.claude
      .text(port.id('agent-4', 'apply'), {
        ...args.$claude,
        prompt: `Execute this dependency-upgrade plan for "${pkg}" (${impact.currentVersion} -> ${research.targetVersion}).
   Steps: ${JSON.stringify(plan.steps, null, 2)}
   Risk notes: ${plan.riskNotes}
   Use the repository's own package manager (respect the lockfile format). Make
   the code changes the plan calls for. Do not run the full test suite — the
   stabilize loop handles that. Report what you did.`,
      })
      .then((result) => result.output);

    // --------------------------------------------------------------------------
    // Phase 4: Stabilize — the bounded fix loop. Each round: one global verify,
    // failures clustered by root cause, up to 3 parallel fixers on disjoint
    // clusters, re-verify. Bounded because an upgrade that won't converge in 3
    // rounds needs a human decision, not more agents.
    // --------------------------------------------------------------------------

    port.phase('Stabilize');

    let rounds = 0;
    let verification = null;

    while (rounds < maxFixRounds) {
      rounds++;
      verification = await ctx.claude
        .object(port.id('agent-5', `verify:r${rounds}`), {
          ...args.$claude,
          prompt: `Verify the "${pkg}" upgrade (round ${rounds}/${maxFixRounds}). Run the repo's
     build/typecheck and test suite (find the commands). Scrutinize especially:
     ${(plan.testFocus || []).join('; ') || 'all touched areas'}.
     Cluster failures by root cause — not one entry per failing test.`,
          schema: VERIFY_SCHEMA,
          // Original phase: 'Stabilize' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
      if (!verification || verification.passed) break;

      const clusters = verification.failures.slice(0, 3);
      if (verification.failures.length > 3)
        port.log(`Round ${rounds}: fixing top 3 of ${verification.failures.length} clusters`);
      await port.parallel(
        'parallel-2',
        clusters.map(
          (f, i) => () =>
            ctx.claude
              .text(port.id('agent-6', `fix:r${rounds}:${i}`), {
                ...args.$claude,
                prompt: `Fix this failure cluster caused by upgrading "${pkg}" to ${research.targetVersion}:
       ${f.description}
       Files: ${(f.files || []).join(', ') || 'identify from the failure'}
       Known breaking changes for reference: ${JSON.stringify(research.breakingChanges)}
       Fix forward (adopt the new API) rather than pinning back. Edit in place;
       run only the narrow check for this cluster.`,

                // Original phase: 'Stabilize' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      );
    }

    const green = Boolean(verification && verification.passed);
    return {
      package: pkg,
      from: impact.currentVersion,
      to: research.targetVersion,
      status: green ? 'upgraded' : 'unstable',
      riskNotes: plan.riskNotes,
      rounds,
      remaining: green ? [] : verification ? verification.failures : ['verifier unavailable'],
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

// project-bootstrap: control flow only. One canonical plan digest is approved before any write;
// each setter works in its own worktree; code integrates, verifies and publishes.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Applied, BootstrapInput, BootstrapOutput, Detected, PlanFor } from '../contracts.js';
import { assertClean, baseline, passed, verify } from '../lib/checks.js';
import { checkPlan, ownedChange, planDigest, preview } from '../lib/plan.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'project-bootstrap',
  version: 'packaged-03',
  description:
    'Approve one saved plan, isolate each setter, and verify its integration, settling command failures.',
  roster,
  prompts: [prompts],
  input: BootstrapInput,
  output: BootstrapOutput,
  async run(ctx, input) {
    await assertClean(ctx, 'clean');
    const { base, inventory } = await baseline(ctx);
    const detected = await ctx.roster.Surveyor.value('detect', {
      schema: Detected,
      prompt: prompts.Detect({ spec: input.spec, stack: input.stack ?? null, inventory }),
    });
    const plan = await ctx.roster.Planner.value('plan', {
      schema: PlanFor(input.concerns),
      prompt: prompts.Plan({ spec: input.spec, allowed: input.concerns, detected }),
    });
    checkPlan(plan);
    const approvedDigest = planDigest(plan);
    const result = { stack: detected.stack, plan, approvedDigest };
    const approval = await ctx.approve('approve-plan', {
      title: 'Bootstrap',
      prompt: 'Apply this exact plan and run its verification commands?',
      subject: { plan, digest: approvedDigest, base },
      details: preview(std.exec.json(plan)),
    });
    if (!approval.approved)
      return { ...result, status: 'declined', appliedDigest: null, commit: null, verification: [] };
    const changes = await ctx.map(
      'setters',
      plan.concerns,
      { concurrency: 3, key: (concern) => concern.name },
      async (concern) => {
        const applied = await ctx.roster.Setter.object('apply', {
          worktree: { base: { commit: base } },
          schema: Applied,
          prompt: prompts.Apply({ concern, digest: approvedDigest, plan: std.exec.json(plan) }),
        });
        return ownedChange(applied.worktree, concern);
      },
    );
    const merged = await ctx.merge('integrate', changes, { onConflict: 'fail' });
    const tree = await ctx.worktree('verification-tree', { base: { commit: merged.commit } });
    const verification = await verify(ctx, tree, plan.verifyCommands);
    const appliedDigest = planDigest(plan);
    if (!passed(verification))
      return {
        ...result,
        status: 'verification-failed',
        appliedDigest,
        commit: merged.commit,
        verification,
      };
    // Verification commands may create tracked artifacts; publish their managed snapshot too.
    const published = await ctx.merge('publish', [...changes, tree], {
      target: 'checkout',
      onConflict: 'fail',
    });
    return { ...result, status: 'applied', appliedDigest, commit: published.commit, verification };
  },
});

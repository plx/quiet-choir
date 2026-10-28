// feature-factory: control flow only. prd-decompose runs as a typed inline child and its tickets
// are the backlog; a planner groups them into disjoint modules under a call cap and a human
// approves the exact plan. Foundations build in order and features in parallel, each in its own
// worktree with its receipt checked against its areas. Every built module gets a deep-code-review
// child over its own snapshot, confirmed findings go to an isolated fixer, and code integrates the
// accepted changes, runs the operator's commands and publishes only a verified integration.
import { defineWorkflow, type WorktreeChange } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import deepCodeReview from '../../deep-code-review.quiet-choir/workflows/deep-code-review.js';
import prdDecompose from '../../prd-decompose.quiet-choir/workflows/prd-decompose.js';
import {
  FeatureFactoryInput,
  FeatureFactoryOutput,
  PlanFor,
  type Module,
  type ModuleRecord,
} from '../contracts.js';
import { assertClean, baseCommit, inventory, passed, verify } from '../lib/checks.js';
import {
  DECOMPOSE_REPAIRS,
  buildOrder,
  callBounds,
  canonicalPlan,
  digestOf,
  moduleLimit,
  preview,
  unbuildable,
} from '../lib/plan.js';
import {
  accepted,
  backlogOf,
  delegation,
  finalStatus,
  recordOf,
  repairOf,
  reviewOf,
} from '../lib/policy.js';
import { buildModule, repairModule, type Built } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'feature-factory',
  version: 'packaged-03',
  description:
    'Decompose a PRD as a child, build an approved disjoint module plan in worktrees, review each module as a child, repair, verify and publish.',
  roster,
  prompts: [prompts],
  children: [prdDecompose, deepCodeReview],
  input: FeatureFactoryInput,
  output: FeatureFactoryOutput,
  async run(ctx, input) {
    const bounds = callBounds(input);
    const limit = moduleLimit(input);

    ctx.phase('Decompose');
    await assertClean(ctx, 'clean');
    const base = await baseCommit(ctx);
    const backlog = await ctx.workflow(
      'decompose',
      prdDecompose,
      prdDecompose.input.parse({
        prd: input.prd,
        codebase: input.codebase,
        maxRepairs: DECOMPOSE_REPAIRS,
      }),
      { profiles: delegation.decompose },
    );
    const { tickets } = backlog;
    const report = {
      backlog: backlogOf(backlog),
      limits: { modules: limit, callsAdmitted: bounds.decompose },
      plan: null,
      modules: [],
      integrated: null,
      commit: null,
      verification: [],
    };
    // A conductor that assumed success would fabricate a build from nothing.
    if (!tickets.length) return { ...report, status: 'no-tickets' };

    ctx.phase('Plan modules');
    const planned = await ctx.roster.Planner.value('plan', {
      schema: PlanFor(tickets, limit),
      prompt: prompts.Plan({
        max: limit,
        tickets,
        sequencing: backlog.sequencing,
        openQuestions: backlog.openQuestions,
        ...(await inventory(ctx, base, 400)),
      }),
      retry: { maxAttempts: 2, on: ['schema'] },
    });
    const plan = canonicalPlan(planned);
    const text = std.exec.json(plan);
    const digest = digestOf(text);
    const limits = {
      modules: limit,
      callsAdmitted: bounds.decompose + bounds.plan + plan.modules.length * bounds.module,
    };
    const approval = await ctx.approve('approve-plan', {
      title: 'Module plan',
      prompt: 'Build exactly these modules in isolated checkouts and publish only if verified?',
      subject: { plan, digest, base, verifyCommands: input.verifyCommands, limits },
      details: preview(text),
    });
    const approved = { ...report, limits, plan: { ...plan, digest } };
    if (!approval.approved) return { ...approved, status: 'declined' };

    ctx.phase('Implement');
    const order = buildOrder(plan);
    const ticketsOf = (module: Module) =>
      tickets.filter((ticket) => module.ticketIds.includes(ticket.id));
    const work = { digest, plan: text };
    const modules: ModuleRecord[] = [];
    const changes: (WorktreeChange | null)[] = [];
    const landed = new Set<string>();
    const builtOn: string[] = [];
    const settle = (module: Module, outcome: Built, from: string) => {
      modules.push(recordOf(module, { ...outcome, base: from }));
      changes.push(outcome.change);
      if (!accepted(outcome)) return;
      for (const id of module.ticketIds) landed.add(id);
      if (module.isFoundation) builtOn.push(module.name);
    };
    // Foundations build in order, each on the last one that landed.
    let tip = base;
    const foundations = order.filter((module) => module.isFoundation);
    for (const [index, module] of foundations.entries()) {
      const skipped = unbuildable(module, tickets, landed);
      if (skipped) {
        modules.push(recordOf(module, { skipped }));
        changes.push(null);
        continue;
      }
      const builder = ctx.within(ctx.id('foundations', index)).roster.Builder;
      const outcome = await buildModule(builder, {
        ...work,
        module,
        tickets: ticketsOf(module),
        builtOn: [...builtOn],
        base: tip,
      });
      settle(module, outcome, tip);
      tip = outcome.change?.commit ?? tip;
    }
    // Every feature builds in parallel on the foundations; one that needs a missing one is skipped.
    const features = order.filter((module) => !module.isFoundation);
    const skips = features.map((module) => unbuildable(module, tickets, landed));
    const buildable = features.filter((_, index) => !skips[index]);
    // `version` names what the mapper's source does not show: buildModule, its prompt and schema.
    const results = await ctx.map(
      'features',
      buildable,
      { concurrency: Math.max(1, buildable.length), onError: 'return', version: 'build/1' },
      (module) =>
        buildModule(ctx.roster.Builder, {
          ...work,
          module,
          tickets: ticketsOf(module),
          builtOn,
          base: tip,
        }),
    );
    let next = 0;
    for (const [index, module] of features.entries()) {
      const skipped = skips[index];
      const result = skipped ? undefined : results[next++];
      if (result?.ok) settle(module, result.value, tip);
      else {
        const failed = `Build failed: ${result?.error.message.slice(0, 500) ?? 'no outcome'}`;
        modules.push(recordOf(module, skipped ? { skipped } : { failed }));
        changes.push(null);
      }
    }

    ctx.phase('Review');
    // Each module's review reads only its own change: its snapshot against the commit it built on.
    const built = modules.flatMap((record, index) => {
      const change = changes[index];
      return change?.commit
        ? [{ index, base: change.base, head: change.commit, paths: record.fileAreas }]
        : [];
    });
    const reviews = await ctx.map(
      'reviews',
      built,
      { concurrency: 2, onError: 'return', version: 'review/1' },
      ({ base, head, paths }) =>
        ctx.workflow(
          'review',
          deepCodeReview,
          deepCodeReview.input.parse({
            base,
            head,
            paths,
            dimensions: input.dimensions,
            maxFindings: input.maxFindings,
          }),
          { profiles: delegation.review },
        ),
    );
    const fixes = built.flatMap(({ index, head }, slot) => {
      const review = reviews[slot];
      const record = modules[index];
      if (!record) return [];
      record.review = reviewOf(review);
      return review?.ok && review.value.confirmed.length
        ? [{ index, commit: head, module: record, findings: review.value.confirmed }]
        : [];
    });

    ctx.phase('Stabilize');
    // Confirmed findings were adversarially verified by the child: repair, do not re-judge.
    const repairs = await ctx.map(
      'repairs',
      fixes.map(({ commit, module, findings }) => ({
        commit,
        module: { name: module.name, fileAreas: module.fileAreas },
        findings,
      })),
      { concurrency: 4, onError: 'return', version: 'fix/1' },
      (item) => repairModule(ctx.roster.Fixer, item),
    );
    fixes.forEach(({ index }, slot) => {
      const record = modules[index];
      if (record) record.repair = repairOf(repairs[slot]);
    });
    const fixed = repairs.flatMap((repair) =>
      repair.ok && repair.value.change ? [repair.value.change] : [],
    );
    const integrable = [...changes.filter((change) => change !== null), ...fixed];
    const result = { ...approved, modules };
    if (!integrable.length) return { ...result, status: 'nothing-built' };
    const integrated = await ctx.merge('integrate', integrable, { onConflict: 'fail' });
    const tree = await ctx.worktree('verification-tree', { base: { commit: integrated.commit } });
    const verification = await verify(ctx, tree, input.verifyCommands);
    const checked = { ...result, integrated: integrated.commit, verification };
    if (!passed(verification)) return { ...checked, status: 'verification-failed' };
    const published = await ctx.merge('publish', integrable, {
      target: 'checkout',
      onConflict: 'fail',
    });
    return {
      ...checked,
      status: finalStatus(backlog.status, modules, plan.deferred.length),
      commit: published.commit,
    };
  },
});

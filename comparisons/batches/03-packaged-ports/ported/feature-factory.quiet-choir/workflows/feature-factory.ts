// feature-factory: control flow only. prd-decompose runs as a typed inline child and its tickets
// are the backlog; a planner groups them into disjoint modules under a call cap and a human
// approves the exact plan. Foundations build in order and features in parallel, each in its own
// worktree with its receipt checked against its areas. Every built module gets a deep-code-review
// child over its own snapshot, confirmed findings go to an isolated fixer, and code integrates the
// accepted changes, runs the operator's commands and publishes only a verified integration.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import deepCodeReview from '../../deep-code-review.quiet-choir/workflows/deep-code-review.js';
import prdDecompose from '../../prd-decompose.quiet-choir/workflows/prd-decompose.js';
import { FeatureFactoryInput, FeatureFactoryOutput, PlanFor, type Module } from '../contracts.js';
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
  backlogOf,
  builtOn,
  changeOf,
  delegation,
  finalStatus,
  landed,
  recordOf,
  repairOf,
  reviewOf,
  settleFeatures,
  type Outcome,
} from '../lib/policy.js';
import { buildModule, repairModule } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'feature-factory',
  version: 'packaged-03',
  description:
    'Decompose a PRD as a child, build an approved disjoint module plan in worktrees, review each module as a child, repair, verify and publish.',
  phases: [
    { title: 'Decompose', detail: 'prd-decompose child -> ticketed backlog' },
    { title: 'Plan modules', detail: 'disjoint, ordered modules under the call cap; approved' },
    { title: 'Implement', detail: 'foundations in order, then features in parallel, in worktrees' },
    { title: 'Review', detail: 'one deep-code-review child per built module' },
    { title: 'Stabilize', detail: 'isolated repairs, integration, verification, publication' },
  ],
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
      limits: { modules: limit, callsAdmitted: bounds.decompose, unlistedFiles: null },
      plan: null,
      modules: [],
      integrated: null,
      commit: null,
      verification: [],
    };
    // A conductor that assumed success would fabricate a build from nothing.
    if (!tickets.length) return { ...report, status: 'no-tickets' };

    ctx.phase('Plan modules');
    const files = await inventory(ctx, base, 400);
    const planned = await ctx.roster.Planner.value('plan', {
      schema: PlanFor(tickets, limit),
      prompt: prompts.Plan({
        max: limit,
        tickets,
        sequencing: backlog.sequencing,
        openQuestions: backlog.openQuestions,
        ...files,
      }),
      retry: { maxAttempts: 2, on: ['schema'] },
    });
    const plan = canonicalPlan(planned);
    const text = std.exec.json(plan);
    const digest = digestOf(text);
    const limits = {
      modules: limit,
      callsAdmitted: bounds.decompose + bounds.plan + plan.modules.length * bounds.module,
      unlistedFiles: files.omitted,
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
    const job = (module: Module, from: string, outcomes: Outcome[]) => ({
      digest,
      plan: text,
      module,
      tickets: tickets.filter((ticket) => module.ticketIds.includes(ticket.id)),
      builtOn: builtOn(order, outcomes),
      base: from,
    });
    // Foundations build in order, each on the last one that landed.
    const outcomes: Outcome[] = [];
    let tip = base;
    for (const [index, module] of order.filter((each) => each.isFoundation).entries()) {
      const skipped = unbuildable(module, tickets, landed(order, outcomes));
      const builder = ctx.within(ctx.id('foundations', index)).roster.Builder;
      const outcome = skipped
        ? { skipped }
        : { ...(await buildModule(builder, job(module, tip, outcomes))), base: tip };
      outcomes.push(outcome);
      tip = changeOf(outcome)?.commit ?? tip;
    }
    // Every feature builds in parallel on the foundations; one that needs a missing one is skipped.
    const features = order.filter((module) => !module.isFoundation);
    const skips = features.map((module) => unbuildable(module, tickets, landed(order, outcomes)));
    // `version` names what the mapper's source does not show: buildModule, its prompt and schema.
    const results = await ctx.map(
      'features',
      features.filter((_, index) => !skips[index]),
      { concurrency: features.length || 1, onError: 'return', version: 'build/1' },
      (module) => buildModule(ctx.roster.Builder, job(module, tip, outcomes)),
    );
    outcomes.push(...settleFeatures(skips, results, tip));
    const modules = order.map((module, index) => recordOf(module, outcomes[index]));
    const changes = outcomes.map(changeOf);

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

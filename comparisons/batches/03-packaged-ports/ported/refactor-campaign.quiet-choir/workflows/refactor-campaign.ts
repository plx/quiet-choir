// refactor-campaign: control flow only. Survey and rank, then pin every chosen target with a
// characterization net that code proves green on the current code (a settled map). Report-only
// integrates the nets into a run-owned ref. With apply, a human approves the exact goal and plan,
// refactors run one at a time behind every net, code discards any that touches a net, turns a net
// or verify command red or that the reviewer judges behavioral, and publishes after a final
// verification only onto the checkout the run started from.
import { defineWorkflow, type WorktreeChange } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { RankingFor, RefactorInput, RefactorOutput, Survey } from '../contracts.js';
import { assertClean, baseCommit, netArgv, passed, stillAt, verify } from '../lib/checks.js';
import {
  choose,
  planDigest,
  planned,
  preview,
  settleNets,
  summarize,
  uniqueTargets,
} from '../lib/policy.js';
import { pinNet, refactorTarget } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'refactor-campaign',
  version: 'packaged-03',
  description:
    'Pin each ranked target with a code-verified characterization net, then refactor behind every net only after approval.',
  roster,
  prompts: [prompts],
  input: RefactorInput,
  output: RefactorOutput,
  async run(ctx, input) {
    const finish = (output: Omit<RefactorOutput, 'summary'>): RefactorOutput => ({
      ...output,
      summary: summarize(output),
    });
    if (input.apply) await assertClean(ctx, 'clean');
    const base = await baseCommit(ctx);
    const survey = await ctx.roster.Surveyor.value('survey', {
      schema: Survey,
      prompt: prompts.Survey({ scope: input.scope, goal: input.goal }),
    });
    const targets = uniqueTargets(survey.targets);
    const report = {
      refactored: [],
      netOnly: [],
      skipped: [],
      failedNets: 0,
      failedCalls: 0,
      netsCommit: null,
      approvedDigest: null,
      commit: null,
      verification: [],
    };
    if (!targets.length) return finish({ ...report, status: 'no-targets', deferred: [] });
    const ranking = await ctx.roster.Ranker.value('rank', {
      schema: RankingFor(targets, input.maxTargets),
      prompt: prompts.Rank({ targets, maxTargets: input.maxTargets }),
    });
    const { chosen, deferred } = choose(targets, ranking.ranked);
    if (!chosen.length) return finish({ ...report, status: 'no-targets', deferred });
    // A failed writer is journaled and its target skipped. `version` names what the mapper's source
    // does not show: pinNet in lib/stages.ts, its prompt and its schemas.
    const pinned = await ctx.map(
      'nets',
      chosen,
      { concurrency: 3, onError: 'return', version: 'pin-net/2' },
      (target) =>
        pinNet(ctx, {
          team: { writer: ctx.roster.NetWriter },
          target,
          base,
          testCommand: input.testCommand,
          rounds: input.netRounds,
        }),
    );
    const { green, skipped, failedNets } = settleNets(chosen, pinned);
    const result = { ...report, deferred, skipped, failedNets };
    if (!green.length) return finish({ ...result, status: 'no-nets' });
    const nets = await ctx.merge(
      'integrate-nets',
      green.map((net) => net.change),
      { onConflict: 'fail' },
    );
    const plan = green.map(planned);
    const pinnedOnly = (why: string) => plan.map((entry) => ({ ...entry, why }));
    const withNets = { ...result, netsCommit: nets.commit };
    if (!input.apply)
      return finish({
        ...withNets,
        status: 'report',
        netOnly: pinnedOnly('apply is false; refactor not performed'),
      });
    // The human approves the goal and the plan together, and every refactorer receives this text.
    const approved = { goal: input.goal, targets: plan };
    const text = std.exec.json(approved);
    const approvedDigest = planDigest(text);
    const approval = await ctx.approve('approve-refactors', {
      title: 'Refactors',
      prompt:
        'Refactor these targets behind their green nets, publishing only if every check passes?',
      subject: { ...approved, digest: approvedDigest, nets: nets.commit },
      details: preview(text),
    });
    if (!approval.approved)
      return finish({
        ...withNets,
        status: 'declined',
        approvedDigest,
        netOnly: pinnedOnly('plan declined'),
      });
    // Serial, so each refactor runs behind every net and on top of the refactors kept before it.
    let current = nets.commit;
    let failedCalls = 0;
    const kept: WorktreeChange[] = [];
    const refactored: RefactorOutput['refactored'] = [];
    const netOnly: RefactorOutput['netOnly'] = [];
    for (const [index, net] of green.entries()) {
      const outcome = await ctx.scope(ctx.id('refactor', index), () =>
        refactorTarget(ctx, {
          team: { refactorer: ctx.roster.Refactorer, reviewer: ctx.roster.Reviewer },
          target: net.target,
          goal: input.goal,
          from: current,
          net,
          nets: green.map((entry) => entry.netFile),
          protectedFiles: green.flatMap((entry) => entry.files),
          testCommand: input.testCommand,
          verifyCommands: input.verifyCommands,
          digest: approvedDigest,
          approved: text,
        }),
      );
      if (outcome.kept) {
        current = outcome.change.commit;
        kept.push(outcome.change);
        const { files, review, reviewedWhole } = outcome;
        refactored.push({ ...planned(net), commit: current, files, review, reviewedWhole });
      } else {
        failedCalls += outcome.failed ? 1 : 0;
        netOnly.push({ ...planned(net), why: outcome.why });
      }
    }
    const tree = await ctx.worktree('verification-tree', { base: { commit: current } });
    const verification = await verify(ctx, tree, [
      ...green.map((net) => netArgv(input.testCommand, net.netFile)),
      ...input.verifyCommands,
    ]);
    const done = { ...withNets, approvedDigest, refactored, netOnly, failedCalls, verification };
    if (!passed(verification))
      return finish({ ...done, status: 'verification-failed', commit: current });
    if (!(await stillAt(ctx, 'head', base)))
      return finish({ ...done, status: 'checkout-moved', commit: current });
    const published = await ctx.merge('publish', [...green.map((net) => net.change), ...kept], {
      target: 'checkout',
      onConflict: 'fail',
    });
    return finish({
      ...done,
      status: refactored.length ? 'applied' : 'nets-only',
      commit: published.commit,
    });
  },
});

// refactor-campaign: control flow only. An apply run first refuses a dirty checkout. Survey and
// rank, then pin every chosen target with a characterization net that code proves green on the
// current code (a settled map), integrate the nets into a run-owned commit and run every net and
// verify command on it. Report-only stops there. With apply, a human approves the exact goal and
// plan, refactors run one at a time behind every net, each on the last kept result, and code
// discards any that touches a net, turns a net or verify command red or that the reviewer judges
// behavioral. Code verifies the integration of the nets and the kept refactors and publishes it
// only onto the checkout the run started from; every merge is settled, so a commit made during the
// run or a dirty checkout ends with a status and the commit left to merge.
import { defineWorkflow, type WorktreeChange } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { RankingFor, RefactorInput, RefactorOutput, Survey } from '../contracts.js';
import {
  baseCommit,
  dirtyFiles,
  netArgv,
  passed,
  refused,
  stillAt,
  verifyAt,
} from '../lib/checks.js';
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
    const empty = {
      refactored: [],
      netOnly: [],
      skipped: [],
      deferred: [],
      duplicateTargets: 0,
      failedNets: 0,
      failedCalls: 0,
      truncatedRepairFiles: 0,
      netsCommit: null,
      approvedDigest: null,
      commit: null,
      refusal: null,
      baseline: [],
      verification: [],
    };
    // The publish needs a clean checkout, so an apply run refuses a dirty one before any agent.
    const dirty = input.apply ? await dirtyFiles(ctx, 'clean') : null;
    if (dirty)
      return finish({
        ...empty,
        status: 'dirty-checkout',
        refusal: { step: 'clean', message: dirty },
      });
    const base = await baseCommit(ctx);
    const survey = await ctx.roster.Surveyor.value('survey', {
      schema: Survey,
      prompt: prompts.Survey({ scope: input.scope, goal: input.goal }),
    });
    const { targets, duplicates } = uniqueTargets(survey.targets);
    const report = { ...empty, duplicateTargets: duplicates };
    if (!targets.length) return finish({ ...report, status: 'no-targets' });
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
      { concurrency: 3, onError: 'return', version: 'pin-net/4' },
      (target) =>
        pinNet(ctx, {
          team: { writer: ctx.roster.NetWriter },
          target,
          base,
          testCommand: input.testCommand,
          rounds: input.netRounds,
        }),
    );
    const { green, skipped, ...counts } = settleNets(chosen, pinned);
    const result = { ...report, deferred, skipped, ...counts };
    if (!green.length) return finish({ ...result, status: 'no-nets' });
    const plan = green.map(planned);
    const pinnedOnly = (why: string) => plan.map((entry) => ({ ...entry, why }));
    const netRuns = green.map((net) => netArgv(input.testCommand, net.netFile));
    // The nets add distinct files, so a commit made meanwhile is what can make them refuse to merge.
    const nets = await ctx.merge(
      'integrate-nets',
      green.map((net) => net.change),
      { onConflict: 'fail', onError: 'return' },
    );
    if (!nets.ok)
      return finish({
        ...result,
        ...(await refused(ctx, 'integrate-nets', base, nets.error)),
        netOnly: pinnedOnly('the nets did not integrate'),
      });
    const netsCommit = nets.value.commit;
    // Every net and verify command must pass on the nets together, so that a red one later is a
    // refactor's: each net was proven green alone, on its own writer's snapshot.
    const baseline = await verifyAt(ctx, 'baseline', netsCommit, [
      ...netRuns,
      ...input.verifyCommands,
    ]);
    const withNets = { ...result, netsCommit, baseline };
    if (!passed(baseline))
      return finish({
        ...withNets,
        status: 'baseline-red',
        netOnly: pinnedOnly('a net or verify command fails on the nets commit'),
      });
    if (!input.apply)
      return finish({
        ...withNets,
        status: 'report',
        netOnly: pinnedOnly('apply is false; refactor not performed'),
      });
    // A checkout that has moved cannot receive the publish, so stop before paying for refactors.
    if (!(await stillAt(ctx, ctx.id('head', 'approve'), base)))
      return finish({
        ...withNets,
        status: 'checkout-moved',
        commit: netsCommit,
        netOnly: pinnedOnly('the checkout moved before the approval'),
      });
    // The human approves the goal and the plan together, and every refactorer receives this text.
    const approved = { goal: input.goal, targets: plan };
    const text = std.exec.json(approved);
    const approvedDigest = planDigest(text);
    const approval = await ctx.approve('approve-refactors', {
      title: 'Refactors',
      prompt:
        'Refactor these targets behind their green nets, publishing only if every check passes?',
      subject: { ...approved, digest: approvedDigest, nets: netsCommit, baseline },
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
    let current = netsCommit;
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
    const done = { ...withNets, approvedDigest, refactored, netOnly, failedCalls };
    // The gate runs on exactly what the checkout would receive: the nets and the kept refactors.
    // ctx.merge integrates onto the checkout's HEAD of the moment, so a commit made during the
    // approval or the refactors is in this integration (and stillAt below refuses to publish it),
    // or conflicts with it; then `current`, every net and verify command green on it, is left.
    const changes = [...green.map((net) => net.change), ...kept];
    const integrated = await ctx.merge('integrate', changes, {
      onConflict: 'fail',
      onError: 'return',
    });
    if (!integrated.ok)
      return finish({
        ...done,
        ...(await refused(ctx, 'integrate', base, integrated.error)),
        commit: current,
      });
    const verification = await verifyAt(ctx, 'verification', integrated.value.commit, [
      ...netRuns,
      ...input.verifyCommands,
    ]);
    const unpublished = { ...done, verification, commit: integrated.value.commit };
    if (!passed(verification)) return finish({ ...unpublished, status: 'verification-failed' });
    if (!(await stillAt(ctx, ctx.id('head', 'publish'), base)))
      return finish({ ...unpublished, status: 'checkout-moved' });
    // stillAt is recorded, so a resume replays it; a refused publish (a dirty checkout, or one that
    // moved since) therefore settles as a result instead of failing the run to be resumed.
    const published = await ctx.merge('publish', changes, {
      target: 'checkout',
      onConflict: 'fail',
      onError: 'return',
    });
    if (!published.ok)
      return finish({ ...unpublished, ...(await refused(ctx, 'publish', base, published.error)) });
    return finish({
      ...unpublished,
      status: refactored.length ? 'applied' : 'nets-only',
      commit: published.value.commit,
    });
  },
});

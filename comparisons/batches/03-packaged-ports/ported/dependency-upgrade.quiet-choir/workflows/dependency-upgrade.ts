// dependency-upgrade: control flow only. Code pins the base and finds the manifest lines and the
// files that name the package; a web researcher and a usage analyst run in parallel, a planner
// joins their results and a human approves the exact plan. One upgrader applies it in its own
// worktree. Each round, code installs and verifies the integrated commit in a fresh checkout; on
// red, a triager clusters the failures and up to three fixers repair disjoint files. Code
// publishes only a green tree whose changes the plan allows, onto a checkout that has not moved.
import { defineWorkflow, type WorktreeChange, type WorktreeHandle } from 'quiet-choir';
import {
  Applied,
  Clusters,
  Impact,
  Plan,
  Research,
  UpgradeInput,
  UpgradeOutput,
  type Round,
} from '../contracts.js';
import { assertClean, changedFiles, evidence, headCommit, mentions } from '../lib/git.js';
import {
  FIXERS_PER_ROUND,
  allowedFiles,
  assign,
  capEvidence,
  classify,
  digestOf,
  failing,
  outsidePlan,
  owned,
  planText,
  preview,
  reported,
  settleFixes,
  usageFiles,
} from '../lib/policy.js';
import { fixCluster } from '../lib/stages.js';
import { verifyCommit } from '../lib/verify.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'dependency-upgrade',
  version: 'packaged-03',
  description:
    'Research and map an upgrade in parallel, approve one plan, and publish it only after code-run verification and bounded repair rounds.',
  roster,
  prompts: [prompts],
  input: UpgradeInput,
  output: UpgradeOutput,
  async run(ctx, input) {
    const { manifests, installCommand, verifyCommands } = input;
    const install = installCommand?.join(' ') ?? null;

    ctx.phase('Analyze');
    await assertClean(ctx, 'clean');
    const base = await headCommit(ctx, 'base');
    const hits = await mentions(ctx, 'usage', base, input.package);
    const { mapped, unmapped } = usageFiles(hits, manifests, input.maxUsageFiles);
    const found = capEvidence(await evidence(ctx, 'evidence', base, input.package, manifests));
    const facts = { package: input.package, manifests, ...found };
    // The plan is a join of what changed and what we use, so both halves meet at this barrier.
    const [research, impact] = await Promise.all([
      ctx.roster.Researcher.value('research', {
        schema: Research,
        prompt: prompts.Research({ ...facts, toVersion: input.toVersion }),
      }),
      ctx.roster.Analyst.value('impact', {
        schema: Impact,
        prompt: prompts.Impact({ ...facts, files: mapped, unmapped: unmapped.length }),
      }),
    ]);
    const upgrade = {
      package: input.package,
      from: impact.currentVersion,
      to: research.targetVersion,
    };
    const breaking = research.breakingChanges;
    const { sites, unclassified } = classify(mapped, impact);
    ctx.log(
      `${upgrade.package}: ${upgrade.from} -> ${upgrade.to}; ${String(breaking.length)} breaking changes, ${String(sites.length)} usage files`,
    );

    ctx.phase('Plan');
    const plan = await ctx.roster.Planner.value('plan', {
      schema: Plan,
      prompt: prompts.Plan({
        ...upgrade,
        breaking,
        usage: impact.usageSites,
        exposure: impact.indirectExposure,
        manifests,
        install,
        verify: verifyCommands.map((argv) => argv.join(' ')),
      }),
    });
    const report = {
      ...upgrade,
      riskLevel: plan.riskLevel,
      riskNotes: plan.riskNotes,
      breakingChanges: breaking,
      usage: { sites, unclassified, unmapped, evidenceOmitted: found.evidenceOmitted },
      approvedDigest: null,
      rounds: 0,
      verification: [],
      remaining: [],
      refusal: null,
      commit: null,
    };
    if (plan.riskLevel === 'reconsider')
      return { ...report, status: 'not-attempted', remaining: plan.steps };
    const text = planText(upgrade, plan);
    const approvedDigest = digestOf(text);
    const allowed = allowedFiles(plan, manifests);
    const approval = await ctx.approve('approve-upgrade', {
      title: 'Upgrade',
      prompt: 'Apply this exact upgrade plan in isolated checkouts, publishing only if verified?',
      subject: {
        ...upgrade,
        plan,
        digest: approvedDigest,
        base,
        allowed,
        installCommand,
        verifyCommands,
      },
      details: preview(text),
    });
    if (!approval.approved) return { ...report, status: 'declined', approvedDigest };
    const approved = { ...report, approvedDigest };

    ctx.phase('Apply');
    // One upgrader: the manifest bump and the code changes form one dependent sequence.
    const applied = await ctx.roster.Upgrader.object('apply', {
      worktree: { base: { commit: base } },
      schema: Applied,
      prompt: prompts.Apply({ ...upgrade, install, digest: approvedDigest, plan: text }),
    });
    const verdict = owned(applied.worktree, allowed);
    if ('refused' in verdict)
      return { ...approved, status: 'refused', refusal: `Upgrader ${verdict.refused}` };
    if (!verdict.change) return { ...approved, status: 'unchanged', remaining: plan.steps };

    ctx.phase('Stabilize');
    const changes: WorktreeChange[] = [verdict.change];
    let commit = (await ctx.merge('integrate', changes, { onConflict: 'fail' })).commit;
    const verification: Round[] = [];
    let green: WorktreeHandle | null = null;
    // Each round verifies once; a red round triages and fixes unless it is the last. A round whose
    // fixers change nothing stops early: verifying the same commit again would not converge.
    for (let round = 0; green === null; round++) {
      const step = await ctx.scope(ctx.id('round', round), async () => {
        const pass = await verifyCommit(ctx, {
          commit,
          install: installCommand,
          commands: verifyCommands,
        });
        const checked = { commit, install: pass.install, checks: pass.checks, passed: pass.passed };
        if (pass.passed || round >= input.maxFixRounds)
          return { record: { ...checked, clusters: [] }, tree: pass.tree, next: null };
        const triage = await ctx.roster.Triager.value('triage', {
          worktree: pass.tree,
          schema: Clusters,
          prompt: prompts.Triage({
            ...upgrade,
            breaking,
            testFocus: plan.testFocus,
            allowed,
            failures: pass.failures,
          }),
        });
        const { fixing, skipped } = assign(triage.clusters, allowed);
        // `version` names what the mapper's source does not show: fixCluster, its prompt and schema.
        const results = await ctx.map(
          'fixes',
          fixing,
          { concurrency: FIXERS_PER_ROUND, onError: 'return', version: 'fix/1' },
          (cluster) =>
            fixCluster(ctx.roster.Fixer, {
              upgrade,
              breaking,
              cluster,
              commit,
              failures: pass.failures,
              digest: approvedDigest,
              plan: text,
            }),
        );
        const outcomes = settleFixes(fixing, results);
        const fixes = outcomes.flatMap((outcome) => (outcome.change ? [outcome.change] : []));
        const record = { ...checked, clusters: [...outcomes.map(reported), ...skipped] };
        if (!fixes.length) return { record, tree: pass.tree, next: null };
        changes.push(...fixes);
        // Fixers own disjoint files of the same commit, so their changes cannot conflict.
        const merged = await ctx.merge('integrate', changes, { onConflict: 'fail' });
        return { record, tree: pass.tree, next: merged.commit };
      });
      verification.push(step.record);
      if (step.record.passed) green = step.tree;
      else if (step.next === null) break;
      else commit = step.next;
    }
    const stabilized = { ...approved, rounds: verification.length, verification };
    const last = verification.at(-1);
    if (green === null || !last)
      return { ...stabilized, status: 'unstable', remaining: last ? failing(last) : [], commit };

    ctx.phase('Publish');
    // ctx.merge rebases onto the checkout's current HEAD, so a checkout that moved since the base
    // would receive a tree no command verified.
    if ((await headCommit(ctx, 'head')) !== base)
      return { ...stabilized, status: 'base-moved', commit };
    // The green tree holds what the install and verification commands changed, such as the
    // lockfile; its handle has no receipt, so code diffs the integration against the base.
    const verified = await ctx.merge('verified', [...changes, green], { onConflict: 'fail' });
    const stray = outsidePlan(
      await changedFiles(ctx, 'verified-files', base, verified.commit),
      allowed,
    );
    if (stray.length)
      return {
        ...stabilized,
        status: 'refused',
        refusal: `Verification left changes outside the plan: ${stray.join(', ')}`,
        commit: verified.commit,
      };
    const published = await ctx.merge('publish', [...changes, green], {
      target: 'checkout',
      onConflict: 'fail',
      strategy: 'squash',
      commit: { message: `Upgrade ${upgrade.package} from ${upgrade.from} to ${upgrade.to}` },
    });
    return { ...stabilized, status: 'upgraded', commit: published.commit };
  },
});

// api-migration: control flow only. Code pins the base and searches it for the old API, one
// discoverer groups the call sites into disjoint file groups, code plans them and a human approves
// the exact plan. Migrators run in waves of settled maps, each in its own worktree with its receipt
// checked against its files; a wave that lands nothing stops the run. Code integrates the changes,
// runs the operator's commands and the leftover search once, gives at most three triaged clusters
// one repair round, verifies again, and publishes only a verified integration.
import { defineWorkflow, type WorktreeChange } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Clusters,
  MigrationInput,
  MigrationOutput,
  Sites,
  type ClusterOutcome,
  type Round,
} from '../contracts.js';
import {
  assertClean,
  baseCommit,
  mentions,
  sameTree,
  tracked,
  verifyRound,
} from '../lib/checks.js';
import {
  REPAIR_CLUSTERS,
  capClusters,
  complete,
  coverage,
  digestOf,
  fixes,
  inScope,
  landed,
  notesFor,
  planGroups,
  preview,
  reported,
  settleGroups,
  settleRepairs,
  split,
} from '../lib/policy.js';
import { migrateGroup, repairCluster } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'api-migration',
  version: 'packaged-03',
  description:
    'Approve a disjoint migration plan, migrate each group in its own worktree, and publish only a code-verified integration.',
  roster,
  prompts: [prompts],
  input: MigrationInput,
  output: MigrationOutput,
  async run(ctx, input) {
    const finish = (report: Omit<MigrationOutput, 'notes'>, detail = ''): MigrationOutput => ({
      ...report,
      notes: `${notesFor(report)}${detail}`,
    });
    const { from, to, searchTerms: terms, batchSize } = input;
    const migration = { from, to, notes: input.notes ?? null };

    ctx.phase('Discover');
    await assertClean(ctx, 'clean');
    const base = await baseCommit(ctx);
    const inventory = inScope(await tracked(ctx, 'inventory', base), input.paths);
    const hits = terms.length ? inScope(await mentions(ctx, 'hits', base, terms), input.paths) : [];
    const sites = await ctx.roster.Discoverer.value('discover', {
      schema: Sites,
      prompt: prompts.Discover({ ...migration, paths: input.paths, terms, hits }),
    });
    const plan = planGroups(sites.groups, inventory, input.maxGroups);
    const { unassigned, excused } = coverage(
      hits,
      [...plan.groups, ...plan.deferred],
      sites.unchanged,
    );
    const report = {
      totalSites: plan.groups.reduce((sum, group) => sum + group.siteCount, 0),
      coalesced: plan.coalesced,
      stray: plan.stray,
      deferred: plan.deferred.map((group) => group.files),
      unassigned,
      excused,
      approvedDigest: null,
      migrated: [],
      failed: [],
      unattempted: [],
      verification: [],
      clusters: [],
      commit: null,
    };
    if (!plan.groups.length) return finish({ ...report, status: 'nothing-to-migrate' });
    ctx.log(`${String(report.totalSites)} call sites across ${String(plan.groups.length)} groups`);
    const text = std.exec.json({ ...migration, groups: plan.groups });
    const approvedDigest = digestOf(text);
    const approval = await ctx.approve('approve-migration', {
      title: 'Migration',
      prompt:
        'Migrate exactly these file groups in isolated checkouts, publishing only if verified?',
      subject: {
        ...migration,
        digest: approvedDigest,
        base,
        groups: plan.groups,
        verifyCommands: input.verifyCommands,
        deferred: report.deferred,
        unassigned,
      },
      details: preview(text),
    });
    if (!approval.approved) return finish({ ...report, status: 'declined', approvedDigest });

    ctx.phase('Transform');
    const approved = { ...migration, digest: approvedDigest, plan: text };
    const outcomes: ReturnType<typeof settleGroups> = [];
    let unattempted: string[][] = [];
    for (let wave = 0; wave * batchSize < plan.groups.length; wave++) {
      const groups = plan.groups.slice(wave * batchSize, (wave + 1) * batchSize);
      ctx.log(`Wave ${String(wave + 1)}: migrating ${String(groups.length)} file groups`);
      // `version` names what the mapper's source does not show: migrateGroup, its prompt, schema.
      const results = await ctx.map(
        ctx.id('wave', wave),
        groups,
        { concurrency: batchSize, onError: 'return', version: 'migrate/1' },
        (group) => migrateGroup(ctx.roster.Migrator, { ...approved, group, base }),
      );
      const settled = settleGroups(groups, results);
      outcomes.push(...settled);
      // A wave that lands nothing suggests the notes are wrong: do not spend the later waves.
      if (!settled.some(landed)) {
        unattempted = plan.groups.slice((wave + 1) * batchSize).map((group) => group.files);
        break;
      }
    }
    const { migrated, failed, changes } = split(outcomes);
    const attempted = { ...report, approvedDigest, migrated, failed, unattempted };
    if (!changes.length) return finish({ ...attempted, status: 'nothing-migrated' });

    ctx.phase('Verify');
    const integrated = await ctx.merge('integrate', changes, { onConflict: 'fail' });
    const done = migrated.filter((group) => group.status === 'migrated').flatMap((g) => g.files);
    const pass = (round: number, commit: string) =>
      ctx.scope(ctx.id('verify', round), () =>
        verifyRound(ctx, { commit, commands: input.verifyCommands, terms, migrated: done }),
      );
    const first = await pass(0, integrated.commit);
    const verification: Round[] = [first.round];
    let clusters: ClusterOutcome[] = [];
    let publishable: WorktreeChange[] = changes;
    if (!first.round.passed) {
      const { leftovers } = first.round;
      const { failures } = first;
      const triage = await ctx.roster.Triager.value('triage', {
        schema: Clusters,
        prompt: prompts.Triage({ ...migration, migrated, unmigrated: failed, leftovers, failures }),
      });
      const { repairing, skipped } = capClusters(triage.clusters);
      const allowed = plan.groups.flatMap((group) => group.files);
      const results = await ctx.map(
        'repairs',
        repairing,
        { concurrency: REPAIR_CLUSTERS, onError: 'return', version: 'repair/1' },
        (cluster) =>
          repairCluster(ctx.roster.Repairer, {
            ...approved,
            cluster,
            commit: integrated.commit,
            allowed,
            leftovers,
            failures,
          }),
      );
      let repairs = settleRepairs(repairing, results);
      if (fixes(repairs).length) {
        // Parallel repairs can collide; a conflicting one is dropped, never published.
        const repaired = await ctx.merge('integrate-repairs', [...changes, ...fixes(repairs)], {
          onConflict: 'report',
        });
        const conflicts = repaired.conflicts.map((conflict) => conflict.commit);
        repairs = settleRepairs(repairing, results, conflicts);
        verification.push((await pass(1, repaired.commit)).round);
        publishable = [...changes, ...fixes(repairs)];
      }
      clusters = [...repairs.map(reported), ...skipped];
    }
    const last = verification.at(-1) ?? first.round;
    const verified = { ...attempted, verification, clusters };
    if (!last.passed)
      return finish({ ...verified, status: 'verification-failed', commit: last.commit });

    const published = await ctx.merge('publish', publishable, {
      target: 'checkout',
      onConflict: 'fail',
      onError: 'return',
    });
    if (!published.ok)
      return finish(
        { ...verified, status: 'publish-failed', commit: last.commit },
        ` ${published.error.message}`,
      );
    const { commit } = published.value;
    // A checkout that moved after verification publishes a tree nobody verified; say so.
    const same = await sameTree(ctx, 'published-tree', last.commit, commit);
    const status = !same ? 'unverified-publish' : complete(verified) ? 'migrated' : 'partial';
    return finish({ ...verified, status, commit });
  },
});

// docs-drift-audit: control flow only. Code pins HEAD, lists the docs and their headings, and the
// librarian ranks them; each chosen doc then flows through its own pipeline with no barrier (read,
// extract quoted claims, anchor them in code, check them, and with fix, patch in an isolated
// checkout). A settled map keeps every doc's outcome; code integrates the accepted patches,
// verifies them, and publishes only the exact patch a human approved.
import { defineWorkflow, type WorktreeChange } from 'quiet-choir';
import {
  CheckReport,
  Claims,
  Classification,
  DriftInput,
  DriftOutput,
  Fixed,
  type Audited,
  type Failed,
  type Pipeline,
} from '../contracts.js';
import { gatherEvidence, passed, verify } from '../lib/checks.js';
import { fixedText, listDocs, outline, patch, pinBase, readDoc, stillAt } from '../lib/git.js';
import {
  anchor,
  approvalList,
  digest,
  failedFix,
  fixOf,
  inventory,
  judgeReceipt,
  pair,
  preview,
  rank,
  statusOf,
  totals,
} from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'docs-drift-audit',
  version: 'packaged-03',
  description:
    'Rank the docs at HEAD, decompose each into quoted claims, verify them against the code, and publish an approved, verified patch for the drift.',
  roster,
  prompts: [prompts],
  input: DriftInput,
  output: DriftOutput,
  async run(ctx, input) {
    ctx.phase('Inventory');
    const base = await pinBase(ctx);
    const { docs: found, unsupported } = await listDocs(ctx, base, input.paths);
    const { listed, skipped: capped } = inventory(found, unsupported, input);
    const notFixed = { status: 'not-requested' as const, digest: null, commit: null };
    const nothing = {
      status: 'no-docs' as const,
      base,
      listed: found.length,
      docs: [],
      failed: [],
      unclassified: [],
      evidence: [],
      totals: totals([], false),
      fix: { ...notFixed, verification: [] },
    };
    const [first, ...rest] = listed.map((doc) => doc.path);
    if (first === undefined) return { ...nothing, skipped: capped };
    const paths = [first, ...rest] as const;
    const { docs: classified } = await ctx.roster.Librarian.value('classify', {
      schema: Classification(paths),
      prompt: prompts.Classify({ base, docs: await outline(ctx, base, [...paths]) }),
    });
    const ranked = rank(listed, classified, input.maxDocs);
    const skipped = [...capped, ...ranked.skipped];
    if (skipped.length) ctx.log(`Auditing ${ranked.chosen.length} docs; ${skipped.length} skipped`);
    if (!ranked.chosen.length) return { ...nothing, skipped };
    const evidence = await gatherEvidence(ctx, input.evidenceCommands);
    // One pipeline per doc, no barrier: a doc is checked, and fixed, as soon as it is extracted.
    // A failed stage settles its doc; a failed fixer settles inside it, so the audit is kept.
    // `version` names the templates and schemas the mapper renders, which its source does not show.
    const settled = await ctx.map(
      'docs',
      ranked.chosen,
      { concurrency: 3, onError: 'return', version: 'doc/1' },
      async (doc): Promise<Pipeline> => {
        const { path, audience } = doc;
        const text = await ctx.phase('Extract', () => readDoc(ctx, base, path));
        const extracted = await ctx.phase('Extract', () =>
          ctx.roster.Extractor.value('extract', {
            schema: Claims(input.maxClaims),
            prompt: prompts.Extract({ path, audience, maxClaims: input.maxClaims, text }),
          }),
        );
        const { anchored: claims, unanchored } = anchor(text, extracted.claims);
        const audit = { unanchored, capped: extracted.more, fix: null, change: null };
        if (!claims.length) return { ...audit, results: [] };
        const checked = await ctx.phase('Check', () =>
          ctx.roster.Checker.value('check', {
            schema: CheckReport(claims.length),
            prompt: prompts.Check({ path, base, claims, evidence }),
          }),
        );
        const results = pair(claims, checked.results);
        const drifted = results.filter((result) => result.status === 'drifted');
        if (!input.fix || !drifted.length) return { ...audit, results };
        const kept = results.filter((r) => r.status === 'true').map((r) => r.quote);
        const proposal = await ctx.phase('Fix', () =>
          ctx.roster.Fixer.object('fix', {
            worktree: { base: { commit: base } },
            schema: Fixed,
            onError: 'return',
            prompt: prompts.Fix({ path, drifted, kept }),
          }),
        );
        if (!proposal.ok) return { ...audit, results, fix: failedFix(proposal.error.message) };
        const { worktree: change, output } = proposal.value;
        const receipt = judgeReceipt(change, path);
        const after = receipt.commit ? await fixedText(ctx, receipt.commit, path) : null;
        const fix = fixOf(receipt, output.edits, after, results);
        return { ...audit, results, fix, change: after === null ? null : (change ?? null) };
      },
    );
    ctx.phase('Report');
    const docs: Audited[] = [];
    const failed: Failed[] = [];
    const changes: WorktreeChange[] = [];
    for (const [index, doc] of ranked.chosen.entries()) {
      const outcome = settled[index];
      if (outcome?.ok) {
        const { change, ...audited } = outcome.value;
        docs.push({ ...doc, ...audited });
        if (change) changes.push(change);
      } else
        failed.push({
          doc: doc.path,
          step: outcome?.error.stepId ?? null,
          error: outcome?.error.message ?? 'No outcome was recorded',
        });
    }
    const report = {
      base,
      listed: found.length,
      docs,
      skipped,
      failed,
      unclassified: ranked.unclassified,
      evidence: evidence.map(({ argv, code, truncated, failure }) => ({
        argv,
        code,
        truncated,
        failure,
      })),
    };
    const status = statusOf(report);
    const finish = (fix: DriftOutput['fix']): DriftOutput => {
      const output = { ...report, status, totals: totals(docs, fix.status === 'applied'), fix };
      const { claims, drifted } = output.totals;
      ctx.log(`${claims} claims in ${docs.length} docs, ${drifted} drifted; fix ${fix.status}`);
      return output;
    };
    if (!input.fix) return finish({ ...notFixed, verification: [] });
    if (!docs.some((doc) => doc.results.some((result) => result.status === 'drifted')))
      return finish({ ...notFixed, status: 'no-drift', verification: [] });
    if (!changes.length) return finish({ ...notFixed, status: 'no-change', verification: [] });
    // Each fixer owns its one doc, so the changes are disjoint and integration cannot conflict.
    ctx.phase('Fix');
    const merged = await ctx.merge('integrate', changes, { onConflict: 'fail' });
    const tree = input.verifyCommands.length
      ? await ctx.worktree('verification-tree', { base: { commit: merged.commit } })
      : null;
    const verification = tree ? await verify(ctx, tree, input.verifyCommands) : [];
    const proposed = { digest: null, commit: merged.commit, verification };
    if (!passed(verification)) return finish({ ...proposed, status: 'verification-failed' });
    const text = await patch(ctx, base, merged.commit);
    const approved = digest(text);
    const approval = await ctx.approve('approve-fixes', {
      title: 'Doc fixes',
      prompt: 'Publish this verified documentation patch to the checkout?',
      subject: { base, commit: merged.commit, digest: approved, docs: approvalList(docs) },
      details: preview(text),
    });
    if (!approval.approved) return finish({ ...proposed, digest: approved, status: 'declined' });
    // Publish only onto the base, so the published tree is the one verified and approved.
    if (!(await stillAt(ctx, base)))
      return finish({ ...proposed, digest: approved, status: 'moved' });
    const published = await ctx.merge('publish', changes, {
      target: 'checkout',
      onConflict: 'fail',
    });
    return finish({ digest: approved, commit: published.commit, verification, status: 'applied' });
  },
});

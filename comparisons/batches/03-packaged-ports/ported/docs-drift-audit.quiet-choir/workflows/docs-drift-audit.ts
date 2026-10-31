// docs-drift-audit: control flow only. Code pins HEAD, lists the docs and their headings, and the
// librarian ranks them; each chosen doc then flows through its own pipeline with no barrier (read,
// extract quoted claims, anchor them in code, check them in a snapshot of the base, and with fix,
// patch in an isolated checkout). A settled map keeps every doc's outcome; code integrates the
// accepted patches onto the base (refusing a checkout whose HEAD moved), runs the verification
// commands on them, and publishes only the exact patch a human approved.
import { defineWorkflow } from 'quiet-choir';
import {
  CheckReport,
  Claims,
  Classification,
  DriftInput,
  DriftOutput,
  Fixed,
  type Pipeline,
} from '../contracts.js';
import { gatherEvidence, passed, verify } from '../lib/checks.js';
import {
  fixedText,
  listDocs,
  outline,
  patch,
  pinBase,
  readDoc,
  startOf,
  stillAt,
  toRoot,
} from '../lib/git.js';
import {
  anchor,
  approvalList,
  collect,
  digest,
  emptyStatus,
  failedFix,
  fenced,
  fixOf,
  inventory,
  judgeReceipt,
  omittedOf,
  pair,
  preview,
  rank,
  readOnly,
  statusOf,
  totals,
  unfixedStatus,
} from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'docs-drift-audit',
  version: 'packaged-03',
  description:
    'Rank the docs at HEAD, decompose each into quoted claims, verify them against the code, and publish a human-approved patch for the drift, gated on verifyCommands when given.',
  roster,
  prompts: [prompts],
  input: DriftInput,
  output: DriftOutput,
  async run(ctx, input) {
    ctx.phase('Inventory');
    const base = await pinBase(ctx, input.fix);
    const root = await toRoot(ctx);
    // The checker and the fixer each get a fresh checkout of the base, entered at its root.
    const pinned = { worktree: { base: { commit: base } }, ...(root ? { cwd: root } : {}) };
    const { docs: found, unsupported } = await listDocs(ctx, base, input.paths);
    const listed = found.length + unsupported.length;
    const { inventoried, skipped: capped } = inventory(found, unsupported, input);
    const unfixed = { digest: null, commit: null, verification: [], omitted: [], failure: null };
    const notFixed = { ...unfixed, status: 'not-requested' as const };
    const nothing = (skipped: DriftOutput['skipped']): DriftOutput => ({
      status: emptyStatus(skipped),
      base,
      listed,
      docs: [],
      skipped,
      failed: [],
      unclassified: [],
      evidence: [],
      totals: totals([], false),
      fix: notFixed,
    });
    const [first, ...rest] = inventoried.map((doc) => doc.path);
    if (first === undefined) return nothing(capped);
    const paths = [first, ...rest] as const;
    const { docs: classified } = await ctx.roster.Librarian.value('classify', {
      schema: Classification(paths),
      prompt: prompts.Classify({ base, docs: await outline(ctx, base, [...paths]) }),
    });
    const ranked = rank(inventoried, classified, input.maxDocs);
    const skipped = [...capped, ...ranked.skipped];
    if (skipped.length) ctx.log(`Auditing ${ranked.chosen.length} docs; ${skipped.length} skipped`);
    if (!ranked.chosen.length) return nothing(skipped);
    const evidence = await gatherEvidence(ctx, base, input.evidenceCommands);
    // One pipeline per doc, no barrier: a doc is checked, and fixed, as soon as it is extracted.
    // A failed stage settles its doc; a failed fixer settles inside it, so the audit is kept.
    // `version` names the templates and schemas the mapper renders, which its source does not show.
    const settled = await ctx.map(
      'docs',
      ranked.chosen,
      { concurrency: 3, onError: 'return', version: 'doc/3' },
      async (doc): Promise<Pipeline> => {
        const { path, audience } = doc;
        const text = await ctx.phase('Extract', () => readDoc(ctx, base, path));
        const extracted = await ctx.phase('Extract', () =>
          ctx.roster.Extractor.value('extract', {
            schema: Claims(input.maxClaims),
            prompt: prompts.Extract({
              path,
              audience,
              maxClaims: input.maxClaims,
              text: fenced(text, 'document'),
            }),
          }),
        );
        const { anchored: claims, unanchored } = anchor(text, extracted.claims);
        const audit = { unanchored, capped: extracted.more, fix: null, change: null };
        if (!claims.length) return { ...audit, results: [] };
        const checked = await ctx.phase('Check', () =>
          ctx.roster.Checker.object('check', {
            ...pinned,
            schema: CheckReport(claims.length),
            prompt: prompts.Check({ path, base, claims, evidence }),
          }),
        );
        const results = pair(claims, readOnly(checked).results);
        const drifted = results.filter((result) => result.status === 'drifted');
        if (!input.fix || !drifted.length) return { ...audit, results };
        const kept = results.filter((r) => r.status === 'true').map((r) => r.quote);
        const proposal = await ctx.phase('Fix', () =>
          ctx.roster.Fixer.object('fix', {
            ...pinned,
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
    const { docs, failed, changes } = collect(ranked.chosen, settled);
    const report = {
      base,
      listed,
      docs,
      skipped,
      failed,
      unclassified: ranked.unclassified,
      evidence: evidence.map(({ argv, code, truncated, failure, ok }) => ({
        argv,
        code,
        truncated,
        failure,
        ok,
      })),
    };
    const status = statusOf(report);
    const finish = (fix: DriftOutput['fix']): DriftOutput => {
      const output = { ...report, status, totals: totals(docs, fix.status === 'applied'), fix };
      const { claims, drifted } = output.totals;
      ctx.log(`${claims} claims in ${docs.length} docs, ${drifted} drifted; fix ${fix.status}`);
      return output;
    };
    if (!input.fix) return finish(notFixed);
    if (!docs.some((doc) => doc.results.some((result) => result.status === 'drifted')))
      return finish({ ...unfixed, status: 'no-drift' });
    const omitted = omittedOf(docs);
    if (!changes.length) return finish({ ...unfixed, omitted, status: unfixedStatus(omitted) });
    ctx.phase('Fix');
    // ctx.merge integrates onto the checkout's live HEAD, not onto the changes' base, so a HEAD
    // that moved during the run is refused before integrating; the squash commit's parent then
    // confirms the start. Each fixer owns its one doc, so on the base the changes cannot conflict.
    const moved = { ...unfixed, omitted, status: 'moved' as const };
    if (!(await stillAt(ctx, 'head-integrate', base))) return finish(moved);
    const merged = await ctx.merge('integrate', changes, {
      strategy: 'squash',
      onConflict: 'fail',
    });
    if ((await startOf(ctx, merged.commit)) !== base) return finish(moved);
    const tree = input.verifyCommands.length
      ? await ctx.worktree('verification-tree', { base: { commit: merged.commit } })
      : null;
    const verification = tree ? await verify(ctx, tree, input.verifyCommands) : [];
    const proposed = { ...unfixed, commit: merged.commit, verification, omitted };
    if (!passed(verification)) return finish({ ...proposed, status: 'verification-failed' });
    const text = await patch(ctx, base, merged.commit);
    const approved = digest(text);
    const shown = preview(text);
    const approval = await ctx.approve('approve-fixes', {
      title: 'Doc fixes',
      prompt: verification.length
        ? 'Publish this verified documentation patch to the checkout?'
        : 'Publish this unverified documentation patch to the checkout?',
      subject: {
        base,
        commit: merged.commit,
        digest: approved,
        bytes: shown.bytes,
        truncated: shown.truncated,
        docs: approvalList(docs),
        omitted,
      },
      details: shown.details,
    });
    const asked = { ...proposed, digest: approved };
    if (!approval.approved) return finish({ ...asked, status: 'declined' });
    // Publish only onto the base, so the published tree is the one approved (and verified).
    if (!(await stillAt(ctx, 'head-publish', base))) return finish({ ...asked, status: 'moved' });
    const published = await ctx.merge('publish', changes, {
      target: 'checkout',
      onConflict: 'fail',
      onError: 'return',
    });
    if (!published.ok)
      return finish({ ...asked, status: 'publish-failed', failure: published.error.message });
    return finish({ ...asked, commit: published.value.commit, status: 'applied' });
  },
});

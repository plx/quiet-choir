// deep-code-review: control flow only. Code pins merge-base..head, lists the changed files and
// cuts the patch under a line budget. One reviewer per dimension, then one skeptic per
// deduplicated finding, run as settled maps over read-only snapshots of the head, so a failed
// member is counted rather than fatal; only findings no skeptic refuted reach the report.
import { defineWorkflow } from 'quiet-choir';
import {
  DeepCodeReviewInput,
  DeepCodeReviewOutput,
  Dimension,
  Findings,
  ScopeSummary,
  Verdict,
} from '../contracts.js';
import { changedFiles, patchOf, pinRange } from '../lib/git.js';
import { budget, dedupe, judge, plainReport, readOnly, slots, status } from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'deep-code-review',
  version: 'packaged-03',
  description:
    'Review a pinned range per dimension, deduplicate in code, and report only findings a skeptic could not refute.',
  roster,
  prompts: [prompts],
  input: DeepCodeReviewInput,
  output: DeepCodeReviewOutput,
  async run(ctx, input) {
    const range = await pinRange(ctx.within('range'), input.base, input.head);
    const { reviewed: files, unreviewed: unreviewedFiles } = budget(
      await changedFiles(ctx, range, input.paths),
      input.maxChangedLines,
    );
    if (!files.length) {
      const limited = unreviewedFiles.length > 0;
      return {
        ...range,
        status: limited ? 'limited' : 'nothing-to-review',
        files,
        unreviewedFiles,
        dimensions: [],
        unreviewedDimensions: [],
        rawFindings: 0,
        confirmed: [],
        rejected: [],
        unverified: [],
        unchecked: [],
        report: limited ? 'Every changed file is past maxChangedLines.' : 'No change in scope.',
      };
    }
    const paths = files.map((file) => file.path);
    const change = {
      files,
      omitted: unreviewedFiles,
      patch: await patchOf(ctx, 'patch', range, paths),
    };
    const scope = await ctx.roster.Scoper.value('scope', {
      schema: ScopeSummary,
      prompt: prompts.Scope(change),
    });
    const snapshot = { base: { commit: range.head } };
    // A deliberate barrier: deduplication needs every dimension before any skeptic is paid.
    const wanted = Dimension.options.filter((dimension) => input.dimensions.includes(dimension));
    const reviews = await ctx.map(
      'reviews',
      wanted,
      { concurrency: 5, key: (dimension) => dimension, onError: 'return', version: 'review/1' },
      async (dimension) =>
        readOnly(
          await ctx.roster.Reviewer.object('review', {
            schema: Findings,
            worktree: snapshot,
            prompt: prompts.Review({ dimension, ...scope, ...range, ...change }),
          }),
        ).findings,
    );
    const answered = wanted.flatMap((dimension, index) => {
      const review = reviews[index];
      return review?.ok ? [{ dimension, findings: review.value }] : [];
    });
    const { checked, unchecked } = slots(dedupe(answered), input.maxFindings);
    // A skeptic that fails leaves its finding unverified: it is reported, never confirmed.
    const verdicts = await ctx.map(
      'verify',
      checked,
      { concurrency: 4, onError: 'return', version: 'refute/1' },
      async (finding) => {
        const patch = await patchOf(ctx, 'patch', range, [finding.file]);
        return readOnly(
          await ctx.roster.Skeptic.object('refute', {
            schema: Verdict,
            worktree: snapshot,
            prompt: prompts.Refute({ finding, patch, ...range }),
          }),
        );
      },
    );
    const { confirmed, rejected, unverified } = judge(checked, verdicts);
    const dimensions = answered.map((review) => review.dimension);
    const unreviewedDimensions = wanted.filter((dimension) => !dimensions.includes(dimension));
    const accounting = { unreviewedFiles, unchecked, unreviewedDimensions, unverified };
    // The reporter sees only survivors, so it cannot resurrect a refuted claim.
    const report = confirmed.length
      ? await ctx.roster.Reporter.value('report', {
          prompt: prompts.Report({
            summary: scope.summary,
            confirmed,
            unreviewedDimensions,
            omitted: unreviewedFiles.length,
            unverified: unverified.length,
            unchecked: unchecked.length,
          }),
        })
      : plainReport({ ...accounting, files: files.length, dimensions, rejected: rejected.length });
    return {
      ...range,
      status: status(accounting),
      files,
      unreviewedFiles,
      dimensions,
      unreviewedDimensions,
      rawFindings: answered.reduce((total, review) => total + review.findings.length, 0),
      confirmed,
      rejected,
      unverified,
      unchecked,
      report,
    };
  },
});

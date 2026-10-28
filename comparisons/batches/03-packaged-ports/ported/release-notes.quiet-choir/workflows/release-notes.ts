// release-notes: control flow only. Git pins the manifest, summarizers read disjoint slices,
// coverage is a set comparison, and std.patterns.reviewRevise runs the bounded fact-check loop.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { ReleaseNotesInput, ReleaseNotesOutput, SliceSummary } from '../contracts.js';
import { gitWindow, rangeLog, slicePatch, slices } from '../lib/git.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'release-notes',
  version: 'packaged-03',
  description:
    'Compute a Git manifest, summarize disjoint slices, fact-check with reviewRevise and write notes in code.',
  roster,
  prompts: [prompts],
  input: ReleaseNotesInput,
  output: ReleaseNotesOutput,
  async run(ctx, input) {
    const window = await gitWindow(ctx.within('range'), input.since, input.until);
    const summaries = await ctx.map(
      'slices',
      slices(window.manifest, input.chunkSize),
      { concurrency: 3 },
      async (shas) =>
        ctx.roster.Summarizer.value('summarize', {
          schema: SliceSummary(shas),
          prompt: prompts.Summarize({ shas, patch: await slicePatch(ctx, shas) }),
        }),
    );
    const changes = summaries.flatMap((summary) => summary.changes);
    const covered = window.manifest.filter((sha) => changes.some((change) => change.sha === sha));
    const missing = window.manifest.filter((sha) => !covered.includes(sha));
    const evidence = { changes, missing };
    const draft = await ctx.roster.Drafter.value('draft', {
      prompt: prompts.Draft({ audience: input.audience, ...evidence }),
    });
    const span = `${window.start}..${window.end}`;
    const log = await rangeLog(ctx, window.start, window.end);
    // Up to maxRevisions + 1 checks with a revision between each; the last check is not revised.
    const checked = await std.patterns.reviewRevise(ctx, {
      id: 'fact-check',
      team: { actor: ctx.roster.Drafter, critic: ctx.roster.FactChecker },
      draft,
      rounds: input.maxRevisions + 1,
      prompts: {
        review: (notes) => prompts.FactCheck({ span, log, notes, ...evidence }),
        revise: (notes, feedback) => prompts.Revise({ notes, feedback, ...evidence }),
      },
    });
    // Exclusive creation keeps an existing changelog from being silently overwritten.
    const written =
      input.publication === 'commit'
        ? await std.exec.committedArtifact(ctx, input.out, `${checked.draft}\n`)
        : await ctx.writeFile('write', input.out, `${checked.draft}\n`, { ifMatch: null });
    return {
      ...window,
      covered,
      missing,
      status: missing.length || !checked.approved ? 'needs-review' : 'verified',
      factChecked: checked.approved,
      notes: checked.draft,
      breaking: changes.filter((change) => ['breaking', 'deprecation'].includes(change.kind)),
      written,
    };
  },
});

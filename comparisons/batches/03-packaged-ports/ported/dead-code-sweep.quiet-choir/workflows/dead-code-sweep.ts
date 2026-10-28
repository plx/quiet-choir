// dead-code-sweep: control flow only. Three modality sweeps are a tolerant panel, every candidate
// gets a settled default-to-keep skeptic, and a removal runs only after a human approves the
// exact list; code verifies the isolated change before publishing it.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Candidates,
  DeadCodeInput,
  DeadCodeOutput,
  Modality,
  Removed,
  Verdict,
} from '../contracts.js';
import { baseCommit, passed, verify } from '../lib/checks.js';
import { cap, listDigest, merge, ownedChange, preview } from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'dead-code-sweep',
  version: 'packaged-03',
  description:
    'Sweep three modalities, keep every candidate a skeptic does not clear, and remove an approved list only after code verifies it.',
  roster,
  prompts: [prompts],
  input: DeadCodeInput,
  output: DeadCodeOutput,
  async run(ctx, input) {
    // `version` names the prompt and schema, which a settled map's fingerprint does not show.
    const sweep = await std.patterns.tolerantPanel(ctx, {
      id: 'sweeps',
      team: { panelist: ctx.roster.Sweeper },
      items: Modality.options,
      concurrency: 3,
      schema: Candidates,
      version: 'sweep/1',
      prompt: (modality) => prompts.Sweep({ scope: input.scope, modality }),
    });
    const { checked, unchecked } = cap(
      merge(sweep.answers.map((answer) => answer.candidates)),
      input.maxCandidates,
    );
    const report = {
      failedSweeps: sweep.failed,
      unchecked,
      approvedDigest: null,
      commit: null,
      verification: [],
    };
    if (!checked.length) return { ...report, status: 'nothing-dead', confirmedDead: [], kept: [] };
    // A skeptic that fails keeps its candidate: deleting live code breaks production.
    const verdicts = await ctx.map(
      'cross-check',
      checked,
      { concurrency: 3, onError: 'return' },
      (candidate) =>
        ctx.roster.Skeptic.value('alive', {
          schema: Verdict,
          prompt: prompts.Alive({ candidate, modalities: candidate.modalities }),
        }),
    );
    const confirmedDead = checked.filter((_, index) => {
      const verdict = verdicts[index];
      return verdict?.ok === true && !verdict.value.alive;
    });
    const kept = checked.flatMap((candidate, index) => {
      const verdict = verdicts[index];
      if (verdict?.ok === true && !verdict.value.alive) return [];
      const why = verdict?.ok
        ? (verdict.value.referenceFound ?? verdict.value.reasoning)
        : 'check failed; kept by default';
      return [
        { identifier: candidate.identifier, file: candidate.file, why, checked: !!verdict?.ok },
      ];
    });
    const result = { ...report, confirmedDead, kept };
    if (!confirmedDead.length) return { ...result, status: 'nothing-dead' };
    if (!input.apply) return { ...result, status: 'report' };
    const list = std.exec.json(
      confirmedDead.map(({ kind, identifier, file }) => ({ kind, identifier, file })),
    );
    const approvedDigest = listDigest(list);
    const base = await baseCommit(ctx);
    const approval = await ctx.approve('approve-removal', {
      title: 'Removal',
      prompt: 'Delete exactly this confirmed-dead list and run the verification commands?',
      subject: { list: confirmedDead, digest: approvedDigest, base },
      details: preview(list),
    });
    if (!approval.approved) return { ...result, status: 'declined', approvedDigest };
    // One remover sees the interactions between deletions that parallel removers would miss.
    const removal = await ctx.roster.Remover.object('remove', {
      worktree: { base: { commit: base } },
      schema: Removed,
      prompt: prompts.Remove({ digest: approvedDigest, list }),
    });
    const change = ownedChange(removal.worktree, confirmedDead);
    const merged = await ctx.merge('integrate', [change], { onConflict: 'fail' });
    const tree = await ctx.worktree('verification-tree', { base: { commit: merged.commit } });
    const verification = await verify(ctx, tree, input.verifyCommands);
    if (!passed(verification))
      return {
        ...result,
        status: 'verification-failed',
        approvedDigest,
        commit: merged.commit,
        verification,
      };
    const published = await ctx.merge('publish', [change, tree], {
      target: 'checkout',
      onConflict: 'fail',
    });
    return { ...result, status: 'applied', approvedDigest, commit: published.commit, verification };
  },
});

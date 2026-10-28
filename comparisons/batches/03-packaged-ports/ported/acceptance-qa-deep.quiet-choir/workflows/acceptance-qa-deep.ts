// acceptance-qa-deep: control flow only. Code pins the delivered work as a snapshot commit and runs
// the operator's check commands on it; one decomposer plans the checks; then a settled map runs
// each criterion's pipeline (check, then a cross-harness challenge of a pass) in checkouts of the
// snapshot. Statuses, the letter-vs-spirit downgrade and the verdict are computed in lib/policy.ts;
// the narrator only words them, and code writes the summary when it fails.
import { defineWorkflow } from 'quiet-choir';
import {
  AcceptanceInput,
  AcceptanceOutput,
  Challenge,
  CheckReport,
  Decomposition,
  limits,
} from '../contracts.js';
import { runCommands } from '../lib/checks.js';
import {
  checklist,
  fallbackSummary,
  grade,
  mustFix,
  pair,
  pendingManual,
  runStatus,
  statusOf,
  verdictOf,
} from '../lib/policy.js';
import { changedFiles, patch, pin, readCriteria } from '../lib/snapshot.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'acceptance-qa-deep',
  version: 'packaged-03',
  description:
    'Pin the delivered work, check each decomposed criterion against it, challenge every pass and compute the gate verdict in code.',
  roster,
  prompts: [prompts],
  input: AcceptanceInput,
  output: AcceptanceOutput,
  async run(ctx, input) {
    ctx.phase('Decompose');
    const pinned = await pin(ctx, input.base);
    // A commit-tree snapshot has no ref of its own: this handle pins it under the run's refs at
    // once, so the reported snapshot survives gc, and the check commands run in its checkout.
    const checkout = await ctx.worktree('snapshot', { base: { commit: pinned.snapshot } });
    const files = await changedFiles(ctx, pinned, input.paths);
    const diff = await patch(ctx, pinned, input.paths, input.maxPatchBytes);
    const criteria = await readCriteria(ctx, input);
    const decomposition = await ctx.roster.Decomposer.value('decompose', {
      schema: Decomposition,
      prompt: prompts.Decompose({
        criteria,
        source: input.criteriaFile,
        ticket: input.ticket,
        files,
        limits,
      }),
    });
    const report = { ...pinned, files, patchTruncated: diff.truncated };
    if (!decomposition.criteria.length)
      return {
        ...report,
        status: 'no-criteria' as const,
        verdict: 'no-criteria' as const,
        commands: [],
        criteria: [],
        mustFix: [],
        pendingManual: [],
        summary: 'No acceptance criteria could be decomposed.',
        summarySource: 'code' as const,
      };
    const { checked, skipped } = checklist(decomposition, input.maxCriteria);
    ctx.phase('Check');
    const commands = await runCommands(ctx, checkout, input.checkCommands);
    const worktree = { base: { commit: pinned.snapshot } };
    const scene = {
      snapshot: pinned.snapshot,
      base: pinned.base,
      uncommitted: pinned.uncommitted,
      paths: input.paths,
      files,
    };
    // A pipeline per criterion, no barrier: a pass is challenged as soon as it is checked. A failed
    // checker settles its item; a failed challenge settles inside it, so the check is kept.
    // `version` names the templates and schemas the mapper renders: a committed item replays
    // without its mapper, so an accepted template edit alone would not refuse it. Three criteria
    // at a time bound the concurrent checkouts.
    const settled = await ctx.map(
      'criteria',
      checked,
      { concurrency: 3, onError: 'return', version: 'criteria/2' },
      async (criterion) => {
        const { results } = await ctx.roster.Checker.value('check', {
          worktree,
          schema: CheckReport(criterion.checks.length),
          prompt: prompts.Check({
            ...scene,
            ...criterion,
            commands: commands.evidence,
            patch: diff.text,
            patchTruncated: diff.truncated,
          }),
        });
        const checks = pair(criterion.checks, results);
        if (statusOf(checks) !== 'pass') return { checks, challenge: null, challengeFailed: false };
        const challenge = await ctx.roster.Challenger.value('challenge', {
          worktree,
          schema: Challenge,
          onError: 'return',
          prompt: prompts.Challenge({
            ...scene,
            criterion: criterion.criterion,
            checks,
            commands: commands.evidence,
          }),
        });
        return {
          checks,
          challenge: challenge.ok ? challenge.value : null,
          challengeFailed: !challenge.ok,
        };
      },
    );
    ctx.phase('Verdict');
    const graded = grade(checked, settled, skipped);
    const verdict = verdictOf(graded);
    const fixes = mustFix(graded);
    const manual = pendingManual(graded);
    const narrated = await ctx.roster.Narrator.value('summary', {
      onError: 'return',
      prompt: prompts.Summarize({ verdict, graded, mustFix: fixes, pendingManual: manual }),
    });
    return {
      ...report,
      status: runStatus(graded),
      verdict,
      commands: commands.checks,
      criteria: graded,
      mustFix: fixes,
      pendingManual: manual,
      summary: narrated.ok ? narrated.value : fallbackSummary(verdict, fixes, manual),
      summarySource: narrated.ok ? ('narrator' as const) : ('code' as const),
    };
  },
});

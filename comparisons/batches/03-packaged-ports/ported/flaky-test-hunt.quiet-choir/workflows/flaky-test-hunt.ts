// flaky-test-hunt: control flow only. Code reads the history and CI facts, the blind sweeps with
// evidence to read are a settled map, code screens their suspects to tracked test files,
// stress-runs the operator's single-test command and computes every verdict, settled
// diagnosticians see only measured flakes, and a fix runs only after a human approves the exact
// plan; code checks the isolated change covers the plan and re-stresses it before publishing it.
import { defineWorkflow, type WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Diagnosis,
  Fixed,
  FlakyInput,
  FlakyOutput,
  maxFound,
  Modality,
  Suspects,
  type Stress,
} from '../contracts.js';
import { artifacts, classify, cleanAt, history, residue } from '../lib/git.js';
import {
  argvFor,
  cap,
  fixPlan,
  merge,
  owned,
  passFor,
  planDigest,
  preview,
  screen,
  unplanned,
} from '../lib/policy.js';
import { held, stress, verify } from '../lib/stress.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'flaky-test-hunt',
  version: 'packaged-03',
  description:
    'Sweep three evidence sources, stress-run suspects in code, diagnose only measured flakes, and publish approved fixes only after code re-stresses them.',
  roster,
  prompts: [prompts],
  input: FlakyInput,
  output: FlakyOutput,
  async run(ctx, input) {
    const { head: commit, prefix } = await cleanAt(ctx, 'clean', null);
    const facts = {
      history: await history(ctx, commit, input.historyDepth, input.testFiles),
      artifacts: await artifacts(ctx),
    };
    // The history sweeper has no shell, so with no mention and no churn it has nothing to read.
    const noEvidence = Modality.options.filter(
      (modality) =>
        modality === 'history' && !facts.history.mentions.length && !facts.history.churn.length,
    );
    const swept = Modality.options.filter((modality) => !noEvidence.includes(modality));
    // A settled map rather than tolerantPanel: each answer must stay attributed to its modality.
    const sweeps = await ctx.map(
      'sweeps',
      swept,
      { concurrency: 3, onError: 'return', key: (modality) => modality, version: 'sweep/2' },
      (modality) =>
        ctx.roster.Sweeper.value('suspects', {
          schema: Suspects,
          prompt: prompts.Sweep({
            scope: input.scope,
            modality,
            testFiles: input.testFiles,
            limit: maxFound,
            ...facts,
          }),
        }),
    );
    const failedSweeps = swept.filter((_, index) => !sweeps[index]?.ok);
    const merged = merge(
      swept.flatMap((modality, index) => {
        const sweep = sweeps[index];
        return sweep?.ok ? [{ modality, suspects: sweep.value.suspects }] : [];
      }),
    );
    const files = merged.map((suspect) => suspect.file);
    const { kept, rejected } = screen(merged, await classify(ctx, files, input.testFiles));
    const { stressed: chosen, skipped } = cap(kept, input.maxSuspects);
    const report = {
      commit,
      noEvidence,
      failedSweeps,
      rejected,
      skipped,
      approvedDigest: null,
      fixCommit: null,
      refusedFiles: [],
      untouched: [],
      restress: [],
      verification: [],
    };
    if (!chosen.length)
      return {
        ...report,
        // "No suspects" only when a sweep answered and nothing it named was turned away.
        status:
          failedSweeps.length === swept.length
            ? 'sweeps-failed'
            : merged.length
              ? 'all-rejected'
              : 'no-suspects',
        confirmed: [],
        cleared: [],
        broken: [],
        unrunnable: [],
        undiagnosed: 0,
        unplanned: [],
        residue: [],
      };
    const measure = (target: { file: string; test: string }, tree: WorktreeHandle | null) => ({
      timeoutMs: input.runTimeoutMs,
      passPattern: passFor(input.passPattern, target.test),
      tree,
    });
    // One suspect at a time: concurrent runs in one checkout would manufacture flakes.
    const stressed = await ctx.map('stress', chosen, { concurrency: 1 }, async (suspect) => ({
      ...suspect,
      stress: await stress(
        ctx,
        argvFor(input.testCommand, suspect),
        input.runs,
        measure(suspect, null),
      ),
    }));
    const left = await residue(ctx);
    const by = (verdict: Stress['verdict']) =>
      stressed.filter((suspect) => suspect.stress.verdict === verdict);
    const flaky = by('flaky');
    // A failed diagnosis leaves its flake undiagnosed; the measurement still confirms it.
    const diagnoses = await ctx.map(
      'diagnose',
      flaky,
      { concurrency: 3, onError: 'return', version: 'diagnose/1' },
      ({ stress, ...suspect }) =>
        ctx.roster.Diagnostician.value('diagnosis', {
          schema: Diagnosis,
          prompt: prompts.Diagnose({ suspect, stress, commit, residue: left }),
        }),
    );
    const confirmed = flaky.map((suspect, index) => {
      const diagnosis = diagnoses[index];
      return { ...suspect, diagnosis: diagnosis?.ok ? diagnosis.value : null };
    });
    const result = {
      ...report,
      confirmed,
      cleared: by('stable'),
      broken: by('always-fails'),
      unrunnable: by('could-not-run'),
      undiagnosed: confirmed.filter((flake) => !flake.diagnosis).length,
      unplanned: unplanned(confirmed),
      residue: left,
    };
    // "No flakes" only when at least one suspect was measured.
    if (!confirmed.length)
      return {
        ...result,
        status: result.unrunnable.length === stressed.length ? 'unmeasured' : 'no-flakes',
      };
    if (!input.fix) return { ...result, status: 'report' };
    const plan = fixPlan(confirmed);
    if (!plan.length) return { ...result, status: 'no-plan' };
    // Publication needs the measured checkout, so test residue stops here, before any approval.
    await cleanAt(ctx, 'clean-for-fix', commit);
    const list = std.exec.json(plan);
    const approvedDigest = planDigest(list);
    const approval = await ctx.approve('approve-fixes', {
      title: 'Flaky fixes',
      prompt: 'Apply these flaky-test fixes, then re-stress every fixed test before publishing?',
      subject: { plan, digest: approvedDigest, base: commit },
      details: preview(list),
    });
    if (!approval.approved) return { ...result, status: 'declined', approvedDigest };
    // One fixer sees fixes that share a fixture or a file, which parallel fixers would collide on.
    const fixed = await ctx.roster.Fixer.object('fix', {
      worktree: { base: { commit } },
      schema: Fixed,
      prompt: prompts.Fix({
        digest: approvedDigest,
        plan: list,
        fixRuns: input.fixRuns,
        verifying: input.verifyCommands.length > 0,
      }),
    });
    const { change, refusedFiles, untouched } = owned(fixed.worktree, plan, prefix);
    const gated = { ...result, approvedDigest, refusedFiles, untouched };
    if (refusedFiles.length) return { ...gated, status: 'refused' };
    // An unchanged test can pass a few re-stress runs by chance, so every fix must touch its files.
    if (untouched.length) return { ...gated, status: 'incomplete' };
    const integrated = await ctx.merge('integrate', [change], { onConflict: 'fail' });
    const base = { base: { commit: integrated.commit } };
    const stressTree = await ctx.worktree('restress-tree', base);
    const restress = await ctx.map('restress', plan, { concurrency: 1 }, async (item) => ({
      test: item.test,
      file: item.file,
      stress: await stress(
        ctx,
        argvFor(input.testCommand, item),
        input.fixRuns,
        measure(item, stressTree),
      ),
    }));
    // A fresh tree, so what the re-stress runs wrote cannot decide the verification commands.
    const verification = input.verifyCommands.length
      ? await verify(ctx, await ctx.worktree('verification-tree', base), input.verifyCommands)
      : [];
    const checked = { ...gated, restress, verification };
    if (!held(restress, verification))
      return { ...checked, status: 'fix-failed', fixCommit: integrated.commit };
    // Only the fixer's change is published; what the re-stress runs left in their tree is not.
    const published = await ctx.merge('publish', [change], {
      target: 'checkout',
      onConflict: 'fail',
    });
    return { ...checked, status: 'fixed', fixCommit: published.commit };
  },
});

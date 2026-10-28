// test-gap-filler: control flow only. Agents propose text; code owns the guarded test write, the
// baseline verdict and every mutation, including restoration after an interrupted attempt.
import { defineWorkflow } from 'quiet-choir';
import { Gaps, Lens, RankingFor, TestGapInput, TestGapOutput, TestPlanFor } from '../contracts.js';
import { checkMutant, checkMutants, uniqueGaps } from '../lib/mutation.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'test-gap-filler',
  version: 'packaged-03',
  description:
    'Generate a test and mutation plan; code owns guarded writes, tests and interrupted-attempt recovery.',
  roster,
  prompts: [prompts],
  input: TestGapInput,
  output: TestGapOutput,
  async run(ctx, input) {
    if (input.target === input.testFile)
      throw new Error('The test and mutation target must differ');
    const { target, behavior } = input;
    const pristine = await ctx.readFile('pristine', target);
    const source = pristine.content;
    const found = await ctx.map('find', Lens.options, { concurrency: 2 }, (lens) =>
      ctx.roster.GapFinder.value('gaps', {
        schema: Gaps,
        prompt: prompts.FindGaps({ lens, target, behavior, source }),
      }),
    );
    const gaps = uniqueGaps(found.flatMap((result) => result.gaps));
    const result = { pristineSha256: pristine.sha256, mutations: [], surviving: [] };
    if (!gaps.length)
      return { ...result, status: 'no-gaps', baselineCode: null, test: null, selected: [] };
    const ranking = await ctx.roster.Ranker.value('rank', {
      schema: RankingFor(gaps, input.maxGaps),
      prompt: prompts.Rank({ gaps, maxGaps: input.maxGaps }),
    });
    const selected = [...new Set(ranking.selected)];
    const plan = await ctx.roster.TestAuthor.value('plan', {
      schema: TestPlanFor(input.maxMutants),
      prompt: prompts.PlanTests({
        target,
        testFile: input.testFile,
        behavior,
        gaps: gaps.filter((gap) => selected.includes(gap.key)),
        source,
      }),
    });
    checkMutants(plan.mutants, source);
    const test = await ctx.writeFile('test', input.testFile, plan.test, { ifMatch: null });
    const baseline = await ctx.exec('baseline', input.testCommand, { onError: 'return' });
    if (!baseline.ok || baseline.value.truncated)
      return {
        ...result,
        status: 'baseline-failed',
        baselineCode: baseline.ok ? baseline.value.code : (baseline.error.code ?? null),
        test,
        selected,
      };
    // Same-target mutants are deliberately serial; completed mutations replay without rewriting.
    const mutations = await ctx.map(
      'mutants',
      plan.mutants,
      { concurrency: 1, key: (mutant) => ctx.id(mutant.id) },
      (mutant) =>
        checkMutant(ctx, {
          file: target,
          pristine: source,
          sha256: pristine.sha256,
          mutant,
          argv: input.testCommand,
        }),
    );
    const surviving = mutations
      .filter((mutation) => !mutation.killed)
      .map((mutation) => mutation.id);
    return {
      ...result,
      status: surviving.length ? 'gaps-remain' : 'covered',
      baselineCode: baseline.value.code,
      test,
      selected,
      mutations,
      surviving,
    };
  },
});

// Idiomatic rewrite of the pinned MIT upstream; see ../LICENSE and ../notes.json.
import { defineWorkflow, z } from 'quiet-choir';
import { Argv, Digest, Path, Receipt, json, profiles } from './support.js';
import { mutationWorker } from './mutation-worker.js';

const Mutant = z.object({
  id: z.string().min(1).max(80),
  before: z.string().min(1),
  after: z.string(),
  reason: z.string().min(1),
});
const MutationResult = z.object({
  id: z.string(),
  killed: z.boolean(),
  code: z.number().int(),
  restoredSha256: Digest,
});
export default defineWorkflow({
  name: 'test-gap-filler',
  version: 'idiomatic-02',
  description:
    'Generate a test and mutation plan; code owns guarded writes, tests and interrupted-attempt recovery.',
  profiles: { reader: profiles.reader },
  input: z.object({
    target: Path.describe('Existing UTF-8 source file whose behavior needs tests'),
    testFile: Path.describe('New test file; existing unrelated content is never overwritten'),
    testCommand: Argv.describe('Operator-selected argv command that must pass before mutation'),
    behavior: z.string().min(1).describe('Behavior or coverage gap to exercise'),
    maxGaps: z.number().int().min(1).max(6).default(3),
    maxMutants: z.number().int().min(1).max(12).default(4),
  }),
  output: z.object({
    status: z.enum(['no-gaps', 'baseline-failed', 'covered', 'gaps-remain']),
    baselineCode: z.number().int().nullable(),
    pristineSha256: Digest,
    test: Receipt.nullable(),
    selected: z.array(z.string()),
    mutations: z.array(MutationResult),
    surviving: z.array(z.string()),
  }),
  async run(ctx, input) {
    if (input.target === input.testFile)
      throw new Error('The test and mutation target must differ');
    const pristine = await ctx.readFile('pristine', input.target);
    const found = await ctx.map(
      'find',
      ['existing coverage', 'failure risk'],
      { concurrency: 2 },
      (lens) =>
        ctx.claude.value('gaps', {
          profile: 'reader',
          schema: z.object({
            gaps: z
              .array(z.object({ key: z.string().min(1).max(80), reason: z.string().min(1) }))
              .max(12),
          }),
          prompt: `Find test gaps in ${input.target} through the ${lens} lens. Read existing tests and coverage artifacts; do not claim to have run tooling. Prioritize failure paths and concrete behavior.\n${json({ behavior: input.behavior, source: pristine.content })}`,
        }),
    );
    const gaps = [
      ...new Map(found.flatMap((result) => result.gaps).map((gap) => [gap.key, gap])).values(),
    ];
    if (!gaps.length)
      return {
        status: 'no-gaps',
        baselineCode: null,
        pristineSha256: pristine.sha256,
        test: null,
        selected: [],
        mutations: [],
        surviving: [],
      };
    const ranking = await ctx.claude.value('rank', {
      profile: 'reader',
      schema: z.object({
        selected: z
          .array(z.enum(gaps.map((gap) => gap.key)))
          .min(1)
          .max(Math.min(input.maxGaps, gaps.length)),
      }),
      prompt: `Rank these gaps by blast radius. Select unique keys for the highest-risk gaps, up to ${input.maxGaps}.\n${json(gaps)}`,
    });
    const selected = [...new Set(ranking.selected)];
    const plan = await ctx.claude.value('plan', {
      profile: 'reader',
      schema: z.object({
        test: z.string().min(1),
        mutants: z.array(Mutant).min(1).max(input.maxMutants),
      }),
      prompt: `Propose a focused test file and small independent mutants that its assertions should kill, covering every selected gap. Each before string must occur exactly once in the pristine source. Return test content; do not edit files.\n${json({ ...input, gaps: gaps.filter((gap) => selected.includes(gap.key)), source: pristine.content })}`,
    });
    if (new Set(plan.mutants.map((mutant) => mutant.id)).size !== plan.mutants.length)
      throw new Error('Mutant IDs must be unique');
    for (const mutant of plan.mutants) {
      if (mutant.before === mutant.after || pristine.content.split(mutant.before).length !== 2)
        throw new Error(`Invalid mutation anchor: ${mutant.id}`);
    }
    const test = await ctx.writeFile('test', input.testFile, plan.test, { ifMatch: null });
    const baseline = await ctx.exec('baseline', input.testCommand, { okExitCodes: 'any' });
    if (baseline.code !== 0 || baseline.truncated)
      return {
        status: 'baseline-failed',
        baselineCode: baseline.code,
        pristineSha256: pristine.sha256,
        test,
        selected,
        mutations: [],
        surviving: [],
      };
    // Same-target mutants are deliberately serial; completed mutations replay without rewriting.
    const mutations = await ctx.map(
      'mutants',
      plan.mutants,
      { concurrency: 1, key: (mutant) => ctx.id(mutant.id) },
      (mutant) =>
        ctx.exec.json('check', [process.execPath, '--input-type=module', '-e', mutationWorker], {
          schema: MutationResult,
          input: JSON.stringify({
            file: input.target,
            pristine: pristine.content,
            sha256: pristine.sha256,
            mutant,
            argv: input.testCommand,
          }),
        }),
    );
    const surviving = mutations
      .filter((mutation) => !mutation.killed)
      .map((mutation) => mutation.id);
    return {
      status: surviving.length ? 'gaps-remain' : 'covered',
      baselineCode: baseline.code,
      pristineSha256: pristine.sha256,
      test,
      selected,
      mutations,
      surviving,
    };
  },
});

import { defineWorkflow, z } from 'quiet-choir';
import { Argv, Path, json, profiles, writeCommittedArtifact } from './support.js';

export const DocumentStage = z.enum(['requirements', 'spec', 'roadmap', 'backlog', 'feedback']);
export const Stage = z.enum([
  ...DocumentStage.options,
  'bootstrap',
  'implement',
  'qa',
  'release-gate',
  'release-notes',
]);
export const StageResult = z.object({
  summary: z.string(),
  artifact: z.string().nullable(),
  gate: z.enum(['pass', 'concerns', 'blocked']),
  details: z.array(z.string()),
});
const context = {
  goal: z.string().min(1).describe('Lifecycle goal'),
  artifacts: z.record(z.string(), z.string()),
  answer: z.string().describe('Human answer belonging only to this stage'),
};

export const documentStage = defineWorkflow({
  name: 'lifecycle-document',
  version: '1',
  profiles: { reader: profiles.reader },
  input: z.object({
    ...context,
    stage: DocumentStage.describe('Document to produce'),
    out: Path.describe('New artifact file'),
  }),
  output: StageResult,
  async run(ctx, input) {
    const content = await ctx.claude.value('draft', {
      profile: 'reader',
      prompt: `Produce the ${input.stage} artifact for this lifecycle goal. Read prior artifacts as evidence. Return the complete document; do not edit files. Apply this stage's human answer.\n${json(input)}`,
    });
    const review = await ctx.claude.value('review', {
      profile: 'reader',
      schema: StageResult.omit({ artifact: true }),
      prompt: `Review this ${input.stage} document for completeness, unresolved decisions and consistency with the goal.\n${json({ ...input, content })}`,
    });
    // Commit documents through a managed checkout so later implementation can integrate
    // without an untracked-document dirty tree. Redo uses a new artifact path.
    await writeCommittedArtifact(ctx, input.out, `${content}\n`);
    return { ...review, artifact: input.out };
  },
});

export const implementationStage = defineWorkflow({
  name: 'lifecycle-implementation',
  version: '1',
  profiles,
  input: z.object({
    ...context,
    testCommand: Argv.describe('Verification argv command approved by the operator'),
  }),
  output: StageResult,
  async run(ctx, input) {
    const tree = await ctx.worktree('implementation');
    await ctx.claude.value('apply', {
      profile: 'writer',
      worktree: tree,
      prompt: `Implement this goal from the supplied artifacts, applying this stage's human answer. Edit files only; code runs verification.\n${json(input)}`,
    });
    const test = await ctx.exec('verify', input.testCommand, {
      worktree: tree,
      okExitCodes: 'any',
    });
    if (test.code !== 0 || test.truncated)
      return {
        summary: 'Implementation verification failed',
        artifact: null,
        gate: 'blocked',
        details: [`exit=${test.code}; truncated=${test.truncated}`],
      };
    const merged = await ctx.merge('integrate', [tree], { target: 'checkout', onConflict: 'fail' });
    return {
      summary: 'Implementation verified and integrated',
      artifact: null,
      gate: 'pass',
      details: [merged.commit],
    };
  },
});

export const verificationStage = defineWorkflow({
  name: 'lifecycle-verification',
  version: '1',
  input: z.object({
    stage: z.enum(['qa', 'release-gate']).describe('Verification gate'),
    testCommand: Argv.describe('Operator-selected verification command'),
  }),
  output: StageResult,
  async run(ctx, input) {
    const result = await ctx.exec('test', input.testCommand, { okExitCodes: 'any' });
    const passed = result.code === 0 && !result.truncated;
    return {
      summary: `${input.stage}: ${passed ? 'passed' : 'failed'}`,
      artifact: null,
      gate: passed ? 'pass' : 'blocked',
      details: [`exit=${result.code}; truncated=${result.truncated}`],
    };
  },
});

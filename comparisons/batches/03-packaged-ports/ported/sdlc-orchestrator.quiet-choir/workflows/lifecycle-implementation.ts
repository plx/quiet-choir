// lifecycle-implementation: an isolated writer edits, code runs the operator's command on its
// checkout, and only a passing checkout is integrated.
import { defineWorkflow } from 'quiet-choir';
import { ImplementationInput, StageResult } from '../contracts.js';
import { commandDetails } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { implementationRoster } from '../roster.js';

export default defineWorkflow({
  name: 'lifecycle-implementation',
  version: 'packaged-03',
  description: 'Implement in an isolated checkout, verify in code, then integrate.',
  roster: implementationRoster,
  prompts: [prompts],
  input: ImplementationInput,
  output: StageResult,
  async run(ctx, { testCommand, ...context }) {
    const tree = await ctx.worktree('implementation');
    await ctx.roster.Implementer.value('apply', {
      worktree: tree,
      prompt: prompts.Implement(context),
    });
    const test = await ctx.exec('verify', testCommand, { worktree: tree, onError: 'return' });
    if (!test.ok || test.value.truncated)
      return {
        summary: 'Implementation verification failed',
        artifact: null,
        gate: 'blocked',
        details: [commandDetails(test)],
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

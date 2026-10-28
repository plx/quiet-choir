// lifecycle-verification: a QA or release gate is the operator's command, settled in code.
import { defineWorkflow } from 'quiet-choir';
import { StageResult, VerificationInput } from '../contracts.js';
import { commandDetails } from '../lib/stages.js';

export default defineWorkflow({
  name: 'lifecycle-verification',
  version: 'packaged-03',
  description: 'Run a QA or release gate command and settle its outcome as the stage gate.',
  input: VerificationInput,
  output: StageResult,
  async run(ctx, input) {
    const result = await ctx.exec('test', input.testCommand, { onError: 'return' });
    const passed = result.ok && !result.value.truncated;
    return {
      summary: `${input.stage}: ${passed ? 'passed' : 'failed'}`,
      artifact: null,
      gate: passed ? 'pass' : 'blocked',
      details: [commandDetails(result)],
    };
  },
});

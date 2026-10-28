// Packaged rewrite of the pinned MIT upstream flaky-test-hunt.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts, and the
// stress loop, Git facts and verdict rules in lib/.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import flakyTestHunt from './workflows/flaky-test-hunt.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'flaky-test-hunt',
  version: '1',
  description:
    "Gather flaky-test suspects from git history, test-code smells and CI artifacts, stress-run each suspect in a tracked test file with the operator's single-test command for a measured flake rate, diagnose a mechanism for each confirmed flake, and publish approved fixes only after code re-stresses them",
  whenToUse:
    'Unexplained CI red streaks, or auditing a test suite with a reputation for randomness; report-only unless fix is set. Input: {testCommand, scope?, testFiles?, runs?, maxSuspects?, fix?, fixRuns?, verifyCommands?, runTimeoutMs?, historyDepth?}.',
  workflows: [flakyTestHunt],
  entry: flakyTestHunt,
  prompts: [prompts],
});

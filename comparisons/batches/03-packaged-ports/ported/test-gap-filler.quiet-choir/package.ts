// Packaged rewrite of the pinned MIT upstream test-gap-filler.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts and the
// mutation worker in resources/.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import testGapFiller from './workflows/test-gap-filler.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'test-gap-filler',
  version: '1',
  description:
    'Find and rank the riskiest test gaps in one source file, write a test, and let code run the baseline and every mutation check',
  whenToUse:
    'Hardening an operator-selected source file before a risky change or after an incident, when a test must be proven to kill mutants rather than claimed to. Input: {target, testFile, testCommand, behavior, maxGaps?, maxMutants?}.',
  workflows: [testGapFiller],
  entry: testGapFiller,
  prompts: [prompts],
});

// Packaged rewrite of the pinned MIT upstream dead-code-sweep.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import deadCodeSweep from './workflows/dead-code-sweep.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'dead-code-sweep',
  version: '1',
  description:
    'Find dead-code candidates through three search modalities, cross-check each with a default-to-keep skeptic, and remove an approved list in an isolated checkout that code verifies',
  whenToUse:
    'Codebase hygiene: removing provably unused exports and files without breaking dynamic or reflective consumers; report-only unless apply is set. Input: {scope?, apply?, verifyCommands?, maxCandidates?}.',
  workflows: [deadCodeSweep],
  entry: deadCodeSweep,
  prompts: [prompts],
});

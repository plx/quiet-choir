// Packaged rewrite of the pinned MIT upstream bug-hunt.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import bugHunt from './workflows/bug-hunt.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'bug-hunt',
  version: '1',
  description:
    'Loop rotating-lens finder panels until two consecutive rounds find nothing new; settle a skeptic panel per candidate',
  whenToUse:
    'Exhaustive bug discovery on a codebase or subsystem, when you want the tail of the distribution and an honest count of what could not be decided. Input: {scope, maxRounds?, votes?, maxCalls?}.',
  workflows: [bugHunt],
  entry: bugHunt,
  prompts: [prompts],
});

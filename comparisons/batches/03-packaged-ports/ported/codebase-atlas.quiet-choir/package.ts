// Packaged rewrite of the pinned MIT upstream codebase-atlas.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import codebaseAtlas from './workflows/codebase-atlas.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'codebase-atlas',
  version: '1',
  description:
    'Survey a pinned commit into subsystems, deep-read each into a card in parallel, assemble an onboarding atlas in code, and run one completeness-critic repair round',
  whenToUse:
    'Onboarding to an unfamiliar codebase, or generating the architecture doc a project never had; regenerating it needs replace. Input: {out?, maxSubsystems?, maxRepairs?, replace?}.',
  workflows: [codebaseAtlas],
  entry: codebaseAtlas,
  prompts: [prompts],
});

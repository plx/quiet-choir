// Packaged rewrite of the pinned MIT upstream deep-code-review.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import deepCodeReview from './workflows/deep-code-review.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'deep-code-review',
  version: '1',
  description:
    'Review a pinned change set across up to five dimensions, deduplicate in code, adversarially verify every finding, and synthesize a ranked report',
  whenToUse:
    'Pre-merge review of a branch, pull request or module change set when you want findings you can trust without re-reviewing them yourself; read-only, and committed changes only. Input: {base?, head?, paths?, dimensions?, maxChangedLines?, maxFindings?}.',
  workflows: [deepCodeReview],
  entry: deepCodeReview,
  prompts: [prompts],
});

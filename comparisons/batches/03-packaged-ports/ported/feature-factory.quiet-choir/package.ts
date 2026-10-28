// Packaged rewrite of the pinned MIT upstream feature-factory.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts; the
// prd-decompose and deep-code-review packages' workflows run as typed inline children.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import featureFactory from './workflows/feature-factory.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'feature-factory',
  version: '1',
  description:
    'Conductor: run prd-decompose as a child, build an approved plan of disjoint modules in isolated worktrees, review each module with a deep-code-review child, repair confirmed findings, and publish only a verified integration',
  whenToUse:
    'PRD-to-reviewed-code for a feature sized to one repository, from a clean checkout, or as the template for composing package workflows as typed children. Input: {prd, verifyCommands, codebase?, maxModules?, dimensions?, maxFindings?, maxCalls?}.',
  workflows: [featureFactory],
  entry: featureFactory,
  prompts: [prompts],
});

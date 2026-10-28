// Packaged rewrite of the pinned MIT upstream acceptance-qa-deep.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import acceptanceQaDeep from './workflows/acceptance-qa-deep.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'acceptance-qa-deep',
  version: '1',
  description:
    "Decompose a ticket's acceptance criteria into binary checks, verify each against a pinned snapshot of the delivered work, and challenge every pass for letter-vs-spirit before code computes the verdict",
  whenToUse:
    'Gating whether finished work truly satisfies its ticket, the check "tests pass" does not make, including the criteria the developer forgot; read-only. Input: {criteria | criteriaFile, ticket?, base?, paths?, checkCommands?, maxCriteria?, maxPatchBytes?}.',
  workflows: [acceptanceQaDeep],
  entry: acceptanceQaDeep,
  prompts: [prompts],
});

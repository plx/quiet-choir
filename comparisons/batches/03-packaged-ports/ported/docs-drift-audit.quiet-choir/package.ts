// Packaged rewrite of the pinned MIT upstream docs-drift-audit.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, Git and policy in lib/, prose in prompts/.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import docsDriftAudit from './workflows/docs-drift-audit.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'docs-drift-audit',
  version: '1',
  description:
    'Decompose each prioritized doc at HEAD into quoted, checkable claims, verify each doc against the code, and report the drift or publish a human-approved patch for it, gated on verifyCommands when given',
  whenToUse:
    'Pre-release doc truthfulness check, or after refactors that likely invalidated READMEs and guides; report-only unless fix is set, and a fix run needs a clean checkout. Input: {paths? (Git pathspecs), fix?, maxDocs?, maxInventory?, maxClaims?, maxDocBytes?, evidenceCommands? (argv or {argv, okExitCodes}), verifyCommands?}.',
  workflows: [docsDriftAudit],
  entry: docsDriftAudit,
  prompts: [prompts],
});

// Packaged rewrite of the pinned MIT upstream security-audit.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import securityAudit from './workflows/security-audit.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'security-audit',
  version: '1',
  description:
    'Map the attack surface of a pinned revision, sweep it with up to six specialist lenses, refute each located finding with a severity-scaled skeptic panel, and write a remediation report',
  whenToUse:
    'Defensive security audit of code you own or are authorized to audit: before launch, after inheriting code, or as a periodic sweep of sensitive surfaces. Read-only and committed code only; also set --max-run-cost-usd. Input: {scope?, lenses?, revision?, maxFindingsPerLens?, crossHarness?}.',
  workflows: [securityAudit],
  entry: securityAudit,
  prompts: [prompts],
});

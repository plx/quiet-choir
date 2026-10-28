// Packaged rewrite of the pinned MIT upstream refactor-campaign.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, the per-target stages and rules in lib/, prose
// in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import refactorCampaign from './workflows/refactor-campaign.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'refactor-campaign',
  version: '1',
  description:
    "Find refactoring targets by measurable pressure, pin each target's behavior with a characterization net that code proves green, and refactor only behind every net after a human approves the plan",
  whenToUse:
    'Behavior-preserving technical-debt paydown, where the safety net is the point, not an afterthought; report-only unless apply is set, and the checkout is untouched until then. Input: {testCommand (runs one test file appended as its last argument), scope?, goal?, maxTargets? (1 to 8), netRounds?, apply?, verifyCommands (at least one with apply)}.',
  workflows: [refactorCampaign],
  entry: refactorCampaign,
  prompts: [prompts],
});

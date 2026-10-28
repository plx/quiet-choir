// Packaged rewrite of the pinned MIT upstream dependency-upgrade.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import dependencyUpgrade from './workflows/dependency-upgrade.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'dependency-upgrade',
  version: '1',
  description:
    'Upgrade a dependency: parallel changelog research and usage impact analysis, one approved plan applied in an isolated checkout, and a bounded code-run verify/triage/fix loop before publication',
  whenToUse:
    'Major-version dependency bumps where breaking changes are likely and usage is nontrivial; the operator names the install and verification commands, and nothing reaches the checkout before a human approves the plan and the commands pass. Input: {package, verifyCommands, toVersion?, maxFixRounds?, manifests?, installCommand?, maxUsageFiles?}.',
  workflows: [dependencyUpgrade],
  entry: dependencyUpgrade,
  prompts: [prompts],
});

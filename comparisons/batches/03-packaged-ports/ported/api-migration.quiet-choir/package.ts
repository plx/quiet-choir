// Packaged rewrite of the pinned MIT upstream api-migration.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import apiMigration from './workflows/api-migration.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'api-migration',
  version: '1',
  description:
    'Discover every call site of an old API, approve a disjoint file-group plan, migrate the groups in parallel isolated worktrees, then verify the integration once with code-run commands and repair the fallout',
  whenToUse:
    'Library swaps, API renames and contract changes with many call sites needing contextual judgment, the long tail codemods cannot handle; nothing is written before a human approves the plan. Input: {from, to, verifyCommands, notes?, paths?, searchTerms?, batchSize?, maxGroups?}.',
  workflows: [apiMigration],
  entry: apiMigration,
  prompts: [prompts],
});

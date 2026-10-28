// Packaged rewrite of the pinned MIT upstream prd-decompose.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import prdDecompose from './workflows/prd-decompose.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'prd-decompose',
  version: '1',
  description:
    'Read a PRD through five parallel lenses, merge the items code can anchor into deduplicated, dependency-ordered tickets with acceptance criteria, and audit coverage backwards with bounded patch repairs',
  whenToUse:
    'Sprint planning from a PRD or spec, producing a backlog whose error states, migrations and instrumentation are ticketed, not just the happy path; composable as a typed child. Input: {prd, codebase?, out?, publication?, maxRepairs?, maxPrdBytes?, maxCodebaseFiles?}.',
  workflows: [prdDecompose],
  entry: prdDecompose,
  prompts: [prompts],
});

// Packaged rewrite of the pinned MIT upstream requirements-to-prd.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import requirementsToPrd from './workflows/requirements-to-prd.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'requirements-to-prd',
  version: '1',
  description:
    'Extract quoted findings from raw requirement material through four lenses, draft a PRD traced to them, attack it with ambiguity, scope and feasibility critics, revise once, and surface unknowns as open questions',
  whenToUse:
    'Turning meeting notes, briefs, transcripts or feedback piles into a PRD honest enough to build from, with unknowns surfaced rather than invented; answers come back as input (a re-run redoes an earlier PRD at out through replace) or through durable question rounds. Input: {input, product?, answers?, questionRounds?, out?, replace?, publication?, maxMaterialBytes?}.',
  workflows: [requirementsToPrd],
  entry: requirementsToPrd,
  prompts: [prompts],
});

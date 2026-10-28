// Packaged rewrite of the pinned MIT upstream prd-to-spec.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts; the
// tournament is the design-tournament package's workflow, run as a typed inline child.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import prdToSpec from './workflows/prd-to-spec.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'prd-to-spec',
  version: '1',
  description:
    'Ground a PRD in the existing codebase, draft a technical spec through five lenses, optionally settle the top load-bearing decision with a design-tournament child, and audit the merged spec for implementability and PRD fidelity with one repair round',
  whenToUse:
    'The step between PRD and tickets: producing a spec an engineer can build from without re-deriving the architecture inside the tickets. Input: {prd, codebase?, decideArchitecture?, judges?, crossHarness?, out?, publication?, maxPrdBytes?, maxCodebaseFiles?}. Under --require-grants nothing needs a grant: no role edits, and the tournament child maps onto the Reader and CodexReader ceilings.',
  workflows: [prdToSpec],
  entry: prdToSpec,
  prompts: [prompts],
});

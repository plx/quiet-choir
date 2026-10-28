// Packaged rewrite of the pinned MIT upstream roadmap-plan.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import roadmapPlan from './workflows/roadmap-plan.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'roadmap-plan',
  version: '1',
  description:
    'Decompose a spec into capabilities with a dependency graph that code checks, sequence them under three competing strategies, pick one by scored panel, stress-test it against the code-computed critical path, and render the revised roadmap in code',
  whenToUse:
    'The milestone-altitude plan between spec and tickets: sequenced, gated, shippable phases with risks located, before prd-decompose or feature work per milestone. Input: {spec, horizon?, priorities?, out?, maxCapabilities?, maxSpecBytes?}.',
  workflows: [roadmapPlan],
  entry: roadmapPlan,
  prompts: [prompts],
});

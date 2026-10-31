// Packaged rewrite of the pinned MIT upstream research-synthesis.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import researchSynthesis from './workflows/research-synthesis.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'research-synthesis',
  version: '1',
  description:
    'Multi-modal lead sweep, ranked deep reads into claim and support pairs, a synthesis whose citations code checks, and one critic-driven round of targeted hunts',
  whenToUse:
    'Technology decisions, state-of-the-art surveys and due-diligence questions that deserve cited evidence over a single search pass. Read-only: web roles have only WebSearch and WebFetch, and local roles only file tools on a snapshot of HEAD. A context enables the local sweep in a Git repository with a commit; elsewhere it only grounds the prompts and the unsearched local territory degrades the result. The critic runs on the Codex CLI (check with quiet-choir configuration doctor); without it the critic fails and the answer is degraded. Input: {question, context?, depth?}.',
  workflows: [researchSynthesis],
  entry: researchSynthesis,
  prompts: [prompts],
});

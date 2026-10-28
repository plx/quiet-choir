// Packaged rewrite of the pinned MIT upstream incident-investigation.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import incidentInvestigation from './workflows/incident-investigation.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'incident-investigation',
  version: '1',
  description:
    'Hypothesis-free evidence collection over a pinned Git window, competing hypotheses, one falsifier each, and a confidence derived in code',
  whenToUse:
    'Post-incident root-cause analysis from a repository and symptoms, structured to resist first-plausible-story bias; read-only throughout. Input: {incident, since, until?, artifacts?, domains?}.',
  workflows: [incidentInvestigation],
  entry: incidentInvestigation,
  prompts: [prompts],
});

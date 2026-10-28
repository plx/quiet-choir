// Packaged rewrite of the pinned MIT upstream design-tournament.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import designTournament from './workflows/design-tournament.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'design-tournament',
  version: '1',
  description:
    "Four proposers with forced-diverse design philosophies, an independent anonymized judge panel scoring a fixed rubric that code tallies, and a synthesis that grafts or rejects each of the losers' best ideas",
  whenToUse:
    'Architecture and product decisions with a wide option space, where a single-track designer would anchor on the first workable idea. Input: {brief, context?, judges?, crossHarness?, out?, publication?}. A parent under --require-grants maps Proposer, Judge and Synthesizer to a Claude ReadOnly ceiling and CodexJudge to a Codex ReadOnly ceiling, even with crossHarness off.',
  workflows: [designTournament],
  entry: designTournament,
  prompts: [prompts],
});

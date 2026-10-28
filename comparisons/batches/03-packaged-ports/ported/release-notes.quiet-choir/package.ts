// Packaged rewrite of the pinned MIT upstream release-notes.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import releaseNotes from './workflows/release-notes.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'release-notes',
  version: '1',
  description:
    'Shard a commit range across diff-reading summarizers, draft audience-aware notes, and fact-check them in both directions',
  whenToUse:
    'Cutting a release or backfilling a changelog, when the notes must be readable and provably cover the range. Input: {since, until?, audience?, out?, publication?}.',
  workflows: [releaseNotes],
  entry: releaseNotes,
  prompts: [prompts],
});

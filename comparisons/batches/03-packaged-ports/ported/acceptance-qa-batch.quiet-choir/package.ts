// Packaged rewrite of the pinned MIT upstream acceptance-qa-batch.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts, and the
// probe mechanics and verdict rules in lib/.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import acceptanceQaBatch from './workflows/acceptance-qa-batch.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'acceptance-qa-batch',
  version: '1',
  description:
    'Per ticket: demonstrate every acceptance criterion with an approved probe that code runs against a pinned commit, then attack the feature with approved probes; pass = demonstrated AND unbroken, judged by exit codes',
  whenToUse:
    'Acceptance QA on finished work — verifying committed tickets meet their own criteria before merge or release, beyond unit-test green; report-only. Input: {tickets, probeCommand, scope?, maxTickets?, maxAttacks?, probeTimeoutMs?}.',
  workflows: [acceptanceQaBatch],
  entry: acceptanceQaBatch,
  prompts: [prompts],
});

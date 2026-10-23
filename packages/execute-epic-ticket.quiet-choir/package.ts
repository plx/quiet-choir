// The execute-epic-ticket package (ADR 0065): execute-epic-ticket ported from the native Claude
// Code workflow script execute-epic-ticket.js (removed in #693; last at commit 657334c) and its
// helper CLI. It lands each ticket's pull request through the merge-down package's workflow as a
// typed inline child. See README.md.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import executeEpicTicket from './workflows/execute-epic-ticket.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'execute-epic-ticket',
  version: '1',
  description:
    'Find and execute one ticket from an epic: pick the next ready ticket, check it is still valid and plan it, implement it in a dedicated worktree, open a PR, land it via merge-down-pr, tick the epic — or report the epic done, stalled, or waiting on a decision',
  whenToUse:
    'Burning down an epic one ticket per run, in the order its checklist gives. Input: {epic, ticket?, decision?, until?, followupEpic?, standingNotes?, repo?}.',
  workflows: [executeEpicTicket],
  entry: executeEpicTicket,
  prompts: [prompts],
});

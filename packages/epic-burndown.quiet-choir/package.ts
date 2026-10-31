// The epic-burndown package: execute-epic-ticket, one run per ticket, until the epic is done or a
// person must act. See README.md.
import { definePackage } from 'quiet-choir';
import epicBurndown from './workflows/epic-burndown.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'epic-burndown',
  version: '1',
  description:
    'Burn an epic down: run execute-epic-ticket once per ticket until the epic is done, stalled, blocked or waiting on a decision',
  whenToUse:
    'Unattended burn-down of an epic with native sub-issues. Input: {ticketInput: <execute-epic-ticket input without ticket>, maxTickets?}.',
  workflows: [epicBurndown],
  entry: epicBurndown,
});

// epic-burndown: burn an epic down one ticket at a time by running execute-epic-ticket as a typed
// inline child until the epic is done or a run returns a status a person must act on. Control flow
// only. Every child surveys the epic afresh (its frame ID is new), so each picks the next ticket the
// previous run left; the follow-up epic a run created is passed to the next.
import { defineWorkflow } from 'quiet-choir';
import { EpicTicketInput } from '../../execute-epic-ticket.quiet-choir/contracts.js';
import executeEpicTicket from '../../execute-epic-ticket.quiet-choir/workflows/execute-epic-ticket.js';
import { BurndownInput, BurndownResult, CONTINUE } from '../contracts.js';

export default defineWorkflow({
  name: 'epic-burndown',
  version: '1',
  description:
    'Burn an epic down: run execute-epic-ticket once per ticket until the epic is done, stalled, blocked or waiting on a decision',
  whenToUse:
    'Unattended burn-down of an epic with native sub-issues. Input: {ticketInput: <execute-epic-ticket input without ticket>, maxTickets?}.',
  input: BurndownInput,
  output: BurndownResult,
  children: [executeEpicTicket],
  async run(ctx, A) {
    const base = EpicTicketInput.parse(A.ticketInput);
    if (base.ticket !== undefined || base.decision !== undefined)
      throw new TypeError('epic-burndown picks its own tickets: leave ticket and decision out');
    const record: BurndownResult = {
      epic: base.epic,
      status: 'max-tickets',
      runs: [],
      stoppedBy: null,
      followupEpic: base.followupEpic ?? null,
      remaining: null,
      headline: '',
    };
    for (let run = 1; run <= A.maxTickets; run++) {
      ctx.phase(`Run ${String(run)}`);
      const input = EpicTicketInput.parse({
        ...(A.ticketInput as object),
        ...(record.followupEpic === null ? {} : { followupEpic: record.followupEpic }),
      });
      const result = await ctx.workflow(ctx.id('run', run), executeEpicTicket, input);
      record.runs.push({
        run,
        ticket: result.ticket?.number ?? null,
        title: result.ticket?.title ?? null,
        status: result.status,
        pr: result.pr?.number ?? null,
        mergeCommit: result.pr?.mergeCommit ?? null,
        headline: result.headline,
        blocked: result.blocked,
      });
      record.followupEpic = result.followupEpic ?? record.followupEpic;
      record.remaining = result.remaining ?? null;
      ctx.log(`Run ${String(run)}: ${result.status}. ${result.headline ?? ''}`);
      if (result.status === 'epic-done') {
        record.status = 'epic-done';
        break;
      }
      if (!(CONTINUE as readonly string[]).includes(result.status)) {
        record.status = 'stopped';
        record.stoppedBy = result.status;
        break;
      }
    }
    const landed = record.runs.filter((r) => r.status === 'landed').length;
    const closed = record.runs.filter((r) => r.status.startsWith('closed')).length;
    const last = record.runs.at(-1);
    record.headline =
      `Epic #${String(base.epic)}: ${String(record.runs.length)} run(s), ${String(landed)} landed, ${String(closed)} closed without a PR; ` +
      (record.status === 'epic-done'
        ? 'the epic is done.'
        : record.status === 'stopped'
          ? `stopped at ${last?.ticket === null || last === undefined ? 'the survey' : `#${String(last.ticket)}`} (${String(record.stoppedBy)}): ${last?.headline ?? ''}`
          : `reached maxTickets (${String(A.maxTickets)}).`);
    return record;
  },
});

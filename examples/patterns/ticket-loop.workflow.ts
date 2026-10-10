import { defineWorkflow, z } from '../../src/index.js';
import { github, nextTicket } from '../../src/integrations/github.js';

export default defineWorkflow({
  name: 'ticket-loop',
  version: '1',
  input: z.object({ repo: z.string(), epic: z.int().positive(), ticket: z.int().positive() }),
  output: z.object({ status: z.enum(['closed', 'skipped']), next: z.int().nullable() }),
  async run(ctx, { repo, epic, ticket }) {
    const gh = github(ctx, { repo });
    // One run per ticket (run ID ticket-N): each snapshot ID occurs once in the run.
    // A skip completes this run ID, so the driver removes the saved run to retry the ticket.
    const pick = async (id: string) =>
      nextTicket(await gh.epic.snapshot(id, { number: epic })).pick?.number ?? null;
    const before = await pick('before');
    if (before !== ticket) return { status: 'skipped', next: before };
    const issue = await gh.issue.view('issue', { number: ticket, comments: true });
    const thread = issue.comments.map((comment) => comment.body).join('\n\n---\n\n');
    await ctx.claude.text('implement', {
      profile: 'edit',
      prompt: `Implement #${String(ticket)}: ${issue.title}\n\n${issue.body}\n\n${thread}`,
    });
    // A real loop opens and lands a pull request here; close is check-then-act.
    await gh.issue.close('close', { number: ticket });
    return { status: 'closed', next: await pick('after') };
  },
});

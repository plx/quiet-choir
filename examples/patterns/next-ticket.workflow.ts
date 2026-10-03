import { defineWorkflow, z } from '../../src/index.js';
import { github, nextTicket, outsideReferences } from '../../src/integrations/github.js';

const skip = z.object({ number: z.int(), reason: z.string() });
export default defineWorkflow({
  name: 'next-ticket',
  version: '1',
  input: z.object({ repo: z.string(), epic: z.int().positive(), round: z.int().nonnegative() }),
  output: z.object({
    repository: z.string(),
    pick: z.int().nullable(),
    title: z.string().nullable(),
    comments: z.int(),
    skipped: z.array(skip),
    done: z.boolean(),
  }),
  async run(ctx, { repo, epic, round }) {
    const gh = github(ctx, { repo });
    const { nameWithOwner } = await gh.repo.info('repo');
    // Keyed by round: a resume replays this snapshot, and the next round reads fresh epic state.
    const snapshot = await gh.epic.snapshot(ctx.id('epic', epic, round), { number: epic });
    // Dependencies and slices outside the epic: read their states so the selector stays pure.
    const outside = [];
    for (const number of outsideReferences(snapshot))
      outside.push(await gh.issue.view(ctx.id('outside', number, round), { number }));
    const { pick, skipped, done } = nextTicket(snapshot, { outside });
    const ticket = pick
      ? await gh.issue.view(ctx.id('ticket', pick.number, round), {
          number: pick.number,
          comments: true,
        })
      : null;
    return {
      repository: nameWithOwner,
      pick: pick?.number ?? null,
      title: ticket?.title ?? null,
      comments: ticket?.comments.length ?? 0,
      skipped: skipped.map(({ number, reason }) => ({ number, reason })),
      done,
    };
  },
});

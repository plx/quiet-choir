import { defineWorkflow, z } from '../../src/index.js';
import { reviewRevise } from './review-team.js';
import { reviewRoster } from './roster.js';

export default defineWorkflow({
  name: 'review-revise',
  version: '2',
  roster: reviewRoster,
  input: z.object({ draft: z.string(), rounds: z.int().min(1).max(10) }),
  output: z.object({ approved: z.boolean(), draft: z.string() }),
  run: (ctx, { draft, rounds }) =>
    reviewRevise({
      team: { actor: ctx.roster.Writer, critic: ctx.roster.Reviewer },
      draft,
      rounds,
    }),
});

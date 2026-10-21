import { defineTeam, z, type TeamOf } from '../../src/index.js';

// The roles a review/revise loop needs; any structured agents fill them.
export const ReviewTeam = defineTeam({
  actor: 'Produces and revises the draft.',
  critic: 'Judges the draft and returns feedback.',
});
export type ReviewTeam = TeamOf<typeof ReviewTeam>;

const Review = z.object({ approved: z.boolean(), feedback: z.string() });

/** Review up to `rounds` times; the final round is not followed by an unreviewed revision. */
export async function reviewRevise(args: {
  team: ReviewTeam;
  draft: string;
  rounds: number;
}): Promise<{ approved: boolean; draft: string }> {
  const { team, rounds } = args;
  let draft = args.draft;
  for (let round = 0; round < rounds; round++) {
    const review = await team.critic.value(`review/${String(round)}`, {
      prompt: `Review this draft: ${draft}`,
      schema: Review,
    });
    if (review.approved) return { approved: true, draft };
    if (round + 1 < rounds) {
      draft = await team.actor.value(`revise/${String(round)}`, {
        prompt: `Revise ${draft} using this feedback: ${review.feedback}`,
      });
    }
  }
  return { approved: false, draft };
}

// design-tournament: control flow only. An existing out refuses the run before any agent call.
// Four philosophies propose as a settled map; an anonymized panel scores every surviving proposal
// as another, each seat in its own order; code tallies the rubric, picks the winner and finds
// dissent; one synthesizer grafts or rejects each losing idea by ID; code appends the tournament
// record and writes the document.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  DesignTournamentInput,
  DesignTournamentOutput,
  Proposal,
  Scorecard,
  Synthesis,
  type Entry,
  type Letter,
} from '../contracts.js';
import {
  anonymous,
  dissentOf,
  entrants,
  ideasOf,
  ledger,
  missingFile,
  presented,
  seats,
  status,
  tally,
  winnerOf,
  type Card,
} from '../lib/policy.js';
import { render } from '../lib/render.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

// A schema-invalid or transient failure gets one more attempt before it counts as a failed member.
const retry = { maxAttempts: 2, on: ['schema', 'transient'] } as const;

export default defineWorkflow({
  name: 'design-tournament',
  version: 'packaged-03',
  description:
    'Propose under four forced philosophies, score anonymized proposals with an independent panel, tally in code and synthesize with recorded grafts.',
  roster,
  prompts: [prompts],
  input: DesignTournamentInput,
  output: DesignTournamentOutput,
  async run(ctx, input) {
    const { brief, context } = input;
    const empty = {
      winner: null,
      scoreboard: [],
      design: null,
      grafts: [],
      dissent: [],
      proposals: [],
      failedProposals: [],
      failedJudges: [],
      written: null,
    };
    // Both publications create out exclusively, so an existing one is refused before it is paid for.
    if (input.out !== null) {
      const existing = await ctx.readFile('existing', input.out, { onError: 'return' });
      if (!missingFile(existing)) return { ...empty, status: 'refused' };
    }
    // `version` names the prompt and schema, which a settled map's fingerprint does not show.
    const drafted = await ctx.map(
      'proposals',
      entrants,
      { concurrency: 4, onError: 'return', version: 'propose/1', key: (e) => e.philosophy },
      ({ philosophy }) =>
        ctx.roster.Proposer.value('propose', {
          schema: Proposal,
          prompt: prompts.Propose({ brief, context, philosophy }),
          retry,
        }),
    );
    const proposals: Entry[] = entrants.flatMap((entrant, index) => {
      const result = drafted[index];
      return result?.ok ? [{ ...entrant, ...result.value }] : [];
    });
    const report = {
      ...empty,
      proposals,
      failedProposals: entrants.filter((_, index) => !drafted[index]?.ok).map((e) => e.philosophy),
    };
    const [first, ...others] = proposals;
    if (!first || !others.length) return { ...report, status: 'aborted' };
    const letters: [Letter, ...Letter[]] = [first.letter, ...others.map((p) => p.letter)];
    const panel = seats(input.judges, input.crossHarness);
    const scored = await ctx.map(
      'judges',
      panel,
      { concurrency: 4, onError: 'return', version: 'judge/1' },
      ({ seat, harness }) => {
        const judge = harness === 'codex' ? ctx.roster.CodexJudge : ctx.roster.Judge;
        return judge.value('score', {
          schema: Scorecard(letters),
          prompt: prompts.Judge({
            brief,
            context,
            seat,
            judges: input.judges,
            proposals: presented(proposals, seat),
          }),
          retry,
        });
      },
    );
    const cards: Card[] = panel.flatMap(({ seat }, index) => {
      const result = scored[index];
      return result?.ok ? [{ seat, scores: result.value.scores }] : [];
    });
    const failedJudges = panel.filter((_, index) => !scored[index]?.ok).map((s) => s.seat);
    if (!cards.length) return { ...report, failedJudges, status: 'unjudged' };
    const scoreboard = tally(proposals, cards);
    const winner = winnerOf(scoreboard);
    const dissent = dissentOf(winner, cards);
    const ideas = ideasOf(scoreboard, cards);
    const skeleton = proposals.find((p) => p.letter === winner.letter) ?? first;
    const synthesis = await ctx.roster.Synthesizer.value('synthesize', {
      schema: Synthesis(ideas.map((idea) => idea.id)),
      prompt: prompts.Synthesize({
        brief,
        context,
        // The judges whose scorecards counted; failed seats are in the appended record.
        judges: cards.length,
        scoreboard,
        winner,
        proposal: anonymous(skeleton),
        ideas,
        dissent,
      }),
      retry,
    });
    const record = { ...report, failedJudges, winner, scoreboard, dissent };
    const grafts = ledger(ideas, synthesis.grafts);
    const design = render(synthesis.design, { ...record, grafts });
    // Exclusive creation still refuses a document that appeared after the check above.
    const written =
      input.out === null
        ? null
        : input.publication === 'commit'
          ? await std.exec.committedArtifact(ctx, input.out, `${design}\n`)
          : await ctx.writeFile('write', input.out, `${design}\n`, { ifMatch: null });
    return { ...record, grafts, design, written, status: status({ ...record, grafts }) };
  },
});

// bug-hunt: control flow only. Each round's finders and each candidate's skeptics are
// std.patterns.tolerantPanel calls, so a failed member is journaled and counted, never retried
// into a different outcome on resume.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { BugHuntInput, BugHuntOutput, BugList, Verdict, type Finding } from '../contracts.js';
import { bySeverity, judge, keyOf, lensesFor, lensesPerRound } from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'bug-hunt',
  version: 'packaged-03',
  description:
    'Run tolerant finder and skeptic panels, preserve uncertainty, and bound logical admissions.',
  roster,
  prompts: [prompts],
  input: BugHuntInput,
  output: BugHuntOutput,
  async run(ctx, input) {
    let rounds = 0,
      dryRounds = 0,
      callsAdmitted = 0,
      failedFinders = 0,
      failedSkeptics = 0,
      skippedSkeptics = 0;
    const findings: Finding[] = [];
    const seen = new Set<string>();
    while (
      rounds < input.maxRounds &&
      dryRounds < 2 &&
      callsAdmitted + lensesPerRound <= input.maxCalls
    ) {
      const round = ctx.within(ctx.id('round', rounds));
      const lenses = lensesFor(rounds++);
      callsAdmitted += lenses.length;
      // `version` names the prompt and schema, which a settled map's fingerprint does not show.
      const hunt = await std.patterns.tolerantPanel(round, {
        id: 'finders',
        team: { panelist: round.roster.Finder },
        items: lenses,
        concurrency: 3,
        schema: BugList,
        version: 'find/1',
        prompt: (lens) => prompts.Find({ scope: input.scope, lens, round: rounds }),
      });
      failedFinders += hunt.failed;
      // Dedup against everything seen, never against confirmed, or a refuted bug returns forever.
      const fresh = hunt.answers
        .flatMap((answer) => answer.bugs)
        .filter((bug) => {
          const key = keyOf(bug);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      dryRounds = !hunt.failed && !fresh.length ? dryRounds + 1 : 0;
      for (const [index, bug] of fresh.entries()) {
        const votes = Math.min(input.votes, input.maxCalls - callsAdmitted);
        callsAdmitted += votes;
        skippedSkeptics += input.votes - votes;
        const panel = await std.patterns.tolerantPanel(round, {
          id: ctx.id('skeptics', index),
          team: { panelist: round.roster.Skeptic },
          items: Array.from({ length: votes }, (_, seat) => ({ bug, seat: seat + 1 })),
          concurrency: 3,
          schema: Verdict,
          version: 'refute/1',
          prompt: (item) => prompts.Refute({ ...item, votes: input.votes }),
        });
        failedSkeptics += panel.failed;
        findings.push(judge(bug, panel.answers, input.votes));
      }
    }
    const undecided = findings.filter((finding) => finding.outcome === 'undecided').length;
    const limited =
      skippedSkeptics > 0 ||
      (rounds < input.maxRounds &&
        dryRounds < 2 &&
        callsAdmitted + lensesPerRound > input.maxCalls);
    return {
      status: limited
        ? 'call-limit'
        : failedFinders || failedSkeptics || undecided
          ? 'degraded'
          : 'complete',
      rounds,
      dryRounds,
      callsAdmitted,
      failedFinders,
      failedSkeptics,
      skippedSkeptics,
      undecided,
      findings: bySeverity(findings),
    };
  },
});

// Pure rules: the letter assignment, the judge seats and their presentation order, the rubric
// tally, the winner and its tie-break, dissent, the losers' ideas and the graft ledger.
import {
  Axis,
  Letter,
  Philosophy,
  type Dissent,
  type Entry,
  type Graft,
  type Idea,
  type Lettered,
  type Score,
  type Seat,
  type Standing,
  type Winner,
} from '../contracts.js';

/** Each philosophy under its fixed anonymous letter: A is ship-simplest, D failure-first. */
export const entrants = Philosophy.options.map((philosophy, index) => ({
  philosophy,
  letter: Letter.options[index] ?? 'A',
}));

/** The judge seats, numbered from one; with crossHarness every second seat is a Codex judge. */
export const seats = (judges: number, crossHarness: boolean): Seat[] =>
  Array.from({ length: judges }, (_, index) => ({
    seat: index + 1,
    harness: crossHarness && index % 2 === 1 ? 'codex' : 'claude',
  }));

/**
 * The proposals as one seat reads them: without their philosophy, and rotated by seat, so a
 * position bias does not push every judge the same way.
 */
export function presented(proposals: Entry[], seat: number): Lettered[] {
  const shift = (seat - 1) % proposals.length;
  return [...proposals.slice(shift), ...proposals.slice(0, shift)].map(anonymous);
}

/** A proposal under its letter alone. */
export const anonymous = ({ philosophy: _philosophy, ...proposal }: Entry): Lettered => proposal;

/** One judge's surviving scorecard, kept with its seat. */
export interface Card {
  readonly seat: number;
  readonly scores: readonly Score[];
}

const round = (value: number) => Math.round(value * 10) / 10;
export const total = (score: Score) =>
  score.fitness + score.simplicity + score.evolvability + score.operability;

/**
 * The scoreboard: each proposal's mean total and mean per axis over the cards that scored it,
 * ranked by the rounded mean, then by mean fitness, then by letter. Aggregation is arithmetic, not
 * judgment.
 */
export function tally(proposals: Entry[], cards: Card[]): Standing[] {
  const standings = proposals.map((proposal) => {
    const scores = cards.flatMap((card) =>
      card.scores.filter((score) => score.proposal === proposal.letter),
    );
    const mean = (value: (score: Score) => number) =>
      scores.length
        ? round(scores.reduce((sum, score) => sum + value(score), 0) / scores.length)
        : 0;
    return {
      letter: proposal.letter,
      philosophy: proposal.philosophy,
      title: proposal.title,
      avg: mean(total),
      votes: scores.length,
      axes: Object.fromEntries(
        Axis.options.map((name) => [name, mean((score) => score[name])]),
      ) as Standing['axes'],
    };
  });
  return standings.sort(
    (a, b) =>
      b.avg - a.avg ||
      b.axes.fitness - a.axes.fitness ||
      Letter.options.indexOf(a.letter) - Letter.options.indexOf(b.letter),
  );
}

/** The first standing, with the letters that had the same average and lost the tie-break. */
export function winnerOf(scoreboard: Standing[]): Winner {
  const [first, ...rest] = scoreboard;
  if (!first) throw new Error('A tournament needs at least one standing');
  const tiedWith = rest.filter((standing) => standing.avg === first.avg).map((s) => s.letter);
  return { ...first, tiedWith };
}

/**
 * A judge whose own total for the winner is at least 6 below its panel average is signal about a
 * real weakness, surfaced rather than averaged away.
 */
export const dissentOf = (winner: Winner, cards: Card[]): Dissent[] =>
  cards.flatMap((card) => {
    const score = card.scores.find((candidate) => candidate.proposal === winner.letter);
    if (!score || total(score) > winner.avg - 6) return [];
    return [{ judge: card.seat, total: total(score), avg: winner.avg, rationale: score.rationale }];
  });

const normal = (text: string) => text.trim().replace(/\s+/gu, ' ').toLowerCase();

/**
 * The losing proposals' best ideas, in scoreboard order: one entry per distinct text per loser,
 * listing every judge that named it, with an ID such as B1 that the synthesizer answers by.
 */
export function ideasOf(scoreboard: Standing[], cards: Card[]): Idea[] {
  return scoreboard.slice(1).flatMap((loser) => {
    const ideas: Idea[] = [];
    for (const card of cards) {
      const idea = card.scores.find((score) => score.proposal === loser.letter)?.bestIdea;
      if (!idea) continue;
      const same = ideas.find((known) => normal(known.idea) === normal(idea));
      if (same) same.judges.push(card.seat);
      else
        ideas.push({
          id: `${loser.letter}${String(ideas.length + 1)}`,
          from: loser.letter,
          title: loser.title,
          idea: idea.trim(),
          judges: [card.seat],
        });
    }
    return ideas;
  });
}

/** The graft ledger: the synthesizer's first decision per idea, or null when it gave none. */
export function ledger(
  ideas: Idea[],
  decisions: readonly { idea: string; decision: Graft['decision']; reason: string }[],
): Graft[] {
  return ideas.map((idea) => {
    const decided = decisions.find((decision) => decision.idea === idea.id);
    return { ...idea, decision: decided?.decision ?? null, reason: decided?.reason ?? null };
  });
}

/**
 * True when a settled read of out found no file. A read that succeeded, or failed on an oversized,
 * binary or non-regular file, means something is already there. Settled file failures carry no
 * structured "missing" kind (a missing file is saved as kind `process`), so this reads the errno
 * code that Node puts first in the message.
 */
export const missingFile = (read: { ok: true } | { ok: false; error: { message: string } }) =>
  !read.ok && /^ENOENT\b/u.test(read.error.message);

/** Complete only when every proposer and judge answered and every idea was decided. */
export const status = (report: {
  failedProposals: unknown[];
  failedJudges: unknown[];
  grafts: Graft[];
}) =>
  report.failedProposals.length ||
  report.failedJudges.length ||
  report.grafts.some((graft) => graft.decision === null)
    ? ('degraded' as const)
    : ('complete' as const);

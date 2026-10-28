// Pure rules: lens rotation, candidate keys, the majority verdict and the result ordering.
import type { Bug, Finding, Verdict } from '../contracts.js';

/**
 * A pool much larger than one round uses; each round takes the next slice, so round two hunts
 * differently from round one over the same files.
 */
const lensPool = [
  'error handling: swallowed exceptions, catch blocks that hide failures, missing error propagation, errors logged but not handled',
  'boundary conditions: off-by-one, empty collections, zero/negative numbers, unicode and encoding edges, max-size inputs',
  'concurrency: race conditions, shared mutable state, missing locks or atomicity, async ordering assumptions, TOCTOU',
  'resource lifecycle: leaks of handles/connections/subscriptions, missing cleanup on error paths, double-free/double-close',
  'state machines: invalid state transitions, initialization order, stale caches, partial updates that leave inconsistent state',
  'contract violations: callers that break callee assumptions, nullability mismatches, silently-widened types, ignored return values',
  'time and ordering: timezone bugs, DST edges, clock skew assumptions, sort stability, iteration-order dependence',
  'input validation: unvalidated external input reaching logic, type confusion at parse boundaries, injection into shells/queries/paths',
];
export const lensesPerRound = 3;

/** The deterministic lens slice of a zero-based round. */
export const lensesFor = (round: number): string[] =>
  Array.from(
    { length: lensesPerRound },
    (_, index) => lensPool[(round * lensesPerRound + index) % lensPool.length] ?? '',
  );

/** File plus normalized title, so a reworded duplicate from a later round still collides. */
export const keyOf = (bug: Bug): string =>
  `${bug.file}:${bug.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()}`;

/**
 * A fixed majority of the seats requested. Missing seats (failed or never admitted) stay in the
 * arithmetic, so a candidate that could still reach a majority is undecided, not refuted.
 */
export function judge(bug: Bug, verdicts: Verdict[], votes: number): Finding {
  const majority = Math.floor(votes / 2) + 1;
  const upheld = verdicts.filter((verdict) => !verdict.refuted).length;
  const missing = votes - verdicts.length;
  return {
    bug,
    outcome:
      upheld >= majority ? 'confirmed' : upheld + missing >= majority ? 'undecided' : 'refuted',
    upheld,
    missing,
    reasons: verdicts.map((verdict) => verdict.reasoning),
  };
}

const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Most severe first; a stable sort keeps discovery order within a severity. */
export const bySeverity = (findings: Finding[]): Finding[] =>
  [...findings].sort((a, b) => rank[a.bug.severity] - rank[b.bug.severity]);

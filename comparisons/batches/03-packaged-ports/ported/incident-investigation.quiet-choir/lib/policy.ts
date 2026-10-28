// Pure rules. Confidence comes from the structure of the verdicts, not from a model's feeling.
import type { Confidence, Judged } from '../contracts.js';

/**
 * One survivor with at least one rival falsified is high; a lone survivor is medium; several
 * survivors are split; none is none. A failed falsifier leaves its hypothesis unchallenged, so a
 * rival that was never attacked keeps a lone survivor at medium.
 */
export function structuralConfidence(judged: Judged[]): Confidence {
  const count = (verdict: string) =>
    judged.filter((hypothesis) => hypothesis.verdict?.verdict === verdict).length;
  const unchallenged = judged.filter((hypothesis) => hypothesis.verdict === null).length;
  const survivors = count('survives');
  if (survivors === 1 && count('falsified') >= 1 && unchallenged === 0) return 'high';
  if (survivors === 1) return 'medium';
  if (survivors > 1) return 'split';
  return 'none';
}

/** The story of the only survivor, or null. */
export const rootCause = (judged: Judged[]): string | null => {
  const survivors = judged.filter((hypothesis) => hypothesis.verdict?.verdict === 'survives');
  return survivors.length === 1 ? (survivors[0]?.story ?? null) : null;
};

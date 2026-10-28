// Pure rules: the changed-line budget, cross-dimension deduplication, the verification slots, the
// verdict rule, the read-only receipt check, the status and the report when nothing survived.
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type {
  Candidate,
  ChangedFile,
  Confirmed,
  Dimension,
  Dismissed,
  Finding,
  Severity,
  Verdict,
} from '../contracts.js';

const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const lines = (file: ChangedFile) => (file.added ?? 0) + (file.deleted ?? 0);

/** Whole files in path order while they fit the budget; a file that does not fit is reported. */
export function budget(files: ChangedFile[], max: number) {
  let used = 0;
  const reviewed: ChangedFile[] = [];
  const unreviewed: ChangedFile[] = [];
  for (const file of files)
    if (used + lines(file) <= max) {
      used += lines(file);
      reviewed.push(file);
    } else unreviewed.push(file);
  return { reviewed, unreviewed };
}

const normalized = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
const same = (a: Finding, b: Finding) =>
  a.file === b.file &&
  (a.line !== null && b.line !== null
    ? Math.abs(a.line - b.line) < 5
    : a.line === b.line && normalized(a.title) === normalized(b.title));

/**
 * Merge findings on one file fewer than five lines apart (without lines: with the same title),
 * keeping the more severe copy and, on a tie, the earlier one. Upstream bucketed lines by
 * floor(line / 5), which split neighbours at bucket edges and put every line-less finding of a
 * file in the bucket of lines 1 to 4; here the absorbed titles stay on the kept copy, so a merge
 * never hides a finding.
 */
export function dedupe(reviews: { dimension: Dimension; findings: Finding[] }[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const { dimension, findings } of reviews)
    for (const finding of findings) {
      const index = candidates.findIndex((candidate) => same(candidate, finding));
      const kept = candidates[index];
      if (!kept) {
        candidates.push({ ...finding, dimensions: [dimension], absorbed: [] });
        continue;
      }
      const others = kept.dimensions.filter((other) => other !== dimension);
      candidates[index] =
        rank[finding.severity] < rank[kept.severity]
          ? {
              ...finding,
              dimensions: [dimension, ...others],
              absorbed: [...kept.absorbed, kept.title],
            }
          : {
              ...kept,
              dimensions: kept.dimensions.includes(dimension)
                ? kept.dimensions
                : [...kept.dimensions, dimension],
              absorbed: [...kept.absorbed, finding.title],
            };
    }
  return candidates;
}

const bySeverity = <T extends { severity: Severity }>(items: T[]): T[] =>
  [...items].sort((a, b) => rank[a.severity] - rank[b.severity]);

/** The most severe, then the most corroborated, win the skeptic slots; the rest are reported. */
export function slots(candidates: Candidate[], max: number) {
  const ordered = [...candidates].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || b.dimensions.length - a.dimensions.length,
  );
  return { checked: ordered.slice(0, max), unchecked: ordered.slice(max) };
}

/** A finding survives only a verdict that did not refute it; a failed skeptic never confirms. */
export function judge(checked: Candidate[], verdicts: Settled<Verdict, MapStepError>[]) {
  const confirmed: Confirmed[] = [];
  const rejected: Dismissed[] = [];
  const unverified: Dismissed[] = [];
  for (const [index, candidate] of checked.entries()) {
    const verdict = verdicts[index];
    if (!verdict?.ok)
      unverified.push({
        ...candidate,
        why: `Skeptic failed (${verdict?.error.kind ?? 'missing'}); not confirmed`,
      });
    else if (verdict.value.refuted) rejected.push({ ...candidate, why: verdict.value.reasoning });
    else
      confirmed.push({
        ...candidate,
        severity: verdict.value.adjustedSeverity ?? candidate.severity,
        reportedSeverity: candidate.severity,
        reasoning: verdict.value.reasoning,
      });
  }
  return { confirmed: bySeverity(confirmed), rejected, unverified };
}

/** The output of a reviewer or skeptic, refused when it changed its read-only snapshot. */
export function readOnly<T>(result: { output: T; worktree?: WorktreeChange }): T {
  if (!result.worktree) throw new Error('A snapshot call returned no receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its snapshot: ${JSON.stringify(result.worktree.files)}`,
    );
  return result.output;
}

interface Accounting {
  readonly unreviewedFiles: unknown[];
  readonly unchecked: unknown[];
  readonly unreviewedDimensions: Dimension[];
  readonly unverified: unknown[];
}

/** A cap that left work undone is limited; a failed reviewer or skeptic is degraded. */
export function status(review: Accounting): 'complete' | 'degraded' | 'limited' {
  if (review.unreviewedFiles.length || review.unchecked.length) return 'limited';
  if (review.unreviewedDimensions.length || review.unverified.length) return 'degraded';
  return 'complete';
}

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** The report when nothing was confirmed, from counts alone, so it needs no agent. */
export function plainReport(
  review: Accounting & { files: number; dimensions: Dimension[]; rejected: number },
): string {
  const { unreviewedFiles, unchecked, unreviewedDimensions, unverified, rejected } = review;
  const parts = [
    `Reviewed ${count(review.files, 'file')} across ${count(review.dimensions.length, 'dimension')}.`,
  ];
  if (unreviewedDimensions.length)
    parts.push(`Reviews that failed and are missing: ${unreviewedDimensions.join(', ')}.`);
  if (unreviewedFiles.length)
    parts.push(
      `${count(unreviewedFiles.length, 'changed file')} past maxChangedLines went unreviewed.`,
    );
  if (!rejected && !unverified.length && !unchecked.length) parts.push('No findings.');
  else {
    parts.push('No finding was confirmed:');
    const outcomes = [
      rejected ? `${String(rejected)} refuted under adversarial verification` : '',
      unverified.length ? `${String(unverified.length)} with a failed skeptic` : '',
      unchecked.length ? `${String(unchecked.length)} past maxFindings, never verified` : '',
    ];
    parts.push(`${outcomes.filter(Boolean).join('; ')}.`);
  }
  return parts.join(' ');
}

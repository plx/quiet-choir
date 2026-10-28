// Pure rules: the checklist and its cap, a criterion's status from its sub-checks, the
// letter-vs-spirit downgrade, the gate verdict, the must-fix and manual lists and the summary code
// writes when the narrator fails.
import type { MapStepError, Settled } from 'quiet-choir';
import type {
  Checked,
  Decomposition,
  Graded,
  Planned,
  Status,
  SubCheck,
  Verdict,
} from '../contracts.js';

/** Stated criteria first, then implied ones (flagged), so the forgotten ones count; then the cap. */
export function checklist(decomposition: Decomposition, max: number) {
  const planned: Planned[] = [
    ...decomposition.criteria.map((criterion) => ({ ...criterion, implied: false })),
    ...decomposition.impliedCriteria.map((criterion) => ({
      criterion,
      checks: [criterion],
      kind: 'behavior' as const,
      implied: true,
    })),
  ];
  return { checked: planned.slice(0, max), skipped: planned.slice(max) };
}

/** Pair each sub-check with the checker's answer at the same position. */
export const pair = (checks: string[], results: Omit<SubCheck, 'check'>[]): SubCheck[] =>
  checks.map((check, index) => {
    const result = results[index];
    if (!result)
      throw new Error(`Checker answered ${results.length} of ${checks.length} sub-checks`);
    return { check, ...result };
  });

/** Pass when every sub-check holds; partial when some hold and some fail; fails beat unknowns. */
export function statusOf(checks: SubCheck[]): 'pass' | 'fail' | 'partial' | 'cannot-verify' {
  const count = (outcome: SubCheck['outcome']) =>
    checks.filter((check) => check.outcome === outcome).length;
  if (count('fails') > 0) return count('holds') > 0 ? 'partial' : 'fail';
  if (count('cannot-verify') > 0) return 'cannot-verify';
  return 'pass';
}

/**
 * Grade every planned criterion. A pass the challenger found dishonest is fail-spirit; a pass
 * whose challenge failed is unchallenged, never a clean pass; a failed checker leaves its
 * criterion unchecked; criteria past the cap are skipped.
 */
export function grade(
  checked: Planned[],
  settled: Settled<Checked, MapStepError>[],
  skipped: Planned[],
): Graded[] {
  const graded = checked.map((planned, index): Graded => {
    const { criterion, kind, implied } = planned;
    const result = settled[index];
    if (!result?.ok)
      return { criterion, kind, implied, status: 'unchecked', checks: [], gotcha: null };
    const { checks, challenge, challengeFailed } = result.value;
    let status: Status = statusOf(checks);
    if (status === 'pass' && challengeFailed) status = 'unchallenged';
    if (status === 'pass' && challenge && !challenge.honest) status = 'fail-spirit';
    const gotcha =
      challenge && !challenge.honest ? (challenge.gotcha ?? challenge.reasoning) : null;
    return { criterion, kind, implied, status, checks, gotcha };
  });
  return [
    ...graded,
    ...skipped.map(({ criterion, kind, implied }) => ({
      criterion,
      kind,
      implied,
      status: 'skipped' as const,
      checks: [],
      gotcha: null,
    })),
  ];
}

const failing: Status[] = ['fail', 'partial', 'fail-spirit'];
const pending: Status[] = ['cannot-verify', 'unchallenged', 'unchecked', 'skipped'];

/** done only when every criterion passed cleanly; any failure is not-done; otherwise pending. */
export function verdictOf(graded: Graded[]): Verdict {
  if (graded.some((item) => failing.includes(item.status))) return 'not-done';
  if (graded.some((item) => pending.includes(item.status))) return 'done-pending-manual';
  return 'done';
}

/** complete, or degraded when an agent failed, or limited when the cap skipped criteria. */
export function runStatus(graded: Graded[]) {
  if (graded.some((item) => item.status === 'unchecked' || item.status === 'unchallenged'))
    return 'degraded' as const;
  if (graded.some((item) => item.status === 'skipped')) return 'limited' as const;
  return 'complete' as const;
}

const cite = (checks: SubCheck[]) =>
  checks.map((check) => `${check.check}: ${check.evidence}`).join('; ');

/** The failing criteria, each with why it fails and the evidence for it. */
export const mustFix = (graded: Graded[]) =>
  graded
    .filter((item) => failing.includes(item.status))
    .map((item) => {
      const failed = item.checks.filter((check) => check.outcome === 'fails');
      return {
        criterion: item.criterion,
        why: item.gotcha ?? `Failing sub-checks: ${failed.map((check) => check.check).join('; ')}`,
        evidence: cite(item.status === 'fail-spirit' ? item.checks : failed),
      };
    });

const reasons: Partial<Record<Status, string>> = {
  unchallenged: 'Passed, but its letter-vs-spirit challenge failed; confirm the pass by hand',
  unchecked: 'Its checker failed; check it by hand or in a new run',
  skipped: 'Past maxCriteria; never checked',
};

/** What needs a human or a running environment, and why. */
export const pendingManual = (graded: Graded[]) =>
  graded
    .filter((item) => pending.includes(item.status))
    .map((item) => ({
      criterion: item.criterion,
      why:
        reasons[item.status] ??
        `Needs a running environment: ${item.checks
          .filter((check) => check.outcome === 'cannot-verify')
          .map((check) => check.check)
          .join('; ')}`,
    }));

/** The upstream's fallback when the summary agent fails: the verdict and its counts. */
export const fallbackSummary = (
  verdict: Verdict,
  fixes: { criterion: string }[],
  manual: { criterion: string }[],
) => `${verdict}: ${fixes.length} criteria failing, ${manual.length} pending manual confirmation.`;

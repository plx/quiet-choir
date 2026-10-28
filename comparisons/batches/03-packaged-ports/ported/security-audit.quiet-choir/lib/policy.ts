// Pure rules: the lens order, the location check and per-lens cap, the severity-scaled panels and
// their majority, the read-only receipt check, the tally across lenses, the status and the report
// when nothing was confirmed.
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import {
  Lens,
  type FailedLens,
  type Judged,
  type LensFinding,
  type Seat,
  type Severity,
  type Surface,
  type Unlocated,
  type Verdict,
} from '../contracts.js';
import type { Located } from './git.js';

const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Most severe first; a stable sort keeps discovery order within a severity. */
export const bySeverity = <T extends { severity: Severity }>(items: T[]): T[] =>
  [...items].sort((a, b) => rank[a.severity] - rank[b.severity]);

/** The selected lenses in their fixed order, each once. */
export const selected = (lenses: readonly Lens[]): Lens[] =>
  Lens.options.filter((lens) => lenses.includes(lens));

/** Why code dismisses a finding before any panel, or null when its file and line exist. */
export function whyUnlocated(finding: LensFinding, located: Map<string, Located>): string | null {
  const at = located.get(finding.file);
  if (!at || at.type === 'missing') return `${finding.file} does not exist at the revision`;
  if (at.type !== 'blob') return `${finding.file} is a ${at.type}, not a file`;
  if (finding.line !== null && (at.lines ?? 0) < finding.line)
    return `Line ${String(finding.line)} is past the end of ${finding.file} (${String(at.lines ?? 0)} text lines)`;
  return null;
}

/** Located findings, most severe first, while they fit the per-lens cap; the rest are reported. */
export function triage(
  findings: LensFinding[],
  why: (finding: LensFinding) => string | null,
  max: number,
) {
  const unlocated: Unlocated[] = [];
  const located: LensFinding[] = [];
  for (const finding of findings) {
    const reason = why(finding);
    if (reason === null) located.push(finding);
    else unlocated.push({ ...finding, why: reason });
  }
  const ordered = bySeverity(located);
  return { checked: ordered.slice(0, max), unchecked: ordered.slice(max), unlocated };
}

/** Panel size by claimed severity, as upstream: a critical claim must survive three skeptics. */
const panelSize: Record<Severity, number> = { critical: 3, high: 3, medium: 1, low: 1 };

/** The seats of one panel; with crossHarness the second of three goes to Codex. */
export const seatsOf = (severity: Severity, crossHarness: boolean): Seat[] =>
  Array.from({ length: panelSize[severity] }, (_, index) => ({
    seat: index + 1,
    harness: crossHarness && panelSize[severity] === 3 && index === 1 ? 'codex' : 'claude',
  }));

/**
 * A fixed majority of the seats owed. A failed seat stays in the arithmetic, so a finding that
 * could still reach a majority is undecided rather than refuted (upstream counted it as refuted).
 */
export function judge(
  finding: LensFinding,
  seats: Seat[],
  verdicts: Settled<Verdict, MapStepError>[],
): Judged {
  const answered = seats.flatMap((seat, index) => {
    const verdict = verdicts[index];
    return verdict?.ok ? [{ ...seat, ...verdict.value }] : [];
  });
  const majority = Math.floor(seats.length / 2) + 1;
  const upheld = answered.filter((verdict) => !verdict.refuted).length;
  const failedSeats = seats.length - answered.length;
  return {
    ...finding,
    outcome:
      upheld >= majority ? 'confirmed' : upheld + failedSeats >= majority ? 'undecided' : 'refuted',
    seats: seats.length,
    upheld,
    failedSeats,
    verdicts: answered,
  };
}

/** The output of a snapshot call, refused when it changed its read-only snapshot. */
export function readOnly<T>(result: { output: T; worktree?: WorktreeChange }): T {
  if (!result.worktree) throw new Error('A snapshot call returned no receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its snapshot: ${JSON.stringify(result.worktree.files)}`,
    );
  return result.output;
}

/** What one lens's pipeline item returns. */
export interface Swept {
  readonly raw: number;
  readonly judged: Judged[];
  readonly unchecked: LensFinding[];
  readonly unlocated: Unlocated[];
}

/** Pool the lens items: completed lenses in their order, and every failed one with its error. */
export function tally(lenses: Lens[], swept: Settled<Swept, MapStepError>[]) {
  const done: Lens[] = [];
  const failedLenses: FailedLens[] = [];
  const items: Swept[] = [];
  for (const [index, lens] of lenses.entries()) {
    const result = swept[index];
    if (result?.ok) {
      done.push(lens);
      items.push(result.value);
    } else
      failedLenses.push({
        lens,
        why: result ? `${result.error.kind}: ${result.error.message}` : 'missing',
      });
  }
  const judged = items.flatMap((item) => item.judged);
  const where = (outcome: Judged['outcome']) => judged.filter((f) => f.outcome === outcome);
  return {
    lenses: done,
    failedLenses,
    rawFindings: items.reduce((total, item) => total + item.raw, 0),
    confirmed: bySeverity(where('confirmed')),
    refuted: where('refuted'),
    undecided: where('undecided'),
    unlocated: items.flatMap((item) => item.unlocated),
    unchecked: items.flatMap((item) => item.unchecked),
  };
}
export type Tally = ReturnType<typeof tally>;

/** A cap that left findings unpanelled is limited; a failed lens or seat is degraded. */
export function status(audit: Tally): 'complete' | 'degraded' | 'limited' {
  if (audit.unchecked.length) return 'limited';
  if (audit.failedLenses.length || audit.undecided.length) return 'degraded';
  return 'complete';
}

const count = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** The report when nothing was confirmed, from counts alone, so it needs no agent. */
export function plainReport(
  audit: Tally & { scope: string; revision: string; surface: Surface },
): string {
  const { failedLenses, rawFindings, refuted, undecided, unlocated, unchecked } = audit;
  const parts = [
    `Audited ${audit.scope} at ${audit.revision.slice(0, 12)} across ${count(audit.lenses.length, 'lens', 'lenses')} over a mapped surface of ${count(audit.surface.entryPoints.length, 'entry point')}.`,
  ];
  if (failedLenses.length)
    parts.push(
      `Lenses whose sweep failed, so their area is unaudited: ${failedLenses.map((f) => f.lens).join(', ')}.`,
    );
  if (!rawFindings) parts.push('No candidate findings.');
  else {
    const outcomes = [
      refuted.length ? `${String(refuted.length)} refuted by a panel majority` : '',
      undecided.length ? `${String(undecided.length)} undecided after a failed skeptic` : '',
      unlocated.length ? `${String(unlocated.length)} naming a file or line that is absent` : '',
      unchecked.length ? `${String(unchecked.length)} past maxFindingsPerLens, never verified` : '',
    ];
    parts.push(
      `${count(rawFindings, 'candidate finding')}, none confirmed: ${outcomes.filter(Boolean).join('; ')}.`,
    );
  }
  return parts.join(' ');
}

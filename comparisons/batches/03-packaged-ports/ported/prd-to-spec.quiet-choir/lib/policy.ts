// Pure rules: collecting the settled lens drafts, merging and ranking the contested decisions, the
// tournament trigger and its record, the audit records, the delegation map for the
// design-tournament child and the status.
import type { Settled } from 'quiet-choir';
import type {
  Audit,
  AuditRecord,
  Contested,
  Lens,
  LensDraft,
  Section,
  Stakes,
  Tournament,
} from '../contracts.js';

const rank: Record<Stakes, number> = { 'load-bearing': 0, moderate: 1, reversible: 2 };
const normal = (text: string) => text.trim().replace(/\s+/gu, ' ').toLowerCase();

/**
 * The surviving drafts: every section with its lens, and the contested decisions merged by text
 * (ignoring case and whitespace, keeping the highest stakes and every option once), ranked
 * load-bearing first, then by the order the lenses raised them, and numbered D1, D2... in that
 * order.
 */
export function collect(lenses: readonly Lens[], drafts: readonly Settled<LensDraft, unknown>[]) {
  const sections: Section[] = [];
  const raised: Omit<Contested, 'id'>[] = [];
  for (const [index, lens] of lenses.entries()) {
    const draft = drafts[index];
    if (!draft?.ok) continue;
    sections.push(...draft.value.sections.map((section) => ({ ...section, lens })));
    for (const decision of draft.value.contestedDecisions) {
      const same = raised.find((known) => normal(known.decision) === normal(decision.decision));
      if (!same) {
        raised.push({ ...decision, options: [...decision.options], lenses: [lens] });
        continue;
      }
      if (!same.lenses.includes(lens)) same.lenses.push(lens);
      for (const option of decision.options)
        if (!same.options.some((known) => normal(known) === normal(option)))
          same.options.push(option);
      if (rank[decision.stakes] < rank[same.stakes]) same.stakes = decision.stakes;
    }
  }
  const decisions: Contested[] = raised
    .map((decision, order) => ({ decision, order }))
    .sort((a, b) => rank[a.decision.stakes] - rank[b.decision.stakes] || a.order - b.order)
    .map(({ decision }, index) => ({ id: `D${String(index + 1)}`, ...decision }));
  const failedLenses = lenses.filter((_, index) => drafts[index]?.ok !== true);
  return { sections, decisions, failedLenses };
}

/** The decision a tournament settles: the top-ranked one, only when it is load-bearing. */
export const tournamentDecision = (decisions: readonly Contested[], requested: boolean) =>
  requested && decisions[0]?.stakes === 'load-bearing' ? decisions[0] : null;

/** What the parent reads of the design-tournament child's output. */
interface TournamentOutput {
  readonly status: Exclude<Tournament['status'], 'failed'>;
  readonly design: string | null;
  readonly winner: {
    readonly title: string;
    readonly philosophy: string;
    readonly avg: number;
    readonly tiedWith: readonly string[];
  } | null;
}

/**
 * The tournament's record and the design the merger adopts: a design exists only when the child
 * completed with a winner (complete or degraded); a failed child is recorded with its message.
 */
export function tournamentOf(
  decision: Contested,
  outcome: Settled<TournamentOutput, { readonly message: string }>,
): { record: Tournament; design: string | null } {
  if (!outcome.ok)
    return {
      record: {
        decision: decision.id,
        status: 'failed',
        winner: null,
        adopted: false,
        failure: outcome.error.message,
      },
      design: null,
    };
  const { status, design, winner } = outcome.value;
  return {
    record: {
      decision: decision.id,
      status,
      winner: winner && {
        title: winner.title,
        philosophy: winner.philosophy,
        avg: winner.avg,
        tiedWith: [...winner.tiedWith],
      },
      adopted: design !== null,
      failure: null,
    },
    design,
  };
}

/** One record per audit, in audit order; a failed auditor's gaps are unknown, not empty. */
export const auditRecords = (
  audits: readonly Audit[],
  replies: readonly Settled<{ gaps: AuditRecord['gaps'] }, unknown>[],
): AuditRecord[] =>
  audits.map((audit, index) => {
    const reply = replies[index];
    return reply?.ok
      ? { audit, completed: true, gaps: reply.value.gaps }
      : { audit, completed: false, gaps: [] };
  });

/**
 * The design-tournament child's entries onto this workflow's delegation ceilings, for
 * --require-grants: CodexJudge needs a Codex ceiling even when crossHarness is off, because
 * delegation checks every entry the child declares when it starts.
 */
export const delegation = {
  Proposer: 'Reader',
  Judge: 'Reader',
  Synthesizer: 'Reader',
  CodexJudge: 'CodexReader',
} as const;

/** Degraded when anything failed or fell short; otherwise verified, or repaired once. */
export function status(report: {
  failedLenses: readonly Lens[];
  audits: readonly AuditRecord[];
  tournament: Tournament | null;
  repair: 'not-needed' | 'applied' | 'failed';
}) {
  if (
    report.failedLenses.length ||
    report.audits.some((audit) => !audit.completed) ||
    (report.tournament !== null && report.tournament.status !== 'complete') ||
    report.repair === 'failed'
  )
    return 'degraded' as const;
  return report.repair === 'applied' ? ('repaired' as const) : ('verified' as const);
}

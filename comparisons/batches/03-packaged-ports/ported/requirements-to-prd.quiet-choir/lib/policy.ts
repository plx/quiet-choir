// Pure rules: checking each finding's quote against the material, pooling the lenses' readings,
// listing conflicts and unknowns for the writer, the assumptions rule for inferred findings, the
// revision's caps, ordering the critique, a round's open questions, the status verdict, the
// critique summary and the output of a refused run.
import type { MapStepError, Settled } from 'quiet-choir';
import {
  extractCaps,
  maxListed,
  prdCaps,
  type Charter,
  type Critique,
  type Extraction,
  type Finding,
  type Issue,
  type Lens,
  type OpenQuestion,
  type Prd,
  type PrdCaps,
  type RequirementsOutput,
  type RoundStatus,
} from '../contracts.js';

/** Lower-cased text without quotes, emphasis marks or repeated whitespace, for quote matching. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‐-―]/gu, '-')
    .replace(/["'`*_#>‘’“”]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * A quote occurs in a text when its parts between ellipses occur there in order, and they hold at
 * least `extractCaps.quoteWords` words in all: a single word anchors nothing.
 */
export function occurs(text: string, quote: string): boolean {
  const haystack = plain(text);
  const parts = quote
    .split(/\.\.\.|…/u)
    .map(plain)
    .filter(Boolean);
  if (parts.join(' ').split(' ').length < extractCaps.quoteWords) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** Where a quote may come from: each piece of material by its label, then the answers. */
export interface Source {
  readonly label: string;
  readonly text: string;
}

/**
 * Number the findings `F<n>` in lens order, attribute each quote to the first source that holds
 * it, keep a stated or implied finding only as inferred when no source does, and pool the unknowns
 * and conflicts without duplicates that differ only in case, quoting or spacing.
 */
export function collect(
  sources: readonly Source[],
  lenses: readonly Lens[],
  readings: readonly (Settled<Extraction, MapStepError> | undefined)[],
) {
  const findings: Finding[] = [];
  const unknowns = new Map<string, string>();
  const conflicts = new Map<string, string>();
  const pool = (into: Map<string, string>, texts: readonly string[]) => {
    for (const text of texts) if (!into.has(plain(text))) into.set(plain(text), text);
  };
  lenses.forEach((lens, index) => {
    const reading = readings[index];
    if (!reading?.ok) return;
    for (const finding of reading.value.findings) {
      const quote = finding.quote;
      const source =
        quote === null ? null : (sources.find((s) => occurs(s.text, quote))?.label ?? null);
      findings.push({
        id: `F${String(findings.length + 1)}`,
        lens,
        point: finding.point,
        quote,
        claimed: finding.confidence,
        confidence: source === null ? 'inferred' : finding.confidence,
        source,
      });
    }
    pool(unknowns, reading.value.unknowns);
    pool(conflicts, reading.value.conflicts);
  });
  return { findings, unknowns: [...unknowns.values()], conflicts: [...conflicts.values()] };
}

/** Conflicts and unknowns, for the writer or left out of its prompt. */
export interface Questions {
  readonly conflicts: string[];
  readonly unknowns: string[];
}

/**
 * The first `maxListed` conflicts and unknowns, conflicts first since each is a decision, go to the
 * writer; the rest are reported as unlisted rather than dropped in silence.
 */
export function listFor(conflicts: readonly string[], unknowns: readonly string[]) {
  const room = Math.max(0, maxListed - conflicts.length);
  return {
    listed: { conflicts: conflicts.slice(0, maxListed), unknowns: unknowns.slice(0, room) },
    unlisted: { conflicts: conflicts.slice(maxListed), unknowns: unknowns.slice(room) },
  } satisfies Record<string, Questions>;
}

/**
 * A revision returns the whole PRD, the code-added assumptions included, and may turn each issue
 * into an open question or an assumption: its caps leave room for all of that.
 */
export const reviseCaps = (prd: Prd, issues: readonly Issue[]): PrdCaps => ({
  ...prdCaps,
  openQuestions: Math.max(prdCaps.openQuestions, prd.openQuestions.length) + issues.length,
  assumptions: Math.max(prdCaps.assumptions, prd.assumptions.length) + issues.length,
});

/**
 * The upstream's rule, enforced: every inferred finding a requirement relies on appears in an
 * assumption. Code appends one for each the writer left out and reports their ids.
 */
export function complete(prd: Prd, findings: readonly Finding[]) {
  const inferred = new Map(
    findings.filter((finding) => finding.confidence === 'inferred').map((f) => [f.id, f]),
  );
  const assumed = new Set(prd.assumptions.flatMap((assumption) => assumption.findings));
  const relied = [...prd.requirements, ...prd.nonFunctional].flatMap((r) => r.findings);
  const added = [...new Set(relied)].filter((id) => inferred.has(id) && !assumed.has(id));
  const assumptions = added.map((id) => ({ text: inferred.get(id)?.point ?? id, findings: [id] }));
  return { prd: { ...prd, assumptions: [...prd.assumptions, ...assumptions] }, added };
}

const rank = { blocking: 0, major: 1, minor: 2 } as const;

/** Every answered critic's issues with its charter, most severe first, then in charter order. */
export function issuesOf(
  charters: readonly Charter[],
  critiques: readonly (Settled<Critique, MapStepError> | undefined)[],
): Issue[] {
  const issues = charters.flatMap((critic, index) => {
    const critique = critiques[index];
    return critique?.ok ? critique.value.issues.map((issue) => ({ ...issue, critic })) : [];
  });
  return issues
    .map((issue, order) => ({ issue, order }))
    .sort((a, b) => rank[a.issue.severity] - rank[b.issue.severity] || a.order - b.order)
    .map(({ issue }) => issue);
}

/** What one drafting round produced. */
export interface Round {
  readonly failedLenses: Lens[];
  readonly findings: Finding[];
  readonly unknowns: string[];
  readonly conflicts: string[];
  /** The conflicts and unknowns the writer was not given. */
  readonly unlisted: Questions;
  /** How many critics the round asked. */
  readonly critics: number;
  readonly failedCritics: Charter[];
  readonly issues: Issue[];
  readonly revised: boolean;
  /** The final PRD of the round with its assumptions completed, or null when nothing was found. */
  readonly prd: Prd | null;
  /** The inferred findings code added to the assumptions. */
  readonly added: string[];
}

/** A round's open questions: its PRD's, or, when nothing was drafted, its unknowns, as upstream. */
export const openOf = (round: Round): OpenQuestion[] =>
  round.prd
    ? round.prd.openQuestions
    : round.unknowns.map((question) => ({ question, consequences: null }));

/** An answered question round whose redo drafted no PRD, so the round before it stands. */
export type FailedRedo = NonNullable<RequirementsOutput['failedRedo']>;

const unlistedCount = (round: Round) =>
  round.unlisted.conflicts.length + round.unlisted.unknowns.length;

/**
 * Nothing extracted is empty unless a lens failed; a draft whose issues were not revised, or that no
 * critic read, is unrevised; any other failed lens or critic is degraded; a writer that was not
 * given every conflict and unknown is limited.
 */
export function status(round: Round): RoundStatus {
  if (!round.prd) return round.failedLenses.length ? 'degraded' : 'empty';
  if (round.failedCritics.length === round.critics || (round.issues.length && !round.revised))
    return 'unrevised';
  if (round.failedLenses.length || round.failedCritics.length) return 'degraded';
  if (unlistedCount(round)) return 'limited';
  return 'complete';
}

/** The run's verdict: the final round's, lowered to degraded when a later redo drafted nothing. */
export function verdict(round: Round, redo: FailedRedo | null): RoundStatus {
  const own = status(round);
  return redo && (own === 'complete' || own === 'limited') ? 'degraded' : own;
}

const failed = (names: readonly string[], one: string, many: string) =>
  `The ${names.join(', ')} ${names.length > 1 ? many : one} failed.`;

/** How a re-run with answers redoes the PRD, by where this run publishes it. */
const reRun = {
  none: 'Re-run with answers, or set questionRounds, to resolve the open questions.',
  file: 'Re-run with answers and replace set to written.sha256, or set questionRounds, to resolve the open questions.',
  commit:
    "Re-run with answers and either a new out or publication 'file' with replace set to written.sha256, or set questionRounds, to resolve the open questions.",
} as const;

/**
 * The upstream's critique summary, with the failures, the stage that did not run, the conflicts and
 * unknowns the writer was not given, a later redo that drafted nothing, and how to re-run by where
 * the PRD is published (a managed commit cannot be replaced).
 */
export function summary(
  round: Round,
  open: number,
  publication: 'file' | 'commit' | null,
  redo: FailedRedo | null,
): string {
  const lenses = round.failedLenses.length ? failed(round.failedLenses, 'lens', 'lenses') : null;
  if (!round.prd)
    return lenses
      ? `No requirements extracted. ${lenses}`
      : 'No requirements extracted. Is the input readable?';
  const blocking = round.issues.filter((issue) => issue.severity === 'blocking').length;
  const parts = [`${String(round.issues.length)} issues raised, ${String(blocking)} blocking.`];
  if (lenses) parts.push(lenses);
  if (round.failedCritics.length) parts.push(failed(round.failedCritics, 'critic', 'critics'));
  if (round.failedCritics.length === round.critics) parts.push('The draft was not critiqued.');
  else if (round.issues.length && !round.revised)
    parts.push('The revision failed; the draft stands.');
  const unlisted = unlistedCount(round);
  if (unlisted) {
    const total = round.conflicts.length + round.unknowns.length;
    parts.push(
      `The writer was given ${String(total - unlisted)} of ${String(total)} conflicts and unknowns; the rest are in unlisted.`,
    );
  }
  if (redo) {
    const why = redo.failedLenses.length
      ? failed(redo.failedLenses, 'lens', 'lenses')
      : 'Its lenses found nothing.';
    parts.push(
      `Round ${String(redo.round)}'s redo with the answers drafted no PRD. ${why} The earlier PRD stands without those answers, which are in failedRedo.`,
    );
  }
  if (open) parts.push(reRun[publication ?? 'none']);
  return parts.join(' ');
}

/** The output of a run refused before any effect but the check of out: nothing was read or asked. */
export const refused = (reason: string): RequirementsOutput => ({
  status: 'refused',
  material: [],
  rounds: 0,
  answers: [],
  asked: [],
  failedRedo: null,
  failedLenses: [],
  findings: [],
  unknowns: [],
  conflicts: [],
  unlisted: { conflicts: [], unknowns: [] },
  failedCritics: [],
  issues: [],
  revised: false,
  prd: null,
  assumptions: [],
  addedAssumptions: [],
  openQuestions: [],
  critiqueSummary: reason,
  written: null,
});

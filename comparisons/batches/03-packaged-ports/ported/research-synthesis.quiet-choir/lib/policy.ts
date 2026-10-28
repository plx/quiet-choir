// Pure rules: which modalities run, lead deduplication and ranking, the depth and hunt caps, hunt
// territories, the citation keys and their check, and the confidence and status verdicts.
import type { MapStepError, Settled } from 'quiet-choir';
import type {
  Confidence,
  CriticOutcome,
  Depth,
  Gap,
  Hunted,
  Lead,
  Modality,
  Ranked,
  Reading,
  Source,
  TrackedGap,
  Unread,
} from '../contracts.js';

type Result<T> = Settled<T, MapStepError> | undefined;

/** The local sweep needs a local context to ground; without one it is not asked at all. */
export const modalitiesFor = (context: string | null): Modality[] =>
  context === null
    ? ['web', 'source', 'practitioners']
    : ['web', 'source', 'practitioners', 'local'];

const reads: Record<Depth, number> = { quick: 4, standard: 8, deep: 14 };
/** One supplementary round, and at most this many hunts in it. */
export const huntCap = 3;

const normalize = (ref: string) => ref.trim().toLowerCase().replace(/\/+$/u, '');

/** One entry per normalized ref, in sweep order, recording every modality that found it. */
export function merge(swept: { modality: Modality; leads: Lead[] }[]): Ranked[] {
  const byRef = new Map<string, Ranked>();
  for (const { modality, leads } of swept)
    for (const lead of leads) {
      const key = normalize(lead.ref);
      const previous = byRef.get(key);
      if (!previous) byRef.set(key, { ...lead, modalities: [modality] });
      else if (!previous.modalities.includes(modality))
        byRef.set(key, { ...previous, modalities: [...previous.modalities, modality] });
    }
  return [...byRef.values()];
}

const tier = { primary: 0, secondary: 1, anecdotal: 2 } as const;

/**
 * Primary first, then secondary, then anecdotal, as upstream. Within a tier, a lead that several
 * modalities found independently comes first; a stable sort keeps sweep order otherwise. Leads
 * past the depth are deferred, not dropped.
 */
export function rank(leads: Ranked[], depth: Depth) {
  const ordered = [...leads].sort(
    (a, b) =>
      tier[a.credibility] - tier[b.credibility] || b.modalities.length - a.modalities.length,
  );
  return { toRead: ordered.slice(0, reads[depth]), deferred: ordered.slice(reads[depth]) };
}

/** Without a local context there is no snapshot, so every hunt is a web hunt, whatever the critic said. */
export const routed = (gaps: Gap[], context: string | null): Gap[] =>
  context === null ? gaps.map((gap) => ({ ...gap, territory: 'web' })) : gaps;

const yielded = (reading: Reading) => reading.useful && reading.findings.length > 0;

/** Key every reading that yielded findings as S1, S2, …; account for every lead that did not. */
export function sources(read: Ranked[], readings: Result<Reading>[]) {
  const found: Source[] = [];
  const unread: Unread[] = [];
  for (const [index, lead] of read.entries()) {
    const result = readings[index];
    if (!result?.ok) unread.push({ ref: lead.ref, outcome: 'failed' });
    else if (!yielded(result.value)) unread.push({ ref: lead.ref, outcome: 'not-useful' });
    else
      found.push({
        id: `S${String(found.length + 1)}`,
        ref: lead.ref,
        kind: lead.kind,
        credibility: lead.credibility,
        origin: 'lead',
        findings: result.value.findings,
        contradicts: result.value.contradicts === null ? [] : [result.value.contradicts],
      });
  }
  return { found, unread };
}

/**
 * Fold the hunts into the sources: a hunt that reread a known ref adds its findings to that
 * source, any other gets the next key. Every critic gap is tracked, past the cap as unhunted.
 */
export function fold(known: Source[], gaps: Gap[], hunts: Result<Hunted>[]) {
  const all = [...known];
  const tracked: TrackedGap[] = gaps.map((gap, index) => {
    if (index >= huntCap) return { ...gap, hunt: 'unhunted', source: null };
    const result = hunts[index];
    if (!result?.ok) return { ...gap, hunt: 'failed', source: null };
    const { source, findings, contradicts } = result.value;
    if (!yielded(result.value) || source === null) return { ...gap, hunt: 'empty', source: null };
    const notes = contradicts === null ? [] : [contradicts];
    const at = all.findIndex((known) => normalize(known.ref) === normalize(source.ref));
    const previous = all[at];
    if (previous) {
      all[at] = {
        ...previous,
        findings: [...previous.findings, ...findings],
        contradicts: [...previous.contradicts, ...notes],
      };
      return { ...gap, hunt: 'found', source: previous.id };
    }
    const id = `S${String(all.length + 1)}`;
    all.push({ id, ...source, origin: 'hunt', findings, contradicts: notes });
    return { ...gap, hunt: 'found', source: id };
  });
  return { sources: all, gaps: tracked };
}

export interface CitationCheck {
  readonly cited: number;
  readonly unknownCitations: string[];
  readonly uncitedSources: string[];
}

/** Citation keys in order of first appearance: [S1], [S1][S2] and [S1, S2] all count. */
export function citations(answer: string, known: Source[]): CitationCheck {
  const cited = new Set(
    [...answer.matchAll(/\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/gu)].flatMap((match) =>
      (match[1] ?? '').split(/\s*[,;]\s*/u),
    ),
  );
  const ids = new Set(known.map((source) => source.id));
  return {
    cited: cited.size,
    unknownCitations: [...cited].filter((id) => !ids.has(id)),
    uncitedSources: known.map((source) => source.id).filter((id) => !cited.has(id)),
  };
}

/** The answer as the synthesizer wrote it, with the code-owned key-to-ref list appended. */
export const withSources = (answer: string, known: Source[]): string =>
  [
    answer.trimEnd(),
    '',
    'Sources:',
    ...known.map(
      (source) => `- [${source.id}] ${source.ref} (${source.kind}, ${source.credibility})`,
    ),
  ].join('\n');

const unsupported = (check: CitationCheck) =>
  check.cited === 0 || check.unknownCitations.length > 0;

/**
 * The upstream rule over what was actually read, deep reads and hunts alike, each source once:
 * high needs three primary sources that yielded findings, a critic that ran and at most one gap;
 * four sources are moderate, fewer are low. An answer that cites nothing, or cites a key no source
 * has, is low whatever it read.
 */
export function confidence(
  known: Source[],
  critic: CriticOutcome,
  gaps: TrackedGap[],
  check: CitationCheck,
): Confidence {
  if (!known.length) return 'none';
  if (unsupported(check)) return 'low';
  const primary = known.filter((source) => source.credibility === 'primary').length;
  if (primary >= 3 && critic !== 'failed' && gaps.length <= 1) return 'high';
  return known.length >= 4 ? 'moderate' : 'low';
}

/** Degraded when any member failed, or the answer cites nothing or a key no source has. */
export function verdict(
  run: { unswept: Modality[]; unread: Unread[]; critic: CriticOutcome; gaps: TrackedGap[] },
  check: CitationCheck,
) {
  const failed =
    run.unswept.length > 0 ||
    run.unread.some((lead) => lead.outcome === 'failed') ||
    run.critic === 'failed' ||
    run.gaps.some((gap) => gap.hunt === 'failed');
  return failed || unsupported(check) ? ('degraded' as const) : ('answered' as const);
}

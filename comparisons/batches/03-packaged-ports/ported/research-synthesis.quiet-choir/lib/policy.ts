// Pure rules: which modalities run, lead territories, deduplication and ranking, the depth and hunt
// caps, hunt routing, the citation keys and their check, and the confidence and status verdicts.
import type { MapStepError, Settled } from 'quiet-choir';
import type {
  Confidence,
  Depth,
  Gap,
  Hunted,
  Lead,
  Modality,
  Ranked,
  Reading,
  ResearchOutput,
  Source,
  Status,
  Territory,
  TrackedGap,
  Unread,
} from '../contracts.js';

type Result<T> = Settled<T, MapStepError> | undefined;

/** The local sweep needs a pinned commit; without one it is not asked at all. */
export const modalitiesFor = (commit: string | null): Modality[] =>
  commit === null
    ? ['web', 'source', 'practitioners']
    : ['web', 'source', 'practitioners', 'local'];

const reads: Record<Depth, number> = { quick: 4, standard: 8, deep: 14 };
/** One supplementary round, and at most this many hunts in it. */
export const huntCap = 3;

/** Upstream's rule (lowercase, no trailing slash), plus trimming the surrounding whitespace. */
const normalize = (ref: string) => ref.trim().toLowerCase().replace(/\/+$/u, '');

/** A source's identity: its territory and normalized ref, so a web ref never merges into a file. */
const identity = (territory: Territory, ref: string) => `${territory} ${normalize(ref)}`;

/**
 * One entry per territory and normalized ref, in sweep order, recording every modality that found
 * it. The territory is code's, not the agent's: local for the local sweep's leads, whatever kind
 * the scout gave them, and web for the rest, a `local-code` lead from a web scout included.
 */
export function merge(swept: { modality: Modality; leads: Lead[] }[]): Ranked[] {
  const byRef = new Map<string, Ranked>();
  for (const { modality, leads } of swept)
    for (const lead of leads) {
      const territory = modality === 'local' ? 'local' : 'web';
      const key = identity(territory, lead.ref);
      const previous = byRef.get(key);
      if (!previous) byRef.set(key, { ...lead, modalities: [modality], territory });
      else if (!previous.modalities.includes(modality))
        byRef.set(key, { ...previous, modalities: [...previous.modalities, modality] });
    }
  return [...byRef.values()];
}

/**
 * The merged leads of the sweeps that answered, and every territory left unsearched: a failed
 * sweep, and the local territory when a context was given but no commit could be pinned.
 */
export function gather(
  swept: Modality[],
  results: Result<{ leads: Lead[] }>[],
  localSkipped: boolean,
) {
  const answered = swept.flatMap((modality, index) => {
    const result = results[index];
    return result?.ok ? [{ modality, leads: result.value.leads }] : [];
  });
  const failed = swept.filter((_, index) => !results[index]?.ok);
  return {
    leads: merge(answered),
    unswept: localSkipped ? [...failed, 'local' as const] : failed,
  };
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

/** Without a pinned commit there is no snapshot, so every hunt is a web hunt, whatever the critic said. */
export const routed = (gaps: Gap[], commit: string | null): Gap[] =>
  commit === null ? gaps.map((gap) => ({ ...gap, territory: 'web' })) : gaps;

/**
 * The refs a hunt in this territory could reread: a web hunt is never told the repository's
 * paths, and a local hunt cannot fetch a URL.
 */
export const knownFor = (found: Source[], territory: Territory): string[] =>
  found.filter((source) => source.territory === territory).map((source) => source.ref);

/** Upstream kept every reading marked useful; a useful reading with no findings has nothing to cite. */
const yielded = (reading: Reading) => reading.useful && reading.findings.length > 0;

/**
 * Key every reading that yielded findings as S1, S2, …; account for every lead that did not, and
 * return the leads whose read failed for the critic.
 */
export function sources(read: Ranked[], readings: Result<Reading>[]) {
  const found: Source[] = [];
  const unread: Unread[] = [];
  const failed: Ranked[] = [];
  for (const [index, lead] of read.entries()) {
    const result = readings[index];
    if (!result?.ok) {
      unread.push({ ref: lead.ref, outcome: 'failed' });
      failed.push(lead);
    } else if (!yielded(result.value)) unread.push({ ref: lead.ref, outcome: 'not-useful' });
    else
      found.push({
        id: `S${String(found.length + 1)}`,
        ref: lead.ref,
        kind: lead.kind,
        credibility: lead.credibility,
        territory: lead.territory,
        origin: 'lead',
        findings: result.value.findings,
        contradicts: result.value.contradicts === null ? [] : [result.value.contradicts],
      });
  }
  return { found, unread, failed };
}

/**
 * Fold the hunts into the sources: a hunt that reread a known ref in its own territory adds its
 * findings to that source, any other gets the next key in the hunt's territory. Every critic gap is
 * tracked, past the cap as unhunted.
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
    const key = identity(gap.territory, source.ref);
    const at = all.findIndex((known) => identity(known.territory, known.ref) === key);
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
    all.push({
      id,
      ...source,
      territory: gap.territory,
      origin: 'hunt',
      findings,
      contradicts: notes,
    });
    return { ...gap, hunt: 'found', source: id };
  });
  return { sources: all, gaps: tracked };
}

/** Citation keys in order of first appearance: [S1], [S1][S2] and [S1, S2] all count. */
export function citations(answer: string, known: Source[]) {
  const cited = new Set(
    [...answer.matchAll(/\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/gu)].flatMap((match) =>
      (match[1] ?? '').split(/\s*[,;]\s*/u),
    ),
  );
  const ids = new Set(known.map((source) => source.id));
  return {
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

/** Every output fact except the two verdicts, which code derives from them alone. */
export type Facts = Omit<ResearchOutput, 'status' | 'confidence'>;

/** The answer cites a key no source has, or cites none of its sources. */
const unsupported = (facts: Facts) =>
  facts.unknownCitations.length > 0 || facts.uncitedSources.length === facts.sources.length;

/**
 * The upstream rule over what was actually read, deep reads and hunts alike, each source once:
 * high needs three primary sources that yielded findings, a critic that ran and at most one gap;
 * four sources are moderate, fewer are low. An answer that cites nothing, or cites a key no source
 * has, is low whatever it read.
 */
function confidence(facts: Facts): Confidence {
  if (!facts.sources.length) return 'none';
  if (unsupported(facts)) return 'low';
  const primary = facts.sources.filter((source) => source.credibility === 'primary').length;
  if (primary >= 3 && facts.critic !== 'failed' && facts.gaps.length <= 1) return 'high';
  return facts.sources.length >= 4 ? 'moderate' : 'low';
}

/**
 * Degraded when a territory went unsearched or any member failed, whatever was found, so a run
 * that could not search never reports that it searched and found nothing. The empty statuses
 * describe a clean run only, and an answer must cite its sources to count as answered.
 */
function verdict(facts: Facts): Status {
  const failed =
    facts.unswept.length > 0 ||
    facts.unread.some((lead) => lead.outcome === 'failed') ||
    facts.critic === 'failed' ||
    facts.gaps.some((gap) => gap.hunt === 'failed');
  if (failed) return 'degraded';
  if (!facts.leadsFound) return 'no-leads';
  if (!facts.sources.length) return 'no-findings';
  return unsupported(facts) ? 'degraded' : 'answered';
}

/** The output: every return path derives its status and confidence from its facts here. */
export const conclude = (facts: Facts): ResearchOutput => ({
  status: verdict(facts),
  confidence: confidence(facts),
  ...facts,
});

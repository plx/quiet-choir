// Pure rules: matching the survey to tracked files, the deep-read cap, coverage, the cited-path
// check, grouping the critic's gaps by section, merging repaired cards and the status.
import type { Settled } from 'quiet-choir';
import { Path, type Card, type Gap, type Importance, type Surveyed } from '../contracts.js';

const rank: Record<Importance, number> = { core: 0, supporting: 1, peripheral: 2 };
/** Section and subsystem names compare trimmed and case-insensitively. */
export const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A surveyed subsystem that matched tracked files. */
export interface Subsystem {
  readonly name: string;
  readonly importance: Importance;
  readonly hint: string | null;
  readonly paths: readonly string[];
  readonly files: readonly string[];
}
/** One atlas section: a deep-read card, or one the repair round corrected or added. */
export interface Section {
  readonly name: string;
  readonly importance: Importance | null;
  readonly origin: 'read' | 'repaired' | 'added';
  readonly card: Card;
}
export interface Dropped {
  readonly section: string;
  readonly path: string;
}

/** `./src/`, `src` and `src/` name one directory; `.` is the whole tree; anything else invalid is null. */
export function normalizePath(raw: string): string | null {
  let path = raw.trim();
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/+$/u, '');
  if (path === '' || path === '.') return '.';
  return Path.safeParse(path).success ? path : null;
}

/** The indexes of `owners` whose paths cover `file`, found by walking the file's own prefixes. */
function claimants(owners: Map<string, number[]>, file: string): number[] {
  const found = [...(owners.get('.') ?? [])];
  let prefix = '';
  for (const part of file.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    found.push(...(owners.get(prefix) ?? []));
  }
  return found;
}
function ownersOf(paths: readonly (readonly string[])[]) {
  const owners = new Map<string, number[]>();
  for (const [index, list] of paths.entries())
    for (const path of list) owners.set(path, [...(owners.get(path) ?? []), index]);
  return owners;
}

/**
 * Merge same-named subsystems, normalize their paths and keep those that cover a tracked file; the
 * rest are unmatched (a hallucinated directory, a glob, an untracked area).
 */
export function resolveSurvey(surveyed: readonly Surveyed[], tracked: readonly string[]) {
  const merged: { name: string; importance: Importance; hint: string | null; paths: string[] }[] =
    [];
  for (const entry of surveyed) {
    const paths = entry.paths.map(normalizePath).filter((path) => path !== null);
    const previous = merged.find((candidate) => same(candidate.name, entry.name));
    if (!previous) {
      merged.push({
        name: entry.name.trim(),
        importance: entry.importance,
        hint: entry.hint,
        paths,
      });
      continue;
    }
    if (rank[entry.importance] < rank[previous.importance]) previous.importance = entry.importance;
    previous.hint ??= entry.hint;
    previous.paths.push(...paths.filter((path) => !previous.paths.includes(path)));
  }
  const owners = ownersOf(merged.map((entry) => entry.paths));
  const files = merged.map(() => [] as string[]);
  for (const file of tracked)
    for (const index of new Set(claimants(owners, file))) files[index]?.push(file);
  const matched: Subsystem[] = [];
  const unmatched: string[] = [];
  for (const [index, entry] of merged.entries()) {
    const covered = files[index] ?? [];
    if (covered.length) matched.push({ ...entry, files: covered });
    else unmatched.push(entry.name);
  }
  return { matched, unmatched };
}

/** Core subsystems win the deep-read slots, then supporting, then peripheral; the rest are skipped. */
export function cap(matched: readonly Subsystem[], max: number) {
  const ordered = [...matched].sort((a, b) => rank[a.importance] - rank[b.importance]);
  return { chosen: ordered.slice(0, max), skipped: ordered.slice(max) };
}

/** The area of a tracked file: its top-level directory with a slash, or the root file's name. */
const areaOf = (file: string) => (file.includes('/') ? `${file.split('/')[0]}/` : file);

/** Tracked files that no surveyed subsystem covers, counted by top-level area. */
export function uncovered(matched: readonly Subsystem[], tracked: readonly string[]) {
  const owners = ownersOf(matched.map((subsystem) => subsystem.paths));
  const counts = new Map<string, number>();
  for (const file of tracked)
    if (!claimants(owners, file).length)
      counts.set(areaOf(file), (counts.get(areaOf(file)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([area, files]) => ({ area, files }));
}

/**
 * The surveyor's view of the tree: root files, top-level directories and their subdirectories
 * with file counts, in path order, at most `limit` entries with the rest counted.
 */
export function layout(tracked: readonly string[], limit = 120) {
  const entries = new Map<string, number | null>();
  for (const file of tracked) {
    const parts = file.split('/');
    if (parts.length === 1) entries.set(file, null);
    for (const depth of [1, 2].filter((level) => level < parts.length)) {
      const directory = `${parts.slice(0, depth).join('/')}/`;
      entries.set(directory, (entries.get(directory) ?? 0) + 1);
    }
  }
  const sorted = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, files]) => ({ path, files }));
  return {
    layout: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit),
    fileCount: tracked.length,
  };
}

/** Keep the card's key files that are tracked, normalized; report the rest as dropped. */
export function verified(section: string, card: Card, tracked: ReadonlySet<string>) {
  const dropped: Dropped[] = [];
  const keyFiles = card.keyFiles.flatMap((file) => {
    const path = normalizePath(file.path);
    if (path !== null && tracked.has(path)) return [{ ...file, path }];
    dropped.push({ section, path: file.path });
    return [];
  });
  return { card: { ...card, keyFiles }, dropped };
}

/** Deep-read results aligned with their subsystems: a failed reader leaves its subsystem unread. */
export function sectionsOf(
  chosen: readonly Subsystem[],
  read: readonly Settled<Card, unknown>[],
  tracked: ReadonlySet<string>,
) {
  const sections: Section[] = [];
  const unread: string[] = [];
  const dropped: Dropped[] = [];
  for (const [index, subsystem] of chosen.entries()) {
    const result = read[index];
    if (!result?.ok) {
      unread.push(subsystem.name);
      continue;
    }
    const checked = verified(subsystem.name, result.value, tracked);
    dropped.push(...checked.dropped);
    sections.push({
      name: subsystem.name,
      importance: subsystem.importance,
      origin: 'read',
      card: checked.card,
    });
  }
  return { sections, unread, dropped };
}

/** Every verified key file, in section order, once: what the synthesis may point a newcomer at. */
export const keyFilesOf = (sections: readonly Section[]) => [
  ...new Set(sections.flatMap((section) => section.card.keyFiles.map((file) => file.path))),
];

/** The critic's gaps, one group per section in the order the critic first names it. */
export function groupGaps(gaps: readonly Gap[]) {
  const groups: { section: string; gaps: Gap[] }[] = [];
  for (const gap of gaps) {
    const group = groups.find((candidate) => same(candidate.section, gap.section));
    if (group) group.gaps.push(gap);
    else groups.push({ section: gap.section.trim(), gaps: [gap] });
  }
  return groups;
}
export type GapGroup = ReturnType<typeof groupGaps>[number];

/**
 * Apply the repair round in code: a repaired card replaces its section or adds one, keeping the
 * surveyed importance of a skipped or unread subsystem it adds; a failed repair changes nothing.
 */
export function applyRepairs(
  sections: readonly Section[],
  groups: readonly GapGroup[],
  results: readonly Settled<Card, unknown>[],
  surveyed: readonly Subsystem[],
  tracked: ReadonlySet<string>,
) {
  const next = [...sections];
  const dropped: Dropped[] = [];
  const repairs = groups.map((group, index) => {
    const result = results[index];
    const outcome = { section: group.section, gaps: group.gaps.length };
    if (!result?.ok) return { ...outcome, outcome: 'failed' as const };
    const at = next.findIndex((section) => same(section.name, group.section));
    const name = at < 0 ? group.section : (next[at]?.name ?? group.section);
    const checked = verified(name, result.value, tracked);
    dropped.push(...checked.dropped);
    if (at >= 0) {
      next[at] = { ...(next[at] as Section), origin: 'repaired', card: checked.card };
      return { ...outcome, section: name, outcome: 'repaired' as const };
    }
    const known = surveyed.find((subsystem) => same(subsystem.name, name));
    next.push({ name, importance: known?.importance ?? null, origin: 'added', card: checked.card });
    return { ...outcome, outcome: 'added' as const };
  });
  return { sections: next, repairs, dropped };
}

/**
 * The status, most serious first: a failure or a refused claim degrades the atlas, a cap limits
 * it, an unreviewed repair round leaves it repaired, and only a critic's empty gap list completes it.
 */
export function atlasStatus(facts: {
  unread: number;
  unmatched: number;
  dropped: number;
  criticFailed: boolean;
  failedRepairs: number;
  skipped: number;
  unrepaired: number;
  gaps: number;
}) {
  if (facts.unread || facts.unmatched || facts.dropped || facts.criticFailed || facts.failedRepairs)
    return 'degraded' as const;
  if (facts.skipped || facts.unrepaired) return 'limited' as const;
  return facts.gaps ? ('repaired' as const) : ('complete' as const);
}

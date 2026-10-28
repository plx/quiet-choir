// Pure rules: the discovery scope, the planned groups (tracked, disjoint, capped), search
// coverage, the approved digest, a writer's receipt checked against its approved files, the
// repair cap, and the output's status and notes.
import { createHash } from 'node:crypto';
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type {
  Check,
  Cluster,
  ClusterOutcome,
  GroupOutcome,
  MigrationOutput,
  Planned,
  Sites,
} from '../contracts.js';

/** Upstream's repair round fixes at most the first three failure clusters. */
export const REPAIR_CLUSTERS = 3;

/** The files under `paths` (a file, or a directory prefix); every file when `paths` is empty. */
export const inScope = (files: string[], paths: string[]): string[] =>
  paths.length
    ? files.filter((file) => paths.some((path) => file === path || file.startsWith(`${path}/`)))
    : files;

/**
 * The groups to plan: only files tracked in scope at the base (the rest are stray), each file in
 * one group (groups that share a file are coalesced in order of first appearance), at most `max`
 * groups (the rest are deferred, never dropped).
 */
export function planGroups(groups: Sites['groups'], tracked: string[], max: number) {
  const known = new Set(tracked);
  const stray = new Set<string>();
  const merged: Planned[] = [];
  let found = 0;
  for (const group of groups) {
    const files = [...new Set(group.files)].filter((file) => {
      if (!known.has(file)) stray.add(file);
      return known.has(file);
    });
    if (!files.length) continue;
    found++;
    const next: Planned = { files, siteCount: group.siteCount, notes: group.notes };
    // Planned groups stay pairwise disjoint, so the union of every overlapping one is too.
    const [into, ...rest] = merged.filter((done) => done.files.some((f) => files.includes(f)));
    if (!into) {
      merged.push(next);
      continue;
    }
    for (const other of [...rest, next]) {
      into.files = [...new Set([...into.files, ...other.files])];
      into.siteCount += other.siteCount;
      into.notes = [into.notes, other.notes].filter(Boolean).join('; ') || null;
    }
    for (const other of rest) merged.splice(merged.indexOf(other), 1);
  }
  return {
    groups: merged.slice(0, max),
    deferred: merged.slice(max),
    stray: [...stray].sort(),
    coalesced: found - merged.length,
  };
}

/** Search hits that no group owns and discovery did not excuse, and the excuses it gave. */
export function coverage(hits: string[], planned: Planned[], unchanged: Sites['unchanged']) {
  const grouped = new Set(planned.flatMap((group) => group.files));
  const excused = [...new Map(unchanged.map((entry) => [entry.file, entry])).values()].filter(
    (entry) => !grouped.has(entry.file),
  );
  const skipped = new Set(excused.map((entry) => entry.file));
  return {
    unassigned: hits.filter((file) => !grouped.has(file) && !skipped.has(file)),
    excused,
  };
}

/** The SHA-256 of the approved plan text, in the form every writer receives it. */
export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');

/**
 * A writer's receipt checked against the files it was approved to change: it may only modify
 * them, never add, delete or rename a file. Returns the change (null when the tree is unchanged)
 * or why it is refused.
 */
export function owned(
  change: WorktreeChange | undefined,
  allowed: string[],
): { change: WorktreeChange | null } | { refused: string } {
  if (!change) throw new Error('Writer did not produce an isolated receipt');
  const outside = change.files.filter(
    (file) => file.status !== 'modified' || !allowed.includes(file.path),
  );
  if (outside.length)
    return {
      refused: `changed files outside its approved set: ${outside.map((file) => `${file.path} (${file.status})`).join(', ')}`,
    };
  return { change: change.commit ? change : null };
}

/** A group's outcome as the migrator's mapper returns it, with the change to integrate. */
export type Outcome = Omit<GroupOutcome, 'files'> & { change: WorktreeChange | null };

/** Join each settled migrator to its group; a failed call keeps its group on the old API. */
export const settleGroups = (
  groups: Planned[],
  results: Settled<Outcome, MapStepError>[],
): (GroupOutcome & { change: WorktreeChange | null })[] =>
  groups.map((group, index) => {
    const result = results[index];
    return result?.ok
      ? { files: group.files, ...result.value }
      : {
          files: group.files,
          status: 'failed',
          summary: `migrator failed: ${result?.error.message ?? 'no outcome'}`,
          blockers: [],
          change: null,
        };
  });

/** A group that produced a change to integrate. */
export const landed = (outcome: { change: WorktreeChange | null }) => outcome.change !== null;

/** Migrated and partial groups (each with a change), the rest, and the changes in plan order. */
export function split(outcomes: (GroupOutcome & { change: WorktreeChange | null })[]) {
  const record = ({ files, status, summary, blockers }: GroupOutcome): GroupOutcome => ({
    files,
    status,
    summary,
    blockers,
  });
  return {
    migrated: outcomes.filter(landed).map(record),
    failed: outcomes.filter((outcome) => !landed(outcome)).map(record),
    changes: outcomes.flatMap((outcome) => (outcome.change ? [outcome.change] : [])),
  };
}

/** The changes of the repairs that integration kept. */
export const fixes = (repairs: { change: WorktreeChange | null }[]) =>
  repairs.flatMap((repair) => (repair.change ? [repair.change] : []));

/** A cluster's outcome for the output, without its change. */
export const reported = ({
  description,
  files,
  repair,
  summary,
}: ClusterOutcome): ClusterOutcome => ({
  description,
  files,
  repair,
  summary,
});

/** A failing command's outcome in words, for the triager and the repairers. */
export function outcomeOf(check: Check): string {
  const exit = check.signal
    ? `signal ${check.signal}`
    : check.code === null
      ? null
      : `exit ${String(check.code)}`;
  if (check.failure !== null) return exit ? `${check.failure}, ${exit}` : check.failure;
  return check.truncated ? `${exit ?? 'exit'} with truncated output` : (exit ?? 'no exit code');
}

/** The first clusters get a repairer; the rest are reported as skipped. */
export const capClusters = (clusters: Cluster[]) => ({
  repairing: clusters.slice(0, REPAIR_CLUSTERS),
  skipped: clusters
    .slice(REPAIR_CLUSTERS)
    .map((cluster): ClusterOutcome => ({ ...cluster, repair: 'skipped', summary: 'over the cap' })),
});

/** A repair's outcome as its mapper returns it, with the change to integrate. */
export type Repair = Pick<ClusterOutcome, 'repair' | 'summary'> & { change: WorktreeChange | null };

/** Join each settled repairer to its cluster; a conflicting repair is dropped from integration. */
export function settleRepairs(
  clusters: Cluster[],
  results: Settled<Repair, MapStepError>[],
  conflicts: string[] = [],
): (ClusterOutcome & { change: WorktreeChange | null })[] {
  return clusters.map((cluster, index) => {
    const result = results[index];
    if (!result?.ok)
      return {
        ...cluster,
        repair: 'failed',
        summary: `repairer failed: ${result?.error.message ?? 'no outcome'}`,
        change: null,
      };
    const { change } = result.value;
    return change?.commit && conflicts.includes(change.commit)
      ? { ...cluster, ...result.value, repair: 'conflict', change: null }
      : { ...cluster, ...result.value };
  });
}

type Report = Omit<MigrationOutput, 'notes'>;

/** Published, every planned group fully migrated, nothing deferred, stopped or unassigned. */
export const complete = (report: Omit<Report, 'status'>) =>
  report.failed.length === 0 &&
  report.unattempted.length === 0 &&
  report.deferred.length === 0 &&
  report.unassigned.length === 0 &&
  report.migrated.every((group) => group.status === 'migrated');

/** The upstream's one-line notes, from the counts the output already carries. */
export function notesFor(report: Report): string {
  const left = report.failed.length + report.unattempted.length + report.deferred.length;
  const tail = left
    ? ` ${String(left)} groups still use the old API: see failed[].blockers, unattempted and deferred.`
    : '';
  switch (report.status) {
    case 'nothing-to-migrate':
      return 'Discovery found no call sites.';
    case 'declined':
      return 'The migration plan was declined; nothing was changed.';
    case 'nothing-migrated':
      return `No group produced a change to integrate.${tail}`;
    case 'verification-failed':
      return `The integrated migration failed verification; nothing was published.${tail}`;
    case 'publish-failed':
      return 'The verified migration could not be published to the checkout.';
    case 'unverified-publish':
      return 'Published, but the checkout moved since verification: the published tree was not the verified one.';
    case 'partial':
      return `Published a partial migration.${tail}`;
    default:
      return 'All discovered groups migrated.';
  }
}

/**
 * Pure rules for removing a stale XDG project root in `workflow prune --missing-cwd --all`,
 * following [ADR 0051](../../../docs/decisions/0051-remove-stale-project-roots-by-rmdir.md). The
 * orchestrator only lists roots that are stale: registered for a cwd that is missing, or not
 * registered at all (no readable or valid `project.json`). It removes this prune's runs first, then
 * walks each listed root without following symbolic links and hands the walk to
 * {@link rootDecision}. Removal itself unlinks only `project.json` and `runs/.gitignore` and removes
 * every directory with `rmdir`, so a cache created concurrently keeps the root.
 *
 * A root is kept, first match wins, when:
 * 1. `runs-kept`: it is registered and its `runs/` still lists a run this prune did not remove;
 * 2. `in-use`: a namespace directory under `worktrees/` is named after a run that some scanned
 *    runs container still holds;
 * 3. `files`: the walk found any entry outside the allowed layout: for a registered root,
 *    `project.json`, `runs/`, `runs/.gitignore`, `worktrees/` and directories below `worktrees/`;
 *    for an unregistered root, only `worktrees/` and directories below it, or nothing at all. A file,
 *    a symbolic link or an unknown directory at any depth blocks.
 *
 * Otherwise it is removed: `missing-cwd` for a registered root, `empty` for an unregistered one.
 *
 * ESLint keeps this module free of runtime imports.
 */

/** The kind of one entry the walk found, by `lstat`: symbolic links are `other`. @internal */
export type RootEntryKind = 'directory' | 'file' | 'other';

/** One entry below a root that no removed run accounts for. @internal */
export interface RootEntry {
  /** Path components relative to the root, such as `['worktrees', 'run-<uuid>']`. */
  readonly segments: readonly string[];
  readonly kind: RootEntryKind;
}

/** What the orchestrator observed about one stale root. @internal */
export interface RootObservation {
  /** Whether the root has a valid `project.json`, whose recorded cwd is then missing. */
  readonly registered: boolean;
  /** IDs of runs listed in the root's `runs/` that this prune did not (or would not) remove. */
  readonly keptRuns: readonly string[];
  /**
   * Names of namespace directories under `worktrees/` whose run is still held by a scanned runs
   * container (listed and not removed).
   */
  readonly inUse: readonly string[];
  /** The walk's entries, without the subtrees of removed runs, caches and tombstones. */
  readonly entries: readonly RootEntry[];
}

/** Why a stale root stays. @internal */
export type RootKeepReason = 'runs-kept' | 'in-use' | 'files';

/** The verdict for one stale root. @internal */
export type RootDecision =
  | { readonly kind: 'remove'; readonly reason: 'missing-cwd' | 'empty' }
  | {
      readonly kind: 'keep';
      readonly reason: RootKeepReason;
      /** Relative paths (segments) that keep the root, at most {@link blockingLimit}. */
      readonly blocking: readonly (readonly string[])[];
    };

/** The most blocking entries a decision reports, and the walk collects. @internal */
export const blockingLimit = 20;

/** Whether `entry` belongs to the layout a stale root may still hold; see the module comment. @internal */
export function allowedRootEntry(registered: boolean, entry: RootEntry): boolean {
  const [first, second, ...rest] = entry.segments;
  if (first === 'worktrees') return entry.kind === 'directory';
  if (!registered) return false;
  if (first === 'project.json') return second === undefined && entry.kind === 'file';
  if (first !== 'runs') return false;
  if (second === undefined) return entry.kind === 'directory';
  return second === '.gitignore' && !rest.length && entry.kind === 'file';
}

/** Judge one stale root; see the module comment for the rules. @internal */
export function rootDecision(observation: RootObservation): RootDecision {
  const { registered } = observation;
  if (registered && observation.keptRuns.length)
    return {
      kind: 'keep',
      reason: 'runs-kept',
      blocking: observation.keptRuns.slice(0, blockingLimit).map((runId) => ['runs', runId]),
    };
  if (observation.inUse.length)
    return {
      kind: 'keep',
      reason: 'in-use',
      blocking: observation.inUse.slice(0, blockingLimit).map((name) => ['worktrees', name]),
    };
  const blocking = observation.entries
    .filter((entry) => !allowedRootEntry(registered, entry))
    .slice(0, blockingLimit)
    .map((entry) => entry.segments);
  if (blocking.length) return { kind: 'keep', reason: 'files', blocking };
  return { kind: 'remove', reason: registered ? 'missing-cwd' : 'empty' };
}

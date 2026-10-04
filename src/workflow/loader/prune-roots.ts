import type { Dirent } from 'node:fs';
import { lstat, open, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isErrno } from '../runtime/lock.js';
import type { ProjectRoot } from '../runtime/paths.js';
import { syncDirectory, syncHandle } from '../runtime/storage-io.js';
import {
  allowedRootEntry,
  blockingLimit,
  rootDecision,
  type RootDecision,
  type RootEntry,
} from './root-selection.js';

/**
 * Why a stale project root was removed (`missing-cwd`, `empty`) or kept: `runs-kept`, `in-use` and
 * `files` from `rootDecision`, `busy` when an `rmdir` found a directory no longer empty (something
 * created an entry during the prune) and `storage` for any other error. @internal
 */
export type PruneRootReason = RootDecision['reason'] | 'busy' | 'storage';

/** One stale XDG project root `workflow prune --missing-cwd --all` removed or kept. @internal */
export interface PruneRoot {
  /** Absolute root directory under the XDG `quiet-choir` directory. */
  readonly root: string;
  /** The recorded cwd, which is missing; null for a root without a valid `project.json`. */
  readonly cwd: string | null;
  readonly registered: boolean;
  /** Whether the root was removed; in a dry run, whether a prune would remove it now. */
  readonly removed: boolean;
  readonly reason: PruneRootReason;
  /**
   * For a removed root, the apparent size of the files the root removal itself deletes
   * (`project.json` and `runs/.gitignore`); null for a kept root, which is never measured.
   */
  readonly bytes: number | null;
  /**
   * For a removed root, the absolute paths it unlinked or removed (or would), in order; for a kept
   * root, the paths that keep it (at most 20).
   */
  readonly paths: readonly string[];
  /** IDs of the runs that keep the root, for `runs-kept` and `in-use`. */
  readonly runs: readonly string[];
  readonly message: string;
}

/** A run that a scanned runs container still holds: listed and not removed. @internal */
export interface HeldRun {
  readonly runId: string;
  readonly stateDir: string;
}

/** Plain-data input of {@link pruneRoots}. @internal */
export interface PruneRootsOptions {
  /** Every directory under the XDG `quiet-choir` directory, as `projectRoots` found them. */
  readonly roots: readonly ProjectRoot[];
  /** The current project's root, which is never listed. */
  readonly current: string;
  /** Runs every scanned container still holds after the run removals. */
  readonly held: readonly HeldRun[];
  /**
   * Absolute paths the run removals deleted or, in a dry run, would delete: removed runs' paths and
   * caches and swept tombstones. The walk skips them, so a dry run predicts the real prune.
   */
  readonly attributed: ReadonlySet<string>;
  readonly dryRun: boolean;
}

/** Live collaborators of {@link pruneRoots}. @internal */
export interface PruneRootsLive {
  readonly signal?: AbortSignal | undefined;
  /** @internal Test seam called before each `rmdir` of a real removal. */
  readonly beforeRmdir?: ((path: string) => void | Promise<void>) | undefined;
}

/** The outcome of {@link pruneRoots}: done, or stopped by the signal between roots. @internal */
export type PruneRootsOutcome =
  | { readonly kind: 'done'; readonly roots: PruneRoot[]; readonly warnings: string[] }
  | { readonly kind: 'interrupted'; readonly roots: PruneRoot[]; readonly error: unknown };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A worktree namespace directory: `<runId>-<uuid>`, as `RunWorktrees` names it. */
const namespacePattern = /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const entryKind = (entry: Dirent): RootEntry['kind'] =>
  entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';

const list = (items: readonly string[], limit = 5): string =>
  items.length > limit
    ? `${items.slice(0, limit).join(', ')} and ${String(items.length - limit)} more`
    : items.join(', ');

/** Children of a directory, sorted; an entry that vanished reads as no directory. */
async function children(directory: string): Promise<Dirent[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return [];
    throw error;
  }
}

interface Walk {
  /** Unattributed entries, each directory listed before its children. */
  readonly entries: RootEntry[];
}

/**
 * Walk a root without following symbolic links, skipping attributed subtrees. A directory's own
 * entries are recorded before its subdirectories are entered, and the walk stops after
 * {@link blockingLimit} entries the decision would refuse, so a live cache is never crawled whole.
 * Only allowed directories are entered.
 */
async function walk(
  root: string,
  registered: boolean,
  attributed: ReadonlySet<string>,
): Promise<Walk> {
  const entries: RootEntry[] = [];
  let blocking = 0;
  const visit = async (segments: readonly string[]): Promise<void> => {
    const directories: string[][] = [];
    for (const dirent of await children(join(root, ...segments))) {
      if (blocking >= blockingLimit) return;
      const path = [...segments, dirent.name];
      if (attributed.has(join(root, ...path))) continue;
      const entry: RootEntry = { segments: path, kind: entryKind(dirent) };
      entries.push(entry);
      if (!allowedRootEntry(registered, entry)) blocking += 1;
      else if (entry.kind === 'directory') directories.push(path);
    }
    for (const path of directories) {
      if (blocking >= blockingLimit) return;
      await visit(path);
    }
  };
  await visit([]);
  return { entries };
}

/** Names of `worktrees/` namespaces whose run is still held, with those run IDs. */
async function namespacesInUse(
  root: string,
  heldIds: ReadonlySet<string>,
): Promise<{ readonly names: string[]; readonly runs: string[] }> {
  const worktrees = join(root, 'worktrees');
  try {
    if (!(await lstat(worktrees)).isDirectory()) return { names: [], runs: [] };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { names: [], runs: [] };
    throw error;
  }
  const names: string[] = [];
  const runs = new Set<string>();
  for (const dirent of await children(worktrees)) {
    const runId = namespacePattern.exec(dirent.name)?.[1];
    if (runId === undefined || !heldIds.has(runId)) continue;
    names.push(dirent.name);
    runs.add(runId);
  }
  return { names, runs: [...runs].sort() };
}

/** Whether the recorded cwd is missing; null (with a warning) when stat fails otherwise. */
async function cwdMissing(root: string, cwd: string, warnings: string[]): Promise<boolean | null> {
  try {
    await stat(cwd);
    return false;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return true;
    warnings.push(
      `Could not check the cwd ${cwd} of project root ${root}, so prune keeps it: ${message(error)}`,
    );
    return null;
  }
}

/** The apparent size of a regular file, or 0 when it is absent or not a file. */
async function fileBytes(path: string): Promise<number> {
  try {
    const entry = await lstat(path);
    return entry.isFile() ? entry.size : 0;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
}

/** Re-create a file prune unlinked, never over an entry that appeared meanwhile. */
async function restore(path: string, bytes: Buffer, mode: number): Promise<void> {
  try {
    await using file = await open(path, 'wx', mode);
    await file.writeFile(bytes);
    await syncHandle(file);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

class RootBusyError extends Error {
  public constructor(
    public readonly directory: string,
    public readonly reason: 'busy' | 'storage',
    cause: unknown,
  ) {
    super(message(cause), { cause });
  }
}

/** The removal plan of a root the decision removes: what to unlink and which directories. */
interface Removal {
  readonly gitignore: string | null;
  readonly runs: string | null;
  /** Directories below `worktrees/`, deepest first, then `worktrees/` itself. */
  readonly worktrees: readonly string[];
  readonly project: string | null;
}

function removalPlan(root: string, registered: boolean, entries: readonly RootEntry[]): Removal {
  const has = (...segments: string[]) =>
    entries.some((entry) => entry.segments.join('/') === segments.join('/'));
  const worktrees = entries
    .filter((entry) => entry.segments[0] === 'worktrees' && entry.kind === 'directory')
    .sort((a, b) => b.segments.length - a.segments.length)
    .map((entry) => join(root, ...entry.segments));
  return {
    gitignore: registered && has('runs', '.gitignore') ? join(root, 'runs', '.gitignore') : null,
    runs: registered && has('runs') ? join(root, 'runs') : null,
    worktrees,
    project: registered && has('project.json') ? join(root, 'project.json') : null,
  };
}

const plannedPaths = (root: string, plan: Removal): string[] =>
  [plan.gitignore, plan.runs, ...plan.worktrees, plan.project, root].filter(
    (path): path is string => path !== null,
  );

/**
 * Carry out a removal plan: unlink `runs/.gitignore`, rmdir `runs/`, rmdir the `worktrees/` tree
 * bottom-up, unlink `project.json`, rmdir the root. A directory that is no longer empty throws a
 * {@link RootBusyError} after restoring the file unlinked just before it, so the root keeps its
 * `project.json` and its `runs/.gitignore`. ENOENT counts as done.
 */
async function removeRoot(
  root: string,
  plan: Removal,
  live: PruneRootsLive,
  warnings: string[],
): Promise<void> {
  const remove = async (directory: string, undo?: () => Promise<void>): Promise<void> => {
    try {
      await live.beforeRmdir?.(directory);
      await rmdir(directory);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      if (undo)
        try {
          await undo();
        } catch (restoreError) {
          warnings.push(
            `Could not restore a file in project root ${root} after ${directory} stayed: ${message(restoreError)}`,
          );
        }
      throw new RootBusyError(
        directory,
        isErrno(error, 'ENOTEMPTY') || isErrno(error, 'EEXIST') ? 'busy' : 'storage',
        error,
      );
    }
  };
  /** Unlink a file, returning how to put it back. */
  const take = async (path: string): Promise<(() => Promise<void>) | undefined> => {
    let bytes: Buffer, mode: number;
    try {
      {
        await using file = await open(path, 'r');
        bytes = await file.readFile();
        mode = (await file.stat()).mode & 0o777;
      }
      await unlink(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw new RootBusyError(path, 'storage', error);
    }
    return () => restore(path, bytes, mode);
  };
  if (plan.runs !== null) {
    const undo = plan.gitignore === null ? undefined : await take(plan.gitignore);
    await remove(plan.runs, undo);
  }
  for (const directory of plan.worktrees) await remove(directory);
  const undo = plan.project === null ? undefined : await take(plan.project);
  await remove(root, undo);
}

/** Up to {@link blockingLimit} entries of a directory that stayed, or the directory itself. */
async function busyPaths(directory: string): Promise<string[]> {
  try {
    const names = (await readdir(directory)).sort().slice(0, blockingLimit);
    return names.length ? names.map((name) => join(directory, name)) : [directory];
  } catch {
    return [directory];
  }
}

function keptMessage(
  decision: Extract<RootDecision, { readonly kind: 'keep' }>,
  root: ProjectRoot,
  runs: readonly string[],
): string {
  switch (decision.reason) {
    case 'runs-kept':
      return `Runs ${list(runs)} stay in ${join(root.root, 'runs')}, so prune keeps the root and its project.json.`;
    case 'in-use':
      return `Worktree namespaces of runs that a scanned runs container still holds (${list(runs)}) are in ${join(root.root, 'worktrees')}, so prune keeps the root.`;
    case 'files': {
      const blocking = decision.blocking.map((segments) => segments.join('/'));
      const why = root.project
        ? 'Its recorded cwd is missing, but it'
        : `It has no valid project.json (${root.problem ?? 'unknown problem'}) and`;
      return `${why} holds entries prune never deletes (${list(blocking)}); remove them by hand if nothing needs them.`;
    }
  }
}

/**
 * Remove or report the stale XDG project roots after `workflow prune --missing-cwd --all` removed its
 * runs (ADR 0051). Stale roots are registered roots whose recorded cwd is missing (stat fails with
 * ENOENT or ENOTDIR) and roots without a valid `project.json`; the current project's root and
 * roots whose cwd exists are never listed. Each stale root is judged by `rootDecision` and, in a
 * real run, removed by {@link removeRoot}: only `project.json` and `runs/.gitignore` are unlinked
 * and every directory goes by `rmdir`, so a cache a live run creates meanwhile keeps the root. No
 * lock is taken: none of this is Git administration. One root's failure never stops the batch; the
 * signal is checked before each root. @internal
 */
export async function pruneRoots(
  options: PruneRootsOptions,
  live: PruneRootsLive = {},
): Promise<PruneRootsOutcome> {
  const warnings: string[] = [];
  const results: PruneRoot[] = [];
  const heldIds = new Set(options.held.map((run) => run.runId));
  const roots = [...options.roots].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  for (const root of roots) {
    if (live.signal?.aborted)
      return { kind: 'interrupted', roots: results, error: live.signal.reason };
    if (root.root === options.current) continue;
    const { project } = root;
    if (project && (await cwdMissing(root.root, project.cwd, warnings)) !== true) continue;
    const base = { root: root.root, cwd: project?.cwd ?? null, registered: project !== null };
    const kept = (
      reason: PruneRootReason,
      paths: readonly string[],
      runs: readonly string[],
      text: string,
    ): PruneRoot => ({ ...base, removed: false, reason, bytes: null, paths, runs, message: text });
    try {
      const keptRuns = project
        ? options.held
            .filter((run) => run.stateDir === project.stateDir)
            .map((run) => run.runId)
            .sort()
        : [];
      const inUse = keptRuns.length
        ? { names: [], runs: [] }
        : await namespacesInUse(root.root, heldIds);
      const walked =
        keptRuns.length || inUse.names.length
          ? { entries: [] }
          : await walk(root.root, project !== null, options.attributed);
      const decision = rootDecision({
        registered: project !== null,
        keptRuns,
        inUse: inUse.names,
        entries: walked.entries,
      });
      if (decision.kind === 'keep') {
        const runs =
          decision.reason === 'runs-kept'
            ? keptRuns
            : decision.reason === 'in-use'
              ? inUse.runs
              : [];
        results.push(
          kept(
            decision.reason,
            decision.blocking.map((segments) => join(root.root, ...segments)),
            runs,
            keptMessage(decision, root, runs),
          ),
        );
        continue;
      }
      const plan = removalPlan(root.root, project !== null, walked.entries);
      const bytes =
        (plan.project === null ? 0 : await fileBytes(plan.project)) +
        (plan.gitignore === null ? 0 : await fileBytes(plan.gitignore));
      if (!options.dryRun)
        try {
          await removeRoot(root.root, plan, live, warnings);
        } catch (error) {
          if (!(error instanceof RootBusyError)) throw error;
          results.push(
            kept(
              error.reason,
              error.reason === 'busy' ? await busyPaths(error.directory) : [error.directory],
              [],
              error.reason === 'busy'
                ? `${error.directory} was no longer empty when prune removed it, so something created an entry during the prune; the root stays${project ? ' with its project.json' : ''}.`
                : `Could not remove ${error.directory}: ${error.message}; the root stays.`,
            ),
          );
          continue;
        }
      results.push({
        ...base,
        removed: true,
        reason: decision.reason,
        bytes,
        paths: plannedPaths(root.root, plan),
        runs: [],
        message:
          decision.reason === 'missing-cwd'
            ? `Its recorded cwd ${project?.cwd ?? ''} is missing and it holds no run, cache or other file.`
            : 'It has no valid project.json and holds only empty worktree directories, if any.',
      });
    } catch (error) {
      results.push(
        kept('storage', [root.root], [], `Could not judge or remove the root: ${message(error)}`),
      );
    }
  }
  return { kind: 'done', roots: results, warnings };
}

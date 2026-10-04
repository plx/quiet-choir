import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pidState } from '../../processes/identity.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import type { ProcessRunner } from './exec-model.js';
import { jsonValue } from './json.js';
import { isErrno, sweepStrays } from './lock.js';
import { legacyRunPath, resolveStateDir, runDirectory } from './paths.js';
import { OrphanProcessesError } from './process-registry.js';
import { readRequiredRun } from './read-required-run.js';
import { removalRefusal, removalVerdict, type RemovalVerdict } from './removal-decision.js';
import { RunRefusedError } from './run-errors.js';
import { openFileOwnedRun, type ReleasableOwnedRun } from './run-store.js';
import { runBytes, runSiblingPaths } from './run-size.js';
import { syncDirectory } from './storage-io.js';
import { inspectRunOwnership, type RunRecord } from './store.js';
import { cleanOwnedWorktrees } from './worktree-clean.js';

/** A plain-data request to remove one saved run (`workflow rm`). @internal */
export interface RemoveRunOptions {
  readonly runId: string;
  readonly stateDir: string;
  /** Remove a running, suspended or waiting run too; never overrides a held lock. */
  readonly force?: boolean;
  /** Also delete the run's pinned Git refs. */
  readonly refs?: boolean;
  /** Report what would be removed, taking no lock and writing nothing. */
  readonly dryRun?: boolean;
}

/** A worktree cache that rm removed, or would remove. @internal */
export interface RemovedCache {
  /** Absolute cache directory. */
  readonly path: string;
  /** `git` removes it with `git worktree remove`; `direct` deletes it because the repository is gone. */
  readonly method: 'git' | 'direct';
}

/** What `workflow rm` removed or, under `dryRun`, would remove. @internal */
export interface RunRemovalResult {
  readonly runId: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly refs: boolean;
  /** `remove`, or the refusal a real removal would meet now (only a dry run returns a refusal). */
  readonly verdict:
    | 'remove'
    | { readonly code: 'run.locked' | 'run.orphans' | 'run.active'; readonly message: string };
  /** Whether the run was removed: always false for a dry run. */
  readonly removed: boolean;
  /** Paths in the runs container that existed for the run before the removal. */
  readonly paths: readonly string[];
  /** Worktree caches not yet removed by an earlier cleanup. */
  readonly caches: readonly RemovedCache[];
  /** Pinned refs deleted (or, for a dry run with `refs`, to delete). */
  readonly refsRemoved: readonly string[];
  /** Pinned refs that survive because `refs` was not requested. */
  readonly keptRefs: readonly string[];
  /** On-disk bytes of the run's files in the runs container, excluding worktree caches. */
  readonly bytes: number;
  /** Abandoned `.<runId>.<pid>.<uuid>.removing` directories swept (or, for a dry run, sweepable). */
  readonly tombstones: readonly string[];
  readonly warnings: readonly string[];
}

/** The outcome of {@link removeRun}: removed (or planned), or stopped by caches Git could not remove. @internal */
export type RunRemovalOutcome =
  | { readonly kind: 'removed'; readonly result: RunRemovalResult }
  | {
      readonly kind: 'blocked';
      readonly runId: string;
      readonly stateDir: string;
      readonly message: string;
      /** Cache paths still present while their repository exists. */
      readonly caches: readonly string[];
      readonly warnings: readonly string[];
    };

/** The deletion steps, in order, that the internal `afterStep` seam observes. @internal */
export type RemovalStep =
  'siblings' | 'flat' | 'backups' | 'primary-released' | 'renamed' | 'tombstone-deleted';

/** Live collaborators kept out of the plain-data request. @internal */
export interface RemoveRunLive {
  readonly signal?: AbortSignal | undefined;
  readonly processSupervisor?: ProcessSupervisor | undefined;
  /** @internal Test seam called after each deletion step; a throw stops the removal there. */
  readonly afterStep?: (step: RemovalStep) => void | Promise<void>;
}

const tombstonePattern =
  /^\.([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.(\d+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.removing$/u;

/** The tombstone a removal renames `<runId>/` to: never a valid run ID, so it never lists. */
function tombstoneName(runId: string): string {
  return `.${runId}.${String(process.pid)}.${randomUUID()}.removing`;
}

/** Tombstones in the runs container whose removing process is dead; live and unknown are kept. */
async function deadTombstones(stateDir: string): Promise<string[]> {
  const entries = await readdir(stateDir).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  });
  return entries
    .filter((name) => {
      const match = tombstonePattern.exec(name);
      return match?.[2] !== undefined && pidState(Number(match[2])) === 'dead';
    })
    .sort();
}

/** Best effort: delete abandoned tombstones, returning the names that are gone now. */
async function sweepTombstones(stateDir: string): Promise<string[]> {
  const swept: string[] = [];
  for (const name of await deadTombstones(stateDir).catch((): string[] => []))
    try {
      await rm(join(stateDir, name), { recursive: true, force: true });
      swept.push(name);
    } catch {
      /* A tombstone never lists as a run; the next rm retries. */
    }
  return swept;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/** The run's paths in the runs container that exist now, directory first. */
async function existingPaths(stateDir: string, runId: string): Promise<string[]> {
  const siblings = await runSiblingPaths(stateDir, runId);
  const candidates = [
    runDirectory(stateDir, runId),
    siblings.flat,
    `${siblings.flat}.lock`,
    ...siblings.backups,
    siblings.cancel,
    siblings.inbox,
  ];
  const present: string[] = [];
  for (const path of candidates) if (await exists(path)) present.push(path);
  return present;
}

function refusalError(
  runId: string,
  stateDir: string,
  verdict: Exclude<RemovalVerdict, { readonly kind: 'remove' }>,
): RunRefusedError {
  if (verdict.kind === 'orphans') {
    const error = new OrphanProcessesError(
      runId,
      verdict.processes,
      verdict.owner && {
        pid: verdict.owner.pid,
        host: verdict.owner.host,
        state: verdict.owner.state,
      },
    );
    error.message = removalRefusal(runId, stateDir, verdict).message;
    return error;
  }
  const refusal = removalRefusal(runId, stateDir, verdict);
  return new RunRefusedError(refusal.code, runId, refusal.message, jsonValue(refusal.details));
}

/** The namespace directory that holds every cache of the run's ledger. */
function namespaceDirectory(
  record: RunRecord,
  ledger: NonNullable<RunRecord['worktrees']>,
): string {
  return join(ledger.root, `${record.id}-${ledger.namespace}`);
}

/** Plan a removal without a lock, a sweep or any write. */
async function planRemoval(stateDir: string, options: RemoveRunOptions): Promise<RunRemovalResult> {
  const { runId } = options;
  const record = await readRequiredRun({ runId, stateDir });
  const ownership = await inspectRunOwnership({ runId, stateDir });
  const verdict = removalVerdict(record, ownership, { force: options.force ?? false });
  const ledger = record.worktrees;
  const repoExists = ledger ? await exists(ledger.repo) : false;
  const refs = ledger && repoExists ? Object.keys(ledger.refs) : [];
  return {
    runId,
    stateDir,
    dryRun: true,
    force: options.force ?? false,
    refs: options.refs ?? false,
    verdict: verdict.kind === 'remove' ? 'remove' : pick(removalRefusal(runId, stateDir, verdict)),
    removed: false,
    paths: await existingPaths(stateDir, runId),
    caches: Object.values(ledger?.caches ?? {})
      .filter((cache) => cache.state !== 'removed')
      .map((cache) => ({ path: cache.path, method: repoExists ? 'git' : 'direct' })),
    refsRemoved: options.refs ? refs : [],
    keptRefs: options.refs ? [] : refs,
    bytes: await runBytes(stateDir, runId),
    tombstones: await deadTombstones(stateDir),
    warnings:
      ledger && !repoExists && Object.keys(ledger.refs).length
        ? [`Repository ${ledger.repo} is gone; the run's pinned refs went with it.`]
        : [],
  };
}

function pick(refusal: ReturnType<typeof removalRefusal>): {
  readonly code: 'run.locked' | 'run.orphans' | 'run.active';
  readonly message: string;
} {
  return { code: refusal.code, message: refusal.message };
}

/**
 * Remove one saved run without importing workflow code (ADR 0049). It sweeps abandoned
 * tombstones, refuses a held lock, orphans or (without `force`) an active run, takes the run lock
 * without registering a project, re-checks the record, removes worktree caches through the shared
 * cleanup (or directly when the repository is gone) and, with `refs`, pinned refs. A cache Git
 * cannot remove stops it before any deletion. Holding the legacy guard throughout, it then deletes
 * the legacy siblings, the flat checkpoint or marker (a flat run's commit point), the backups,
 * releases the primary lock, renames `<runId>/` to a dotted tombstone (a directory run's commit
 * point) and deletes it. The signal is honoured only before the flat file goes. @internal
 */
export async function removeRun(
  options: RemoveRunOptions,
  runner: ProcessRunner,
  live: RemoveRunLive = {},
): Promise<RunRemovalOutcome> {
  const { runId } = options;
  const stateDir = resolveStateDir({ stateDir: options.stateDir });
  if (options.dryRun) return { kind: 'removed', result: await planRemoval(stateDir, options) };
  const force = options.force ?? false;
  const { signal } = live;
  const tombstones = await sweepTombstones(stateDir);
  const initial = await readRequiredRun({ runId, stateDir });
  const verdict = removalVerdict(initial, await inspectRunOwnership({ runId, stateDir }), {
    force,
  });
  if (verdict.kind !== 'remove') throw refusalError(runId, stateDir, verdict);
  // Measured before the lock exists, so a real removal reports what its dry run reports.
  const paths = await existingPaths(stateDir, runId);
  const bytes = await runBytes(stateDir, runId);
  signal?.throwIfAborted();
  const owned = await openFileOwnedRun(stateDir, runId, {
    ...(signal === undefined ? {} : { signal }),
    ...(live.processSupervisor === undefined ? {} : { processSupervisor: live.processSupervisor }),
  });
  let outcome: RunRemovalOutcome;
  try {
    outcome = await removeOwned(owned, runner, live, {
      runId,
      stateDir,
      force,
      refs: options.refs ?? false,
      paths,
      bytes,
      tombstones,
    });
  } catch (error) {
    try {
      await owned.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Could not remove the run or release it.', {
        cause: releaseError,
      });
    }
    throw error;
  }
  if (outcome.kind === 'blocked') {
    await owned.release();
    return outcome;
  }
  // The run is gone; only the legacy guard is still held.
  const guard = `${legacyRunPath(stateDir, runId)}.lock`;
  try {
    await owned.release();
  } catch (error) {
    outcome = {
      kind: 'removed',
      result: {
        ...outcome.result,
        warnings: [
          ...outcome.result.warnings,
          `Removed the run but could not release ${guard}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
    };
  }
  await sweepStrays(guard);
  return outcome;
}

/** Everything after `lockRun`: re-check, caches and refs, then the guard-held deletion order. */
async function removeOwned(
  owned: ReleasableOwnedRun,
  runner: ProcessRunner,
  live: RemoveRunLive,
  context: {
    readonly runId: string;
    readonly stateDir: string;
    readonly force: boolean;
    readonly refs: boolean;
    readonly paths: readonly string[];
    readonly bytes: number;
    readonly tombstones: readonly string[];
  },
): Promise<RunRemovalOutcome> {
  const { runId, stateDir, force, signal } = { ...context, signal: live.signal };
  const step = async (name: RemovalStep): Promise<void> => {
    await live.afterStep?.(name);
  };
  const record = await readRequiredRun({ runId, stateDir });
  const recheck = removalVerdict(
    record,
    { locked: false, owner: null, processes: [], locks: [] },
    { force },
  );
  if (recheck.kind !== 'remove') throw refusalError(runId, stateDir, recheck);
  const warnings: string[] = [];
  const caches: RemovedCache[] = [];
  let refsRemoved: readonly string[] = [];
  let keptRefs: readonly string[] = [];
  const ledger = record.worktrees;
  if (ledger) {
    const namespace = namespaceDirectory(record, ledger);
    if (await exists(ledger.repo)) {
      const pending = Object.values(ledger.caches).some((cache) => cache.state !== 'removed');
      if (pending || (context.refs && Object.keys(ledger.refs).length)) {
        const cleanup = await cleanOwnedWorktrees(
          owned,
          record,
          { stateDir, refs: context.refs, refsOnlyWhenClean: true },
          runner,
          signal,
        );
        if (cleanup.remaining.length)
          return {
            kind: 'blocked',
            runId,
            stateDir,
            message: `Run ${runId} was not removed: ${String(cleanup.remaining.length)} worktree caches could not be removed while their repository ${ledger.repo} exists (${cleanup.remaining.join(', ')}). Fix the cause in the warnings, then retry with quiet-choir workflow clean ${runId} --state-dir ${stateDir} and rm again.`,
            caches: cleanup.remaining,
            warnings: cleanup.warnings,
          };
        caches.push(...cleanup.directories.map((path) => ({ path, method: 'git' as const })));
        refsRemoved = cleanup.refs;
      }
      keptRefs = context.refs ? [] : Object.keys(ledger.refs);
    } else {
      caches.push(...(await removeCachesDirectly(owned, record, ledger, namespace)));
      if (Object.keys(ledger.refs).length)
        warnings.push(`Repository ${ledger.repo} is gone; the run's pinned refs went with it.`);
    }
    try {
      await rmdir(namespace);
    } catch (error) {
      if (!isErrno(error, 'ENOENT'))
        warnings.push(
          `Kept worktree namespace ${namespace}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }
  signal?.throwIfAborted();
  const siblings = await runSiblingPaths(stateDir, runId);
  const removeSiblings = async (): Promise<void> => {
    for (const path of [siblings.cancel, siblings.inbox])
      await rm(path, { recursive: true, force: true });
  };
  await removeSiblings();
  await step('siblings');
  signal?.throwIfAborted();
  // From here on the removal finishes even if interrupted, so no half-deleted run is left.
  await rm(siblings.flat, { force: true });
  await syncDirectory(stateDir);
  await step('flat');
  for (const backup of siblings.backups) await rm(backup, { force: true });
  await step('backups');
  await owned.releaseOwner();
  await step('primary-released');
  const tombstone = join(stateDir, tombstoneName(runId));
  try {
    await rename(runDirectory(stateDir, runId), tombstone);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await syncDirectory(stateDir);
  await step('renamed');
  // A racing `workflow answer` may have linked into `<runId>.inbox` before the marker went.
  await removeSiblings();
  await rm(tombstone, { recursive: true, force: true });
  await step('tombstone-deleted');
  return {
    kind: 'removed',
    result: {
      runId,
      stateDir,
      dryRun: false,
      force,
      refs: context.refs,
      verdict: 'remove',
      removed: true,
      paths: context.paths,
      caches,
      refsRemoved,
      keptRefs,
      bytes: context.bytes,
      tombstones: context.tombstones,
      warnings,
    },
  };
}

/**
 * Delete the caches of a ledger whose repository is gone, so Git cannot remove them. Each cache
 * must sit directly in the run's namespace directory, which must be a real directory, so a corrupt
 * ledger can never delete anything else. Saves the ledger only when it changed.
 */
async function removeCachesDirectly(
  owned: ReleasableOwnedRun,
  record: RunRecord,
  ledger: NonNullable<RunRecord['worktrees']>,
  namespace: string,
): Promise<RemovedCache[]> {
  const pending = Object.values(ledger.caches).filter((cache) => cache.state !== 'removed');
  if (!pending.length) return [];
  for (const cache of pending)
    if (dirname(cache.path) !== namespace)
      throw new Error(
        `Worktree cache ${cache.path} is outside ${namespace}; rm refuses to delete it.`,
      );
  const directory = await lstat(namespace).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (directory && (directory.isSymbolicLink() || !directory.isDirectory()))
    throw new Error(
      `Worktree namespace ${namespace} is not a directory; rm refuses to delete its caches.`,
    );
  const removed: RemovedCache[] = [];
  for (const cache of pending) {
    if (directory) await rm(cache.path, { recursive: true, force: true });
    cache.state = 'removed';
    removed.push({ path: cache.path, method: 'direct' });
  }
  record.updatedAt = new Date().toISOString();
  await owned.append(record);
  return removed;
}

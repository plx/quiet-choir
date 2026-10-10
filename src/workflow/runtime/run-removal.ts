import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pidState } from '../../processes/identity.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { formatArgv, nextDetail, workflowArgv, type CommandLauncher } from './commands.js';
import type { ProcessRunner } from './exec-model.js';
import type { JsonValue } from './model.js';
import { digest, jsonValue } from './json.js';
import {
  inFlightLeftoverMessage,
  inFlightUnreadableMessage,
  type LaunchJudgement,
} from './launch-leftover-decision.js';
import {
  inspectLaunchLeftover,
  inspectRunLaunches,
  runRecordPresent,
  type LaunchLeftover,
  type LaunchSettleOptions,
  type LeftoverLaunch,
} from './launch-leftovers.js';
import { inspectInterruptedRemoval, type InterruptedRemoval } from './interrupted-removal.js';
import { isErrno, sweepStrays, withRunGuard } from './lock.js';
import { legacyRunPath, resolveStateDir, runDirectory } from './paths.js';
import { OrphanProcessesError } from './process-registry.js';
import {
  holdsRun,
  missingRunError,
  readRequiredRun,
  unreadableRunError,
} from './read-required-run.js';
import {
  damagedRecordCode,
  ownershipHold,
  removalRefusal,
  removalVerdict,
  type RemovalVerdict,
} from './removal-decision.js';
import { RunRefusedError } from './run-errors.js';
import { openFileOwnedRun, type ReleasableOwnedRun } from './run-store.js';
import { runBytes, runSiblingPaths } from './run-size.js';
import { syncDirectory } from './storage-io.js';
import { inspectRunOwnership, refuseRecordSchemaDrift, type RunRecord } from './store.js';
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
  /**
   * @internal `workflow prune` only: the `updatedAt` of the record it selected. A removal refuses
   * with `run.exists` when the record carries another value, on the first read (a dry run too, so a
   * preview never lists a run a real prune would refuse) or, for a real removal, again under the
   * lock, so prune never deletes a run that changed after it was selected. `workflow rm` never
   * sets it.
   */
  readonly expectedUpdatedAt?: string;
  /**
   * Also remove a run whose record file is present but whose content is damaged (ADR 0060): an
   * invalid record, a journal gap, a format-7 marker without its directory, or `run.json` without
   * `journal.jsonl`. A record unreadable for access or I/O reasons, or a newer build's record, is
   * still refused. A readable run, or a leftover launch directory, is removed as without it.
   */
  readonly unreadable?: boolean;
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
  /**
   * True when the ID named no run, only the leftover `<runId>/launch/` of a start that failed
   * before its record (ADR 0055): there are no caches or refs, and `--refs` changes nothing.
   */
  readonly launchOnly: boolean;
  /**
   * True when the run's record was damaged and `unreadable` removed it without reading it (ADR
   * 0060): no caches or refs were touched, and a warning says how to find any it named.
   */
  readonly unreadable: boolean;
  /**
   * True when the ID named no run, only what a removal of an unmigrated flat run left after its
   * commit point (ADR 0061): rm finished that removal. There are no caches or refs left, and
   * `--refs`, `--force` and `--unreadable` change nothing.
   */
  readonly interrupted: boolean;
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
      /** Caches Git removed before the failure; they stay removed and the ledger records it. */
      readonly removed: readonly string[];
      readonly warnings: readonly string[];
    };

/** The deletion steps, in order, that the internal `afterStep` seam observes. @internal */
export type RemovalStep =
  'siblings' | 'flat' | 'backups' | 'primary-released' | 'renamed' | 'tombstone-deleted';

/** Live collaborators kept out of the plain-data request. @internal */
export interface RemoveRunLive {
  readonly signal?: AbortSignal | undefined;
  readonly processSupervisor?: ProcessSupervisor | undefined;
  /** Program words behind the `workflow unlock` command that a `run.locked` refusal names. */
  readonly commandLauncher?: CommandLauncher | undefined;
  /** @internal Test seam called after each deletion step; a throw stops the removal there. */
  readonly afterStep?: (step: RemovalStep) => void | Promise<void>;
  /** @internal Test seam called after the inspection and before the run lock is taken. */
  readonly beforeLock?: () => void | Promise<void>;
  /** @internal Test seam for the settle floor and clock that judge a leftover launch directory. */
  readonly launchSettle?: LaunchSettleOptions | undefined;
}

const tombstonePattern =
  /^\.([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.(\d+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.removing$/u;

/** A cache directory name: `RunWorktrees` names each cache by a SHA-256 digest. */
const cacheName = /^[0-9a-f]{64}$/u;

/** The tombstone a removal renames `<runId>/` to: never a valid run ID, so it never lists. */
function tombstoneName(runId: string): string {
  return `.${runId}.${String(process.pid)}.${randomUUID()}.removing`;
}

/**
 * Names of the tombstones in the runs container whose removing process is dead; live and unknown
 * ones are kept. @internal
 */
export async function deadTombstones(stateDir: string): Promise<string[]> {
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

/** Best effort: delete abandoned tombstones, returning the names that are gone now. @internal */
export async function sweepTombstones(stateDir: string): Promise<string[]> {
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
  launcher?: CommandLauncher,
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
    error.message = removalRefusal(runId, stateDir, verdict, launcher).message;
    return error;
  }
  const refusal = removalRefusal(runId, stateDir, verdict, launcher);
  return new RunRefusedError(refusal.code, runId, refusal.message, jsonValue(refusal.details));
}

/** Refuse a run whose record changed after `workflow prune` selected it. */
function checkUpdatedAt(runId: string, expected: string, updatedAt: string): void {
  if (updatedAt !== expected)
    throw new RunRefusedError(
      'run.exists',
      runId,
      `Run ${runId} changed after prune selected it (updatedAt ${expected}, now ${updatedAt}); nothing was removed. Re-run prune to judge the current record.`,
      jsonValue({ expectedUpdatedAt: expected, updatedAt }),
    );
}

/** The namespace directory that holds every cache of the run's ledger. */
function namespaceDirectory(
  record: RunRecord,
  ledger: NonNullable<RunRecord['worktrees']>,
): string {
  return join(ledger.root, `${record.id}-${ledger.namespace}`);
}

/** Plan a removal of the read `record` without a lock, a sweep or any write. */
async function planRemoval(
  stateDir: string,
  options: RemoveRunOptions,
  record: RunRecord,
  launcher?: CommandLauncher,
): Promise<RunRemovalResult> {
  const { runId } = options;
  if (options.expectedUpdatedAt !== undefined)
    checkUpdatedAt(runId, options.expectedUpdatedAt, record.updatedAt);
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
    verdict:
      verdict.kind === 'remove'
        ? 'remove'
        : pick(removalRefusal(runId, stateDir, verdict, launcher)),
    removed: false,
    launchOnly: false,
    unreadable: false,
    interrupted: false,
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
 * without registering a project, re-checks the record (it must still be the inspected run, by
 * `createdAt`, not a replacement that reused the ID, and still removable), removes worktree caches through the shared
 * cleanup (or directly when the repository is gone) and, with `refs`, pinned refs. A cache Git
 * cannot remove stops it before it deletes the run: caches Git already removed stay removed (the
 * ledger records them), no ref is deleted and the record stays for `workflow clean`. Holding the
 * legacy guard throughout, it then deletes the legacy siblings, the flat checkpoint or marker (a
 * flat run's commit point), the backups, releases the primary lock, renames `<runId>/` to a dotted
 * tombstone (a directory run's commit point) and deletes it. The signal is honoured only before the flat file goes.
 * With `unreadable`, a run whose record content is damaged takes {@link removeUnreadable} instead;
 * without it, rm refuses such a run with `run.unreadable` naming the `--unreadable` command. An ID
 * that names only a leftover launch directory takes {@link removeLaunchLeftover} (ADR 0055), and one
 * that names only what an interrupted removal of a flat run left takes
 * {@link finishInterruptedRemoval} (ADR 0061); prune's pinned removals take neither. @internal
 */
export async function removeRun(
  options: RemoveRunOptions,
  runner: ProcessRunner,
  live: RemoveRunLive = {},
): Promise<RunRemovalOutcome> {
  const { runId } = options;
  const stateDir = resolveStateDir({ stateDir: options.stateDir });
  // Prune pins a listed record's updatedAt, and a listed run always has a record: only rm by ID
  // reaches a leftover launch directory. A directory that cannot be inspected is left to the
  // ordinary record read, which reports it.
  const leftoverOf = async (): Promise<LaunchLeftover | null> =>
    options.expectedUpdatedAt === undefined
      ? inspectLaunchLeftover(stateDir, runId, live.launchSettle).catch(() => null)
      : null;
  // Likewise only rm by ID finishes an interrupted removal (prune sweeps its containers itself).
  const interruptedOf = async (): Promise<InterruptedRemoval | null> =>
    options.expectedUpdatedAt === undefined
      ? inspectInterruptedRemoval(stateDir, runId).catch(() => null)
      : null;
  if (options.dryRun) {
    const leftover = await leftoverOf();
    if (leftover)
      return {
        kind: 'removed',
        result: await planLeftoverRemoval(stateDir, options, leftover, live.commandLauncher),
      };
    const interrupted = await interruptedOf();
    if (interrupted)
      return {
        kind: 'removed',
        result: await planInterruptedRemoval(options, interrupted, live.commandLauncher),
      };
    const read = await readForRemoval(stateDir, options, live.commandLauncher);
    return {
      kind: 'removed',
      result:
        'record' in read
          ? await planRemoval(stateDir, options, read.record, live.commandLauncher)
          : await planUnreadableRemoval(stateDir, options, live),
    };
  }
  const force = options.force ?? false;
  const { signal } = live;
  const tombstones = await sweepTombstones(stateDir);
  const leftover = await leftoverOf();
  if (leftover) return removeLaunchLeftover(stateDir, options, leftover, live, tombstones);
  const interrupted = await interruptedOf();
  if (interrupted)
    return finishInterruptedRemoval(interrupted, live, {
      force,
      refs: options.refs ?? false,
      tombstones,
    });
  const read = await readForRemoval(stateDir, options, live.commandLauncher);
  if (!('record' in read)) return removeUnreadable(stateDir, options, live, tombstones);
  const initial = read.record;
  if (options.expectedUpdatedAt !== undefined)
    checkUpdatedAt(runId, options.expectedUpdatedAt, initial.updatedAt);
  const verdict = removalVerdict(initial, await inspectRunOwnership({ runId, stateDir }), {
    force,
  });
  if (verdict.kind !== 'remove') throw refusalError(runId, stateDir, verdict, live.commandLauncher);
  // Measured before the lock exists, so a real removal reports what its dry run reports.
  const paths = await existingPaths(stateDir, runId);
  const bytes = await runBytes(stateDir, runId);
  signal?.throwIfAborted();
  await live.beforeLock?.();
  return withOwnedRun(stateDir, runId, live, (owned) =>
    removeOwned(owned, runner, live, {
      runId,
      stateDir,
      generation: initial.createdAt,
      expectedUpdatedAt: options.expectedUpdatedAt,
      force,
      refs: options.refs ?? false,
      paths,
      bytes,
      tombstones,
    }),
  );
}

/**
 * Take the run lock without a working directory, run `body` under it and release it: every lock on
 * a failure, as one error with the release's, and the legacy guard last once the run is removed,
 * when a failed release only warns. A blocked outcome releases both locks.
 */
async function withOwnedRun(
  stateDir: string,
  runId: string,
  live: RemoveRunLive,
  body: (owned: ReleasableOwnedRun) => Promise<RunRemovalOutcome>,
): Promise<RunRemovalOutcome> {
  const { signal } = live;
  const owned = await openFileOwnedRun(stateDir, runId, {
    commandLauncher: live.commandLauncher,
    ...(signal === undefined ? {} : { signal }),
    ...(live.processSupervisor === undefined ? {} : { processSupervisor: live.processSupervisor }),
  });
  let outcome: RunRemovalOutcome;
  try {
    outcome = await body(owned);
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
    /** The `createdAt` of the run rm inspected; the locked record must still carry it. */
    readonly generation: string;
    /** As on {@link RemoveRunOptions.expectedUpdatedAt}: checked again under the lock. */
    readonly expectedUpdatedAt: string | undefined;
    readonly force: boolean;
    readonly refs: boolean;
    readonly paths: readonly string[];
    readonly bytes: number;
    readonly tombstones: readonly string[];
  },
): Promise<RunRemovalOutcome> {
  const { runId, stateDir, force, signal } = { ...context, signal: live.signal };
  const record = await readRequiredRun({ runId, stateDir });
  // The ID is user-chosen: another rm can delete the run rm inspected and a new run can reuse the
  // ID before this lock is taken. Only the inspected generation may be removed.
  if (record.createdAt !== context.generation)
    throw new RunRefusedError(
      'run.exists',
      runId,
      `Run ${runId} was replaced by another run with the same ID after rm inspected it; nothing was removed. Re-run rm to inspect the current run.`,
      jsonValue({ expectedCreatedAt: context.generation, createdAt: record.createdAt }),
    );
  if (context.expectedUpdatedAt !== undefined)
    checkUpdatedAt(runId, context.expectedUpdatedAt, record.updatedAt);
  const recheck = removalVerdict(
    record,
    { locked: false, owner: null, processes: [], locks: [] },
    { force },
  );
  if (recheck.kind !== 'remove') throw refusalError(runId, stateDir, recheck, live.commandLauncher);
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
        // Cleanup saves the ledger, which would drop what this build does not know.
        refuseRecordSchemaDrift(record);
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
            message: `Run ${runId} was not removed: ${String(cleanup.remaining.length)} worktree caches could not be removed while their repository ${ledger.repo} exists (${cleanup.remaining.join(', ')}). Fix the cause in the warnings, then retry with ${formatArgv(workflowArgv(live.commandLauncher, 'clean', runId, '--state-dir', stateDir))} and rm again.`,
            caches: cleanup.remaining,
            removed: cleanup.directories,
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
  await deleteRunFiles(owned, stateDir, runId, live);
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
      launchOnly: false,
      unreadable: false,
      interrupted: false,
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
 * The guard-held deletion order shared by an ordinary, an unreadable and a finished interrupted
 * removal, under the run lock: the legacy siblings, the flat `<runId>.json` and a directory flush (a flat run's commit point), the
 * backups, the primary lock's release, the rename of `<runId>/` to a tombstone and a flush (a
 * directory run's commit point), the siblings again and the tombstone. The signal is honoured only
 * before the flat file goes; the caller releases the legacy guard. Every step tolerates a path that
 * is already gone, so running it again finishes a removal that stopped part-way (ADR 0061).
 */
async function deleteRunFiles(
  owned: ReleasableOwnedRun,
  stateDir: string,
  runId: string,
  live: RemoveRunLive,
): Promise<void> {
  const { signal } = live;
  const step = async (name: RemovalStep): Promise<void> => {
    await live.afterStep?.(name);
  };
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
  // Recursive, so a record path of the wrong kind (`EISDIR`, which `--unreadable` accepts) goes whole;
  // it does not follow a symbolic link and removes a regular file the same way.
  await rm(siblings.flat, { recursive: true, force: true });
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
  // The commit point has passed. A racing `workflow answer` that linked into `<runId>.inbox` before
  // it is swept here (one in `<runId>/inbox` went into the tombstone); one that links later finds
  // the run gone and withdraws its delivery (withdrawDeliveryIfRunRemoved in inbox.ts).
  await removeSiblings();
  await rm(tombstone, { recursive: true, force: true });
  await step('tombstone-deleted');
}

/**
 * Delete the caches of a ledger whose repository is gone, so Git cannot remove them. The record is
 * the operator's own state and its namespace a schema-validated UUID, so these structural checks
 * only keep a corrupt ledger from deleting anything but a cache `RunWorktrees` could have created:
 * an absolute root; a path that is exactly `<namespace>/<sha256 hex>`, keyed by its own digest as
 * `RunWorktrees` keys caches; a namespace and a cache that are real directories, not symbolic
 * links. A cache already gone is just marked removed. Saves the ledger only when it changed.
 */
async function removeCachesDirectly(
  owned: ReleasableOwnedRun,
  record: RunRecord,
  ledger: NonNullable<RunRecord['worktrees']>,
  namespace: string,
): Promise<RemovedCache[]> {
  const pending = Object.entries(ledger.caches).filter(([, cache]) => cache.state !== 'removed');
  if (!pending.length) return [];
  // Marking caches removed saves the ledger, which would drop what this build does not know.
  refuseRecordSchemaDrift(record);
  const refuse = (reason: string): never => {
    throw new Error(`${reason}; rm refuses to delete the run's worktree caches.`);
  };
  if (!isAbsolute(ledger.root)) refuse(`Worktree root ${ledger.root} is not absolute`);
  for (const [key, cache] of pending) {
    const name = basename(cache.path);
    if (dirname(cache.path) !== namespace || cache.path !== join(namespace, name))
      refuse(`Worktree cache ${cache.path} is outside ${namespace}`);
    if (!cacheName.test(name))
      refuse(`Worktree cache ${cache.path} is not named by a SHA-256 digest`);
    if (key !== digest(cache.path))
      refuse(`Worktree cache ${cache.path} does not match its ledger key ${key}`);
  }
  const directory = await lstatIfPresent(namespace);
  if (directory && (directory.isSymbolicLink() || !directory.isDirectory()))
    refuse(`Worktree namespace ${namespace} is not a directory`);
  const present: boolean[] = [];
  for (const [, cache] of pending) {
    const entry = directory ? await lstatIfPresent(cache.path) : undefined;
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
      refuse(`Worktree cache ${cache.path} is not a directory`);
    present.push(entry !== undefined);
  }
  const removed: RemovedCache[] = [];
  for (const [index, [, cache]] of pending.entries()) {
    if (present[index]) await rm(cache.path, { recursive: true, force: true });
    cache.state = 'removed';
    removed.push({ path: cache.path, method: 'direct' });
  }
  record.updatedAt = new Date().toISOString();
  await owned.append(record);
  return removed;
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
}

/**
 * The `run.active` refusal of a leftover, or of a run with an unreadable record, whose start may
 * still be in flight; `--force` never overrides it.
 */
function inFlightRefusal(
  runId: string,
  launches: readonly LaunchJudgement[],
  message: string = inFlightLeftoverMessage(runId, launches),
): RunRefusedError {
  return new RunRefusedError(
    'run.active',
    runId,
    message,
    jsonValue({
      status: 'starting',
      waiting: [],
      launches: launches.map((launch: LaunchJudgement) => ({
        n: launch.n,
        pid: launch.pid,
        host: launch.host,
        state: launch.runner,
        inFlight: launch.state === 'in-flight',
      })),
    }),
  );
}

/** The dry run of a leftover launch directory: what {@link removeLaunchLeftover} would do now. */
async function planLeftoverRemoval(
  stateDir: string,
  options: RemoveRunOptions,
  leftover: LaunchLeftover,
  launcher?: CommandLauncher,
): Promise<RunRemovalResult> {
  const { runId } = options;
  // A settled leftover is still refused while the legacy guard (or a lock beside it) is held, as
  // the real removal's guard acquisition would refuse it; an in-flight leftover stays `run.active`.
  const hold = leftover.removable
    ? ownershipHold(await inspectRunOwnership({ runId, stateDir }))
    : null;
  return {
    runId,
    stateDir,
    dryRun: true,
    force: options.force ?? false,
    refs: options.refs ?? false,
    verdict: hold
      ? pick(removalRefusal(runId, stateDir, hold, launcher))
      : leftover.removable
        ? 'remove'
        : { code: 'run.active', message: inFlightLeftoverMessage(runId, leftover.launches) },
    removed: false,
    launchOnly: true,
    unreadable: false,
    interrupted: false,
    paths: [leftover.path],
    caches: [],
    refsRemoved: [],
    keptRefs: [],
    bytes: leftover.bytes,
    tombstones: await deadTombstones(stateDir),
    warnings: [],
  };
}

/**
 * Remove the leftover `<runId>/launch/` of a start that failed before its record (ADR 0055). It
 * refuses with `run.active`, even with `force`, while any launch may still be in flight. Under the
 * legacy guard, which start's allocation and the runner's lock also take first, it re-checks that
 * no record exists (`run.exists`) and that the directory is still a settled leftover, renames
 * `<runId>/` to a tombstone (the commit point), flushes the container and deletes the tombstone.
 * The signal is honoured up to the rename: an abort until then leaves the directory in place.
 */
async function removeLaunchLeftover(
  stateDir: string,
  options: RemoveRunOptions,
  leftover: LaunchLeftover,
  live: RemoveRunLive,
  tombstones: readonly string[],
): Promise<RunRemovalOutcome> {
  const { runId } = options;
  const { signal } = live;
  if (!leftover.removable) throw inFlightRefusal(runId, leftover.launches);
  // The verdict the dry run reports: a held (or unreadable) guard refuses before the guard is
  // taken, as ordinary rm does, so an empty lock directory is `run.locked` rather than a wait.
  const hold = ownershipHold(await inspectRunOwnership({ runId, stateDir }));
  if (hold) throw refusalError(runId, stateDir, hold, live.commandLauncher);
  signal?.throwIfAborted();
  await live.beforeLock?.();
  const guard = `${legacyRunPath(stateDir, runId)}.lock`;
  const warnings: string[] = [];
  // Set inside the guarded callback; an object, so the catch below reads the current values.
  const progress = { committed: false, bodyFailed: false };
  const removeGuarded = async (): Promise<void> => {
    const current = await inspectLaunchLeftover(stateDir, runId, live.launchSettle);
    if (current === null) {
      if (await runRecordPresent(stateDir, runId))
        throw new RunRefusedError(
          'run.exists',
          runId,
          `A run now holds ID ${runId}, so its leftover launch directory was not removed; nothing was removed. Rerun rm to judge the run.`,
          jsonValue({ stateDir }),
        );
      throw await missingRunError({ runId, stateDir });
    }
    if (!current.removable) throw inFlightRefusal(runId, current.launches);
    // The last point where an abort leaves the directory in place.
    signal?.throwIfAborted();
    const tombstone = join(stateDir, tombstoneName(runId));
    await rename(runDirectory(stateDir, runId), tombstone);
    await syncDirectory(stateDir);
    progress.committed = true;
    await live.afterStep?.('renamed');
    await rm(tombstone, { recursive: true, force: true });
    await live.afterStep?.('tombstone-deleted');
  };
  try {
    await withRunGuard(
      stateDir,
      runId,
      async () => {
        try {
          await removeGuarded();
        } catch (error) {
          progress.bodyFailed = true;
          throw error;
        }
      },
      {
        commandLauncher: live.commandLauncher,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    // Past the rename the directory is gone; a failed guard release then only warns.
    if (progress.bodyFailed || !progress.committed) throw error;
    warnings.push(
      `Removed the leftover launch directory but could not release ${guard}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await sweepStrays(guard);
  return {
    kind: 'removed',
    result: {
      runId,
      stateDir,
      dryRun: false,
      force: options.force ?? false,
      refs: options.refs ?? false,
      verdict: 'remove',
      removed: true,
      launchOnly: true,
      unreadable: false,
      interrupted: false,
      paths: [leftover.path],
      caches: [],
      refsRemoved: [],
      keptRefs: [],
      bytes: leftover.bytes,
      tombstones,
      warnings,
    },
  };
}

/**
 * The record rm judges, or `damaged` when `unreadable` lets rm remove a damaged one (ADR 0060). A
 * damaged record without `unreadable` is refused as `run.unreadable` naming the `--unreadable`
 * command in `details.next`; with it, a record unreadable for any other reason is refused saying
 * why. Prune pins the record it listed, and its read failures stay as they are.
 */
async function readForRemoval(
  stateDir: string,
  options: RemoveRunOptions,
  launcher?: CommandLauncher,
): Promise<{ readonly record: RunRecord } | { readonly damaged: RunRefusedError }> {
  const { runId } = options;
  try {
    return { record: await readRequiredRun({ runId, stateDir }) };
  } catch (error) {
    if (options.expectedUpdatedAt !== undefined) throw error;
    const damaged = await damagedRecordFailure(stateDir, runId, error);
    if (damaged === null) throw options.unreadable ? notDamagedError(error) : error;
    if (options.unreadable) return { damaged };
    throw unreadableHint(damaged, stateDir, runId, options.dryRun ?? false, launcher);
  }
}

function detailsObject(details: JsonValue): Record<string, JsonValue> {
  return details !== null && typeof details === 'object' && !Array.isArray(details) ? details : {};
}

/**
 * The `run.unreadable` refusal of a record read failure whose record file (`<runId>/run.json` or
 * `<runId>.json`) is present and whose content is damaged, by {@link damagedRecordCode}, or null.
 * A `run.not_found` while the record file is present (a missing companion, such as `run.json`
 * without `journal.jsonl`) counts as damaged and becomes `run.unreadable`. Every other failure,
 * including `run.incompatible`, is null.
 */
async function damagedRecordFailure(
  stateDir: string,
  runId: string,
  error: unknown,
): Promise<RunRefusedError | null> {
  if (!(error instanceof RunRefusedError)) return null;
  if (error.code === 'run.unreadable') {
    const code = detailsObject(error.details)['filesystemCode'];
    return (code === null || typeof code === 'string') &&
      damagedRecordCode(code) &&
      (await holdsRun(stateDir, runId))
      ? error
      : null;
  }
  if (error.code === 'run.not_found' && (await holdsRun(stateDir, runId)))
    return unreadableRunError({ runId, stateDir }, error.cause ?? error);
  return null;
}

/** rm's refusal of a damaged record without `--unreadable`: it names the command that removes it. */
function unreadableHint(
  damaged: RunRefusedError,
  stateDir: string,
  runId: string,
  dryRun: boolean,
  launcher?: CommandLauncher,
): RunRefusedError {
  const argv = workflowArgv(
    launcher,
    'rm',
    runId,
    '--state-dir',
    stateDir,
    '--unreadable',
    ...(dryRun ? ['--dry-run'] : []),
  );
  return new RunRefusedError(
    'run.unreadable',
    runId,
    `Run ${runId} has a damaged record (${damaged.message}); nothing was removed. If the run is no longer needed, remove it without reading its record, leaving any worktree caches and pinned refs it named, with ${formatArgv(argv)}.`,
    {
      ...detailsObject(damaged.details),
      next: nextDetail([
        {
          why: 'Remove the run whose record is damaged; its worktree caches and pinned refs stay.',
          argv,
        },
      ]),
    },
    { cause: damaged.cause ?? damaged },
  );
}

/** With `--unreadable`, a `run.unreadable` failure that is not damaged content says why it stays. */
function notDamagedError(error: unknown): unknown {
  if (!(error instanceof RunRefusedError) || error.code !== 'run.unreadable') return error;
  const code = detailsObject(error.details)['filesystemCode'];
  return new RunRefusedError(
    'run.unreadable',
    error.runId,
    `${error.message} rm --unreadable removes only a record whose content is damaged, not one that cannot be read${typeof code === 'string' ? ` (${code})` : ''}; nothing was removed.`,
    error.details,
    { cause: error.cause ?? error },
  );
}

/** The warning of every unreadable removal: the record that named caches and refs is unread. */
function unreadableWarning(runId: string): string {
  return `The record of ${runId} could not be read, so rm removed none of the worktree caches or pinned refs it may name. Find leftover caches with git worktree list in the run's repository (git worktree prune drops their entries once deleted) and pinned refs with git for-each-ref refs/quiet-choir/${runId}/.`;
}

/** Whether any launch may still be in flight; null (the directory changed under the scan) counts. */
function launchInFlight(launches: readonly LeftoverLaunch[] | null): boolean {
  return launches === null || launches.some((launch) => launch.state === 'in-flight');
}

/** Refuse `run.active`, even with `--force`, while a launch in `<runId>/launch/` may be in flight. */
async function refuseInFlightLaunches(
  stateDir: string,
  runId: string,
  live: RemoveRunLive,
): Promise<void> {
  const launches = await inspectRunLaunches(stateDir, runId, live.launchSettle);
  if (launchInFlight(launches))
    throw inFlightRefusal(runId, launches ?? [], inFlightUnreadableMessage(runId, launches ?? []));
}

/** The dry run of an unreadable removal: what {@link removeUnreadable} would meet now. */
async function planUnreadableRemoval(
  stateDir: string,
  options: RemoveRunOptions,
  live: RemoveRunLive,
): Promise<RunRemovalResult> {
  const { runId } = options;
  const hold = ownershipHold(await inspectRunOwnership({ runId, stateDir }));
  const launches = hold ? [] : await inspectRunLaunches(stateDir, runId, live.launchSettle);
  return {
    runId,
    stateDir,
    dryRun: true,
    force: options.force ?? false,
    refs: options.refs ?? false,
    verdict: hold
      ? pick(removalRefusal(runId, stateDir, hold, live.commandLauncher))
      : launchInFlight(launches)
        ? { code: 'run.active', message: inFlightUnreadableMessage(runId, launches ?? []) }
        : 'remove',
    removed: false,
    launchOnly: false,
    unreadable: true,
    interrupted: false,
    paths: await existingPaths(stateDir, runId),
    caches: [],
    refsRemoved: [],
    keptRefs: [],
    bytes: await runBytes(stateDir, runId),
    tombstones: await deadTombstones(stateDir),
    warnings: [unreadableWarning(runId)],
  };
}

/**
 * Remove a run whose record content is damaged, on request (`unreadable`, ADR 0060). It refuses a
 * held lock or live orphans, and `run.active`, even with `force`, while a launch in `launch/` may
 * be in flight. It takes the run lock as ordinary rm does (recovering a dead owner's), reads the
 * record again under it, which no writer can change meanwhile (`run.exists` when it is readable
 * now, `run.not_found` when it is gone), judges the launches again and then follows the ordinary
 * guard-held deletion order. No caches or refs are touched, since the ledger cannot be read.
 */
async function removeUnreadable(
  stateDir: string,
  options: RemoveRunOptions,
  live: RemoveRunLive,
  tombstones: readonly string[],
): Promise<RunRemovalOutcome> {
  const { runId } = options;
  const hold = ownershipHold(await inspectRunOwnership({ runId, stateDir }));
  if (hold) throw refusalError(runId, stateDir, hold, live.commandLauncher);
  await refuseInFlightLaunches(stateDir, runId, live);
  // Measured before the lock exists, so a real removal reports what its dry run reports.
  const paths = await existingPaths(stateDir, runId);
  const bytes = await runBytes(stateDir, runId);
  live.signal?.throwIfAborted();
  await live.beforeLock?.();
  return withOwnedRun(stateDir, runId, live, async (owned) => {
    await confirmDamaged(stateDir, runId);
    await refuseInFlightLaunches(stateDir, runId, live);
    await deleteRunFiles(owned, stateDir, runId, live);
    return {
      kind: 'removed',
      result: {
        runId,
        stateDir,
        dryRun: false,
        force: options.force ?? false,
        refs: options.refs ?? false,
        verdict: 'remove',
        removed: true,
        launchOnly: false,
        unreadable: true,
        interrupted: false,
        paths,
        caches: [],
        refsRemoved: [],
        keptRefs: [],
        bytes,
        tombstones,
        warnings: [unreadableWarning(runId)],
      },
    };
  });
}

/** Under the run lock: the record must still be damaged, by the same rule as before the lock. */
async function confirmDamaged(stateDir: string, runId: string): Promise<void> {
  let record: RunRecord;
  try {
    record = await readRequiredRun({ runId, stateDir });
  } catch (error) {
    if (await damagedRecordFailure(stateDir, runId, error)) return;
    throw error;
  }
  throw new RunRefusedError(
    'run.exists',
    runId,
    `Run ${runId} became readable after rm inspected it; nothing was removed. Rerun rm to judge the run.`,
    jsonValue({ status: record.status, createdAt: record.createdAt }),
  );
}

/** The dry run of an interrupted removal: what {@link finishInterruptedRemoval} would meet now. */
async function planInterruptedRemoval(
  options: RemoveRunOptions,
  removal: InterruptedRemoval,
  launcher?: CommandLauncher,
): Promise<RunRemovalResult> {
  const { runId, stateDir } = removal;
  const hold = ownershipHold(await inspectRunOwnership({ runId, stateDir }));
  return {
    runId,
    stateDir,
    dryRun: true,
    force: options.force ?? false,
    refs: options.refs ?? false,
    verdict: hold ? pick(removalRefusal(runId, stateDir, hold, launcher)) : 'remove',
    removed: false,
    launchOnly: false,
    unreadable: false,
    interrupted: true,
    paths: removal.paths,
    caches: [],
    refsRemoved: [],
    keptRefs: [],
    bytes: removal.bytes,
    tombstones: await deadTombstones(stateDir),
    warnings: [],
  };
}

/**
 * Finish what a removal of an unmigrated flat run left after its commit point (ADR 0061): a
 * record-less `<runId>/` holding only its primary lock, and any `.json.v<N>` backups and legacy
 * guard. It refuses `run.locked` or `run.orphans` while ownership holds the ID (a live, unknown,
 * remote or unreadable owner or recoverer, or a dead owner's live child), even with `force`, then
 * takes the run lock without a working directory (recovering a dead owner's, as ADR 0030 allows),
 * re-checks under it that no record exists (`run.exists`) and that the shape still matches
 * (`run.not_found`), and runs the ordinary guard-held deletion order again. No caches or refs are
 * left to touch: a removal deletes them before its commit point. `workflow prune` calls it for each
 * leftover its container scan finds, never `removeRun`, so an ID that became a run after the scan
 * is refused rather than removed. @internal
 */
export async function finishInterruptedRemoval(
  removal: InterruptedRemoval,
  live: RemoveRunLive,
  context: {
    readonly force: boolean;
    readonly refs: boolean;
    readonly tombstones: readonly string[];
  },
): Promise<RunRemovalOutcome> {
  const { runId, stateDir } = removal;
  const hold = ownershipHold(await inspectRunOwnership({ runId, stateDir }));
  if (hold) throw refusalError(runId, stateDir, hold, live.commandLauncher);
  live.signal?.throwIfAborted();
  await live.beforeLock?.();
  return withOwnedRun(stateDir, runId, live, async (owned) => {
    if ((await inspectInterruptedRemoval(stateDir, runId)) === null) {
      if (await runRecordPresent(stateDir, runId))
        throw new RunRefusedError(
          'run.exists',
          runId,
          `A run now holds ID ${runId}, so the interrupted removal was not finished; nothing was removed. Rerun rm to judge the run.`,
          jsonValue({ stateDir }),
        );
      throw await missingRunError({ runId, stateDir });
    }
    await deleteRunFiles(owned, stateDir, runId, live);
    return {
      kind: 'removed',
      result: {
        runId,
        stateDir,
        dryRun: false,
        force: context.force,
        refs: context.refs,
        verdict: 'remove',
        removed: true,
        launchOnly: false,
        unreadable: false,
        interrupted: true,
        paths: removal.paths,
        caches: [],
        refsRemoved: [],
        keptRefs: [],
        bytes: removal.bytes,
        tombstones: context.tombstones,
        warnings: [],
      },
    };
  });
}

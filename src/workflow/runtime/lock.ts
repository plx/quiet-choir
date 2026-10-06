import { createStorageDirectory, syncDirectory, syncHandle } from './storage-io.js';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { HarnessInvocation, HarnessProcess } from './model.js';
import { pidState, processIdentity } from '../../processes/identity.js';
import { ProcessSupervisor } from '../../processes/supervisor.js';
import {
  inspectProcesses,
  recoverProcesses,
  trackProcess,
  OrphanProcessesError,
  type HarnessProcessInspection,
} from './process-registry.js';
import { RunRefusedError } from './run-errors.js';
import {
  formatArgv,
  nextDetail,
  unlockNext,
  type CommandLauncher,
  type NextCommand,
} from './commands.js';
import { decideUnlock, type UnlockHolder, type UnlockObservation } from './recovery-decision.js';
import {
  resolveStateDir,
  runLockPath,
  runDirectory,
  legacyRunPath,
  prepareStateDirectory,
} from './paths.js';
import type { ReadRunOptions } from './store.js';

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string(),
  osStartTime: z.string().nullable().optional(),
  released: z.boolean().optional(),
});

/** A recoverer's claim inside a lock; published whole by link(), so a visible one is complete. */
const markerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string(),
  osStartTime: z.string().nullable().optional(),
});

/** A lock owner's `owner.json`. Shared with the worktree administration lock. @internal */
export type Owner = z.infer<typeof ownerSchema>;
/** A recoverer's `recovery.json`. Shared with the worktree administration lock. @internal */
export type Marker = z.infer<typeof markerSchema>;
type Liveness = 'alive' | 'dead' | 'unknown' | 'remote';

interface RecordedIdentity {
  readonly pid: number;
  readonly host: string;
  readonly osStartTime?: string | null | undefined;
}

/** Local liveness of the process that wrote an owner or recovery record. @internal */
export function liveness(identity: RecordedIdentity): Liveness {
  if (identity.host !== hostname()) return 'remote';
  return localLiveness(identity);
}

/**
 * Judge a recorded PID and birth identity on this machine, whatever host the record names. Only an
 * operator's assertion that the recorded host is this machine or gone makes this meaningful for a
 * foreign record.
 */
function localLiveness(identity: RecordedIdentity): Exclude<Liveness, 'remote'> {
  const state = pidState(identity.pid);
  if (state !== 'alive') return state;
  const current = processIdentity(identity.pid);
  if (
    current?.zombie ||
    (identity.osStartTime && current?.start && identity.osStartTime !== current.start)
  )
    return 'dead';
  return 'alive';
}

/** An owner's liveness, or `released` when it handed its lock to recovery. @internal */
export function ownerState(owner: Owner): Liveness | 'released' {
  if (owner.host !== hostname()) return 'remote';
  if (owner.released) return 'released';
  return liveness(owner);
}

const strayPattern = /^(\d+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(tmp|gone)$/u;

/** A sibling of the lock directory owned by this process: a publish tmp or a release tombstone. */
function siblingPath(lockPath: string, kind: 'tmp' | 'gone'): string {
  return `${lockPath}.${String(process.pid)}.${randomUUID()}.${kind}`;
}

/** Parse `<lock>.<pid>.<uuid>.(tmp|gone)` for the named lock only. */
function parseStray(
  lockName: string,
  entry: string,
): { readonly pid: number; readonly kind: 'tmp' | 'gone' } | undefined {
  if (!entry.startsWith(`${lockName}.`)) return undefined;
  const match = strayPattern.exec(entry.slice(lockName.length + 1));
  if (!match?.[1] || !match[2]) return undefined;
  return { pid: Number(match[1]), kind: match[2] === 'gone' ? 'gone' : 'tmp' };
}

/** Parse a lock's `owner.json`; errors keep their errno. @internal */
export async function readOwner(lockPath: string): Promise<Owner> {
  return ownerSchema.parse(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')));
}

/**
 * Read the owner of a lock that another process may be retiring. A lock retired between two looks
 * may already be gone, or replaced by a complete new one, so a missing `owner.json` in a present
 * lock is judged only after repeated looks; `gone` means no lock is there now. @internal
 */
export async function readContended(lockPath: string): Promise<Owner | 'gone'> {
  let missing: unknown;
  for (let look = 0; look < 3; look++) {
    try {
      return await readOwner(lockPath);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      if (await lockGone(lockPath)) return 'gone';
      missing ??= error;
    }
  }
  throw missing;
}

/** Parse a `recovery.json` marker; errors keep their errno. @internal */
export async function readMarker(path: string): Promise<Marker> {
  return markerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** One lock directory as inspection sees it. */
export interface RunLockView {
  /** `primary` is `<runId>/lock`; `guard` is the legacy `<runId>.json.lock` every writer also holds. */
  readonly kind: 'primary' | 'guard';
  /** Absolute lock directory path. */
  readonly path: string;
  /** Owner metadata and liveness, or null when `owner.json` is missing or unreadable. */
  readonly owner: {
    /** Writer's recorded process ID. */
    readonly pid: number;
    /** Host on which the writer acquired ownership. */
    readonly host: string;
    /** Current local liveness or a state that prevents ordinary automatic reclamation. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote' | 'released';
    /**
     * The owner's recorded OS birth identity (compared with the live process to detect PID reuse),
     * or null when the writer did not record one.
     */
    readonly osStartTime: string | null;
  } | null;
  /**
   * The recovery marker (`recovery.json`) of a process reclaiming this lock, or null. A dead
   * recoverer's marker is reclaimed by the next acquire; any other state holds the lock.
   */
  readonly recovery: {
    /** Recoverer's process ID. */
    readonly pid: number;
    /** Host on which the recoverer runs. */
    readonly host: string;
    /** Current local liveness of the recoverer. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote';
  } | null;
  /** Set only when `owner.json` or `recovery.json` exists but cannot be read or parsed. */
  readonly warning?: string;
}

/** Ephemeral ownership diagnostics; never included in replay identity or the saved checkpoint. */
export interface RunOwnership {
  /** Whether a lock currently exists. */
  readonly locked: boolean;
  /**
   * Local owner metadata and liveness of the lock that ownership resolves to (the primary lock, or
   * the legacy guard when only it exists), or null for an absent/incomplete lock.
   */
  readonly owner: {
    /** Writer's recorded process ID. */
    readonly pid: number;
    /** Host on which the writer acquired ownership. */
    readonly host: string;
    /** Current local liveness or a state that prevents ordinary automatic reclamation. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote' | 'released';
    /**
     * The owner's recorded OS birth identity (compared with the live process to detect PID reuse),
     * or null when the writer did not record one.
     */
    readonly osStartTime: string | null;
  } | null;
  /** Child/group records, including unverifiable entries. */
  readonly processes: readonly HarnessProcessInspection[];
  /** Read-only inspection failures; never permission to remove the lock. */
  readonly warning?: string;
  /**
   * Every existing lock directory of the run, primary first, then the legacy guard, each with its
   * owner and any recovery marker. Empty when the run is not locked.
   */
  readonly locks: readonly RunLockView[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one lock directory, or undefined when it does not exist. */
async function inspectLock(
  kind: RunLockView['kind'],
  path: string,
): Promise<RunLockView | undefined> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    return { kind, path, owner: null, recovery: null, warning: message(error) };
  }
  const warnings: string[] = [];
  let owner: RunLockView['owner'] = null;
  let recovery: RunLockView['recovery'] = null;
  if (names.includes('owner.json'))
    try {
      const value = await readContended(path);
      // Retired between the listing and the read: there is no lock to report.
      if (value === 'gone') return undefined;
      owner = {
        pid: value.pid,
        host: value.host,
        state: ownerState(value),
        osStartTime: value.osStartTime ?? null,
      };
    } catch (error) {
      warnings.push(`owner.json: ${message(error)}`);
    }
  if (names.includes('recovery.json'))
    try {
      const value = await readMarker(join(path, 'recovery.json'));
      recovery = { pid: value.pid, host: value.host, state: liveness(value) };
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) warnings.push(`recovery.json: ${message(error)}`);
    }
  return {
    kind,
    path,
    owner,
    recovery,
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}

/** Read owner and child liveness without importing workflow code or changing any files. */
export async function inspectRunOwnership(options: ReadRunOptions): Promise<RunOwnership> {
  const stateDir = resolveStateDir(options);
  const lockPath = runLockPath(stateDir, options.runId);
  const locks = (
    await Promise.all([
      inspectLock('primary', join(runDirectory(stateDir, options.runId), 'lock')),
      inspectLock('guard', `${legacyRunPath(stateDir, options.runId)}.lock`),
    ])
  ).filter((lock) => lock !== undefined);
  try {
    const owner = await readOwner(lockPath);
    const state = ownerState(owner);
    const processes = await inspectProcesses(lockPath, options.runId, owner.token);
    return {
      locked: true,
      owner: { pid: owner.pid, host: owner.host, state, osStartTime: owner.osStartTime ?? null },
      processes:
        state === 'remote'
          ? processes.map((entry) => ({
              ...entry,
              state: 'unknown',
              detail: 'Remote owner: local PID observations cannot identify its children.',
            }))
          : processes,
      locks,
    };
  } catch (error) {
    try {
      await readdir(lockPath);
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
        return { locked: false, owner: null, processes: [], locks };
    }
    return {
      locked: true,
      owner: null,
      processes: [],
      warning: error instanceof Error ? error.message : String(error),
      locks,
    };
  }
}

export interface RunLock {
  (): Promise<void>;
  trackProcess(
    invocation: Pick<HarnessInvocation, 'runId' | 'stepId' | 'attempt'>,
    process: HarnessProcess,
  ): ReturnType<HarnessInvocation['trackProcess']>;
}

/**
 * The handle `lockRun` returns: the run lock plus a primary-only release. `workflow rm` uses it to
 * give up the primary lock while it keeps the legacy guard, which every writer takes first. @internal
 */
export interface OwnedRunLock extends RunLock {
  /**
   * Release only the primary lock, with the usual token and live-child checks (a live or unknown
   * child marks the owner released and throws `OrphanProcessesError`). It runs at most once; the
   * full release then releases only the guard.
   */
  releaseOwner(): Promise<void>;
}

/** Why a plain unlock entry accompanies a refusal for a race that a retry usually clears. */
const transientWhy =
  'If a retry is refused again, unlock reports who holds the lock and clears it only once no process owns it; it never removes a live lock or signals.';

/** Live local owner/recovery configuration. @internal */
export interface RunLockOptions {
  readonly killOrphans?: boolean;
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly processSupervisor?: ProcessSupervisor;
  readonly probeOwner?: boolean;
  readonly cwd?: string;
  /**
   * The program words behind the `workflow unlock` command that a `run.locked` refusal names in its
   * message and `details.next`. Only shapes that text; absent means `['quiet-choir']`.
   */
  readonly commandLauncher?: CommandLauncher | undefined;
}

/** Whether `error` is a Node system error with this errno code. @internal */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Whether no lock directory exists at `lockPath` now. @internal */
export async function lockGone(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return false;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

/**
 * Run `fn` while holding only the legacy guard `<runId>.json.lock`, then release it on every path.
 * Every writer and `workflow rm` take the guard first, and rm holds it until the run is gone, so a
 * caller that must not interleave with them (start's existence check and launch-file allocation)
 * runs under it. A held guard refuses with `run.locked`, as for any writer. @internal
 */
export async function withRunGuard<T>(
  stateDir: string,
  runId: string,
  fn: () => Promise<T>,
  options: RunLockOptions = {},
): Promise<T> {
  const release = await acquireLock(
    stateDir,
    runId,
    `${legacyRunPath(stateDir, runId)}.lock`,
    options,
  );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Could not release the legacy guard.', {
        cause: releaseError,
      });
    }
    throw error;
  }
  await release();
  return result;
}

/**
 * Acquire both the legacy guard and current ownership, always in the same order, for every run —
 * migrated or not — so a pre-format-7 binary starting the same run ID in the same explicit state
 * container is excluded even when no legacy record exists yet. @internal
 */
export async function lockRun(
  stateDir: string,
  runId: string,
  options: RunLockOptions = {},
): Promise<OwnedRunLock> {
  const legacy = legacyRunPath(stateDir, runId);
  const primary = join(runDirectory(stateDir, runId), 'lock');
  const guard = await acquireLock(stateDir, runId, `${legacy}.lock`, options);
  let owner: RunLock;
  try {
    owner = await acquireLock(stateDir, runId, primary, options);
  } catch (error) {
    try {
      await guard();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Could not acquire current ownership or release the legacy guard.',
        { cause: releaseError },
      );
    }
    throw error;
  }
  // Set once the primary's release has been attempted; the full release then skips it.
  let ownerRelease: Promise<void> | undefined;
  const releaseOwner = (): Promise<void> => (ownerRelease ??= owner());
  const release = async (): Promise<void> => {
    const errors: unknown[] = [];
    if (ownerRelease === undefined)
      try {
        await releaseOwner();
      } catch (error) {
        errors.push(error);
      }
    try {
      await guard();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    // Both locks vanished (or both failed removal after verified ownership): keep the shared errno
    // so callers treat it like the single-lock case. Mixed or unverified failures stay aggregate.
    if (
      errors.length > 1 &&
      ['ENOENT', 'EACCES'].some((code) => errors.every((error) => isErrno(error, code)))
    )
      throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Could not release current and legacy ownership.', {
        cause: errors[0],
      });
  };
  return Object.assign(release, { trackProcess: owner.trackProcess.bind(owner), releaseOwner });
}

/**
 * Publish a complete lock in one rename: a private sibling directory already holding a durable
 * `owner.json` replaces an absent (or empty, older-build) lock path. `contended` means another
 * lock is there; the tmp directory never outlives this call unless it became the lock. @internal
 */
export async function publishLock(
  lockPath: string,
  owner: Owner,
): Promise<'published' | 'contended'> {
  const temporary = siblingPath(lockPath, 'tmp');
  let published = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    {
      await using file = await open(join(temporary, 'owner.json'), 'wx', 0o600);
      await file.writeFile(JSON.stringify(owner));
      await syncHandle(file);
    }
    await syncDirectory(temporary);
    await syncDirectory(dirname(lockPath));
    try {
      await rename(temporary, lockPath);
    } catch (error) {
      if (isErrno(error, 'ENOTEMPTY') || isErrno(error, 'EEXIST')) return 'contended';
      // Windows refuses to rename onto any existing directory.
      if (isErrno(error, 'EPERM') && !(await lockGone(lockPath))) return 'contended';
      throw error;
    }
    published = true;
    return 'published';
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Whether a tombstone file carries the expected token. A string must match; null expects no readable
 * file (missing or unparseable); undefined is not checked. A missing file always matches: only a
 * sweep removes files from a tombstone, so a new owner is already deleting this one, which was
 * verified before the rename. Anything else unreadable is not the file that was verified.
 */
async function carries(
  read: () => Promise<{ readonly token: string }>,
  expected: string | null | undefined,
): Promise<boolean> {
  if (expected === undefined) return true;
  try {
    return (await read()).token === expected;
  } catch (error) {
    return expected === null || isErrno(error, 'ENOENT');
  }
}

/**
 * Move a verified lock out of the way in one rename, check that the tombstone is the lock that was
 * verified, then delete it. A mismatch renames it back and throws `mismatch()`; a tombstone that a
 * new owner is already sweeping counts as retired. The rename and removal keep their errno. @internal
 */
export async function retire(
  lockPath: string,
  expected: { readonly owner: string | null; readonly recovery?: string | null },
  mismatch: () => Error,
): Promise<void> {
  const tombstone = siblingPath(lockPath, 'gone');
  await rename(lockPath, tombstone);
  await syncDirectory(dirname(lockPath));
  const matches =
    (await carries(() => readOwner(tombstone), expected.owner)) &&
    (await carries(() => readMarker(join(tombstone, 'recovery.json')), expected.recovery));
  if (!matches) {
    await rename(tombstone, lockPath).catch(() => undefined);
    throw mismatch();
  }
  await rm(tombstone, { recursive: true, force: true });
}

/** Best effort: remove this lock's stray tombstones and dead creators' publish directories. @internal */
export async function sweepStrays(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  const name = basename(lockPath);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const stray = parseStray(name, entry);
    if (!stray || (stray.kind === 'tmp' && pidState(stray.pid) !== 'dead')) continue;
    // A stray is harmless; one that cannot be removed must never block ownership.
    await rm(join(directory, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Publish `marker` as `<lock>/recovery.json` by linking a durable temporary file, so a visible
 * marker is always complete. `exists` is contention; `gone` means the lock itself vanished.
 */
async function publishMarker(
  lockPath: string,
  marker: Marker,
): Promise<'published' | 'exists' | 'gone'> {
  const temporary = join(lockPath, `recovery.${randomUUID()}.tmp`);
  try {
    try {
      await using file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(marker));
      await syncHandle(file);
      await link(temporary, join(lockPath, 'recovery.json'));
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return 'exists';
      if (isErrno(error, 'ENOENT')) return 'gone';
      throw error;
    }
    await syncDirectory(lockPath);
    return 'published';
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Take `recovery.json` aside and keep it only if it still carries `token` (null: only while it is
 * still unreadable, since a marker is published whole and a readable one is a new claim); otherwise
 * put it back (leaving it aside if a new marker appeared meanwhile). `missing` means there was none
 * to take. @internal
 */
export async function takeMarker(
  lockPath: string,
  token: string | null,
): Promise<'taken' | 'kept' | 'missing'> {
  const current = join(lockPath, 'recovery.json');
  const aside = join(lockPath, `recovery.${randomUUID()}.stale`);
  try {
    await rename(current, aside);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing';
    throw error;
  }
  let taken: Marker | undefined;
  try {
    taken = await readMarker(aside);
  } catch {
    taken = undefined;
  }
  if (token === null ? taken === undefined : taken?.token === token) {
    await rm(aside, { force: true });
    return 'taken';
  }
  try {
    await link(aside, current);
    await rm(aside, { force: true });
  } catch (error) {
    // A newer marker won the name; the displaced one stays aside and leaves with the lock.
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  return 'kept';
}

/**
 * Win the right to recover a dead or released lock: publish our marker, or reclaim a dead
 * recoverer's marker. Refuses with `inProgress(existing, cause)` while a live, unknown, remote or
 * unreadable (`existing` undefined) marker holds it; `retry` means the lock or marker changed
 * underneath and the acquire loop should look again. @internal
 */
export async function claimRecovery(
  lockPath: string,
  marker: Marker,
  changed: () => Error,
  inProgress: (existing: Marker | undefined, cause?: unknown) => Error,
): Promise<'claimed' | 'retry'> {
  const published = await publishMarker(lockPath, marker);
  if (published === 'published') return 'claimed';
  if (published === 'gone') return 'retry';
  let existing: Marker;
  try {
    existing = await readMarker(join(lockPath, 'recovery.json'));
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return 'retry';
    throw inProgress(undefined, cause);
  }
  if (liveness(existing) !== 'dead') throw inProgress(existing);
  // Reclaim only the marker that was judged dead, never one that replaced it meanwhile.
  const taken = await takeMarker(lockPath, existing.token);
  if (taken === 'missing') return 'retry';
  if (taken === 'kept') throw changed();
  const republished = await publishMarker(lockPath, marker);
  if (republished === 'published') return 'claimed';
  if (republished === 'gone') return 'retry';
  throw changed();
}

async function acquireLock(
  stateDir: string,
  runId: string,
  lockPath: string,
  options: RunLockOptions,
): Promise<RunLock> {
  await prepareStateDirectory(resolve(stateDir), options.cwd);
  await createStorageDirectory(dirname(lockPath));
  const owner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    osStartTime:
      options.probeOwner === false ? null : (processIdentity(process.pid)?.start ?? null),
  };
  const supervisor = options.processSupervisor ?? new ProcessSupervisor();
  const unlock = (why: string, forceRemote = false): NextCommand =>
    unlockNext(options.commandLauncher, stateDir, runId, { why, forceRemote });
  const transient = unlock(transientWhy);
  const changed = (cause?: unknown): RunRefusedError =>
    new RunRefusedError(
      'run.locked',
      runId,
      `Run ${runId} lock ownership changed during recovery; retry.`,
      { lockPath, next: nextDetail([transient]) },
      cause === undefined ? undefined : { cause },
    );
  const lost = (): Error => new Error(`Run ${runId} lock ownership was lost.`);
  const inProgress = (existing: Marker | undefined, cause?: unknown): RunRefusedError => {
    const remote = existing !== undefined && existing.host !== hostname();
    const entry = unlock(
      existing === undefined
        ? 'Clear the damaged recovery marker after confirming no process owns the lock.'
        : remote
          ? `Only if ${existing.host} is this machine under an old name or is permanently gone.`
          : `Rerun once recoverer PID ${String(existing.pid)} on ${existing.host} has exited.`,
      remote,
    );
    const command = formatArgv(entry.argv);
    return new RunRefusedError(
      'run.locked',
      runId,
      `Run ${runId} lock recovery is in progress; retry, or ${
        existing === undefined
          ? `clear the damaged marker in ${lockPath} with ${command}`
          : remote
            ? `once recoverer PID ${String(existing.pid)} on ${existing.host} is gone, clear it with ${command} (only if ${existing.host} is this machine under an old name or is permanently gone)`
            : `once recoverer PID ${String(existing.pid)} on ${existing.host} is gone, clear it with ${command}`
      }.`,
      existing === undefined
        ? { lockPath, next: nextDetail([entry]) }
        : { lockPath, pid: existing.pid, host: existing.host, next: nextDetail([entry]) },
      cause === undefined ? undefined : { cause },
    );
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await publishLock(lockPath, owner)) === 'contended') {
      let previous;
      try {
        previous = await readContended(lockPath);
      } catch (cause) {
        const entry = unlock('Clear the lock after confirming no process owns it.');
        throw new RunRefusedError(
          'run.locked',
          runId,
          `Run ${runId} is locked with incomplete ownership metadata (damage or an older build); after confirming no process owns ${lockPath}, clear it with ${formatArgv(entry.argv)}.`,
          { lockPath, next: nextDetail([entry]) },
          { cause },
        );
      }
      // Released between the failed publish and this read: look again.
      if (previous === 'gone') continue;
      const previousState = ownerState(previous);
      if (previousState !== 'dead' && previousState !== 'released') {
        const remote = previousState === 'remote';
        const entry = unlock(
          remote
            ? `Only if ${previous.host} is this machine under an old name or is permanently gone.`
            : `Works only once PID ${String(previous.pid)} on ${previous.host} has exited.`,
          remote,
        );
        const command = formatArgv(entry.argv);
        throw new RunRefusedError(
          'run.locked',
          runId,
          `Run ${runId} is locked by PID ${String(previous.pid)} on ${previous.host}. ${
            remote
              ? `If ${previous.host} is this machine under an old name or is permanently gone, clear it with ${command}.`
              : `Wait for it or stop it; ${command} clears the lock only once that owner is gone.`
          }`,
          { pid: previous.pid, host: previous.host, lockPath, next: nextDetail([entry]) },
        );
      }
      // Only one contender may retire a dead owner's lock. Recheck ownership after winning recovery.
      const marker = {
        pid: owner.pid,
        host: owner.host,
        osStartTime: owner.osStartTime,
        token: randomUUID(),
      };
      if ((await claimRecovery(lockPath, marker, changed, inProgress)) === 'retry') continue;
      let retired = false;
      try {
        const current = await readOwner(lockPath);
        if (current.token !== previous.token || !['dead', 'released'].includes(ownerState(current)))
          throw changed();
        await recoverProcesses(lockPath, runId, current.token, {
          killGraceMs: options.killGraceMs ?? 3000,
          processSupervisor: supervisor,
          ...(options.killOrphans === undefined ? {} : { killOrphans: options.killOrphans }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // A reclaimer that judged this recoverer dead may have taken the marker meanwhile.
        let mine;
        try {
          mine = await readMarker(join(lockPath, 'recovery.json'));
        } catch (cause) {
          throw changed(cause);
        }
        if (mine.token !== marker.token) throw changed();
        await retire(lockPath, { owner: current.token, recovery: marker.token }, changed);
        retired = true;
      } finally {
        if (!retired) await takeMarker(lockPath, marker.token).catch(() => undefined);
      }
      continue;
    }
    try {
      await syncDirectory(dirname(lockPath));
      // Only this run's lock owner can remove abandoned atomic-write files.
      for (const [directory, prefix] of (
        [
          [resolve(stateDir), `${runId}.json.`],
          [dirname(lockPath), 'run.json.'],
        ] as const
      ).filter((entry, index) => index === 0 || entry[0] !== resolve(stateDir))) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            entry.name.startsWith(prefix) &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(
              entry.name.slice(prefix.length),
            )
          )
            await rm(join(directory, entry.name), { force: true });
        }
      }
    } catch (error) {
      await retire(lockPath, { owner: owner.token }, lost).catch(() => undefined);
      throw error;
    }
    await sweepStrays(lockPath);
    const release = async (): Promise<void> => {
      let current;
      try {
        current = await readOwner(lockPath);
      } catch (cause) {
        // A vanished lock keeps its errno; missing or unreadable metadata in a present lock does not,
        // so callers cannot mistake unverified ownership for a cleanup-only failure.
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) throw cause;
        throw new Error(`Run ${runId} lock ownership could not be verified; inspect ${lockPath}.`, {
          cause,
        });
      }
      if (current.token !== owner.token) throw lost();
      const processes = await inspectProcesses(lockPath, runId, owner.token);
      if (processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown')) {
        // The workflow no longer owns work, but its child records must survive even in a long-lived embedder.
        const temp = join(lockPath, `owner.${randomUUID()}.tmp`);
        await using file = await open(temp, 'wx', 0o600);
        await file.writeFile(JSON.stringify({ ...owner, released: true }));
        await syncHandle(file);
        await rename(temp, join(lockPath, 'owner.json'));
        throw new OrphanProcessesError(runId, processes);
      }
      await retire(lockPath, { owner: owner.token }, lost);
    };
    return Object.assign(release, {
      trackProcess: (
        invocation: Pick<HarnessInvocation, 'runId' | 'stepId' | 'attempt'>,
        child: HarnessProcess,
      ) => trackProcess(lockPath, owner.token, supervisor, invocation, child),
    });
  }
  throw new RunRefusedError(
    'run.locked',
    runId,
    `Could not acquire run ${runId}; retry after competing writers finish.`,
    { lockPath, next: nextDetail([transient]) },
  );
}

function unlockHolder(
  identity: Marker,
): UnlockHolder & { readonly state: Exclude<Liveness, 'remote'> } {
  return {
    pid: identity.pid,
    host: identity.host,
    token: identity.token,
    remote: identity.host !== hostname(),
    state: localLiveness(identity),
  };
}

/**
 * Observe one lock directory for unlock, or undefined when it does not exist. A null `runId` (the
 * worktree administration lock, which records no children) observes no child records. @internal
 */
export async function observeUnlock<Kind extends UnlockObservation['kind']>(
  kind: Kind,
  path: string,
  runId: string | null,
): Promise<(UnlockObservation & { readonly kind: Kind }) | undefined> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const warnings: string[] = [];
  let owner: UnlockHolder | null = null;
  if (names.includes('owner.json'))
    try {
      const value = await readContended(path);
      // Retired between the listing and the read: there is no lock to unlock.
      if (value === 'gone') return undefined;
      owner = value.released ? { ...unlockHolder(value), state: 'released' } : unlockHolder(value);
    } catch (error) {
      warnings.push(`owner.json: ${message(error)}`);
    }
  else warnings.push("owner.json: missing (an older build's interrupted acquire, or damage)");
  let recovery: UnlockObservation['recovery'] = null;
  if (names.includes('recovery.json'))
    try {
      recovery = unlockHolder(await readMarker(join(path, 'recovery.json')));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        recovery = 'unreadable';
        warnings.push(`recovery.json: ${message(error)}`);
      }
    }
  return {
    kind,
    path,
    owner,
    recovery,
    processes: runId === null ? [] : await inspectProcesses(path, runId, owner?.token ?? null),
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}

/** The owner token a lock carries now (null for none readable), or undefined when it is gone. */
async function ownerToken(path: string): Promise<string | null | undefined> {
  try {
    const value = await readContended(path);
    return value === 'gone' ? undefined : value.token;
  } catch {
    return (await lockGone(path)) ? undefined : null;
  }
}

/**
 * Remove one lock that unlock observed and judged removable, as its single recoverer. The observed
 * marker (dead, unreadable, or a foreign one `--force-remote` judged) is taken aside only while it
 * is still that marker, then unlock claims recovery through `claimRecovery` like an automatic
 * recoverer, so no recoverer can retire and replace the lock under it: a live marker refuses with
 * `changed()`. Holding the claim, it re-reads the owner and its own marker, requires the observed
 * owner token (or still no readable owner), and retires the lock through the tombstone rename,
 * which checks both once more. Any difference throws `changed()` and leaves the lock in place,
 * without unlock's marker. `absent` means the lock vanished first. Nothing is signaled. @internal
 */
export async function removeObservedLock(
  lock: UnlockObservation,
  changed: () => Error,
): Promise<'removed' | 'absent'> {
  const { path } = lock;
  const expected = lock.owner?.token ?? null;
  const vanished = async (): Promise<'absent'> => {
    if (await lockGone(path)) return 'absent';
    throw changed();
  };
  // A lock that already changed is refused before unlock touches it.
  const before = await ownerToken(path);
  if (before === undefined) return 'absent';
  if (before !== expected) throw changed();
  if (lock.recovery !== null) {
    const observed = lock.recovery === 'unreadable' ? null : lock.recovery.token;
    if ((await takeMarker(path, observed)) === 'kept') throw changed();
  }
  const marker: Marker = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    osStartTime: processIdentity(process.pid)?.start ?? null,
  };
  if ((await claimRecovery(path, marker, changed, () => changed())) === 'retry') return vanished();
  let retired = false;
  try {
    const owner = await ownerToken(path);
    if (owner === undefined) return 'absent';
    if (owner !== expected) throw changed();
    // A reclaimer that judged unlock dead may have taken the marker meanwhile.
    let mine: Marker;
    try {
      mine = await readMarker(join(path, 'recovery.json'));
    } catch {
      throw changed();
    }
    if (mine.token !== marker.token) throw changed();
    try {
      await retire(path, { owner, recovery: marker.token }, changed);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      return 'absent';
    }
    retired = true;
    return 'removed';
  } finally {
    if (!retired) await takeMarker(path, marker.token).catch(() => undefined);
  }
}

/** One lock that `workflow unlock` found, with the local judgments it acted on. @internal */
export interface UnlockedLock {
  /** `primary` is `<runId>/lock`; `guard` is the legacy `<runId>.json.lock`. */
  readonly kind: 'primary' | 'guard';
  /** Absolute lock directory path. */
  readonly path: string;
  /** Owner with its local liveness, or null when `owner.json` was missing or unreadable. */
  readonly owner: {
    readonly pid: number;
    readonly host: string;
    readonly state: 'alive' | 'dead' | 'unknown' | 'released';
  } | null;
  /** A (dead) recoverer's marker, or null when there was none or it was unreadable. */
  readonly recovery: {
    readonly pid: number;
    readonly host: string;
    readonly state: 'alive' | 'dead' | 'unknown';
  } | null;
  /** Child records observed before removal; none alive or unknown. */
  readonly processes: readonly HarnessProcessInspection[];
  /** Missing or unreadable metadata. */
  readonly warning?: string;
  /** `absent` when the lock vanished before it could be renamed away. */
  readonly action: 'removed' | 'absent';
}

/**
 * Clear an abandoned run lock for an operator, without importing workflow code. Every existing
 * lock is observed and judged (`decideUnlock`) before anything is removed; a refusal throws
 * `run.locked` or `run.orphans` and changes nothing. Removal re-verifies the observed owner and
 * marker tokens, then retires each lock through the tombstone rename, primary first. Nothing is
 * ever signaled. Returns the locks found; empty when the run was not locked. @internal
 */
export async function unlockRun(options: {
  readonly runId: string;
  readonly stateDir: string;
  readonly forceRemote?: boolean;
  /** The program words behind the commands a refusal names; absent means `['quiet-choir']`. */
  readonly commandLauncher?: CommandLauncher | undefined;
}): Promise<UnlockedLock[]> {
  const { runId } = options;
  const stateDir = resolveStateDir({ stateDir: options.stateDir });
  const locks = (
    await Promise.all([
      observeUnlock('primary', join(runDirectory(stateDir, runId), 'lock'), runId),
      observeUnlock('guard', `${legacyRunPath(stateDir, runId)}.lock`, runId),
    ])
  ).filter((lock) => lock !== undefined);
  const decision = decideUnlock(locks, options.forceRemote ?? false);
  if (decision.kind === 'locked') {
    const { lock, role, holder, reason } = decision;
    const who = `Run ${runId} ${lock.kind} lock ${role === 'owner' ? 'owner' : 'recoverer'} PID ${String(holder.pid)}`;
    const entry = unlockNext(options.commandLauncher, stateDir, runId, {
      forceRemote: reason === 'remote',
      why:
        reason === 'remote'
          ? `Only if ${holder.host} is this machine under an old name or is permanently gone.`
          : `Rerun once PID ${String(holder.pid)} on ${holder.host} has exited.`,
    });
    throw new RunRefusedError(
      'run.locked',
      runId,
      reason === 'remote'
        ? `${who} is on foreign host ${holder.host}. If ${holder.host} is this machine under an old name or is permanently gone, rerun with ${formatArgv(entry.argv)}.`
        : `${who} on ${holder.host} is ${reason === 'alive' ? 'alive' : 'unverifiable'}; unlock never stops a process. Wait for it to exit or stop it, then retry.`,
      {
        lockPath: lock.path,
        kind: lock.kind,
        role,
        pid: holder.pid,
        host: holder.host,
        state: reason,
        next: nextDetail([entry]),
      },
    );
  }
  if (decision.kind === 'orphans') {
    const owner = decision.lock.owner;
    const refusal = new OrphanProcessesError(
      runId,
      decision.processes,
      owner && { pid: owner.pid, host: owner.host, state: owner.state },
    );
    refusal.message = `${refusal.message} Unlock never signals a process: wait for them to exit and retry, or stop confirmed ones with quiet-choir workflow resume ${runId} --state-dir ${stateDir} --kill-orphans.`;
    throw refusal;
  }
  const unlocked: UnlockedLock[] = [];
  for (const lock of locks) {
    const changed = (): RunRefusedError =>
      new RunRefusedError(
        'run.locked',
        runId,
        `Run ${runId} lock ownership changed during unlock; retry.`,
        {
          lockPath: lock.path,
          next: nextDetail([
            unlockNext(options.commandLauncher, stateDir, runId, { why: transientWhy }),
          ]),
        },
      );
    const action = await removeObservedLock(lock, changed);
    unlocked.push({
      kind: lock.kind,
      path: lock.path,
      owner: lock.owner && { pid: lock.owner.pid, host: lock.owner.host, state: lock.owner.state },
      recovery:
        lock.recovery === null || lock.recovery === 'unreadable'
          ? null
          : { pid: lock.recovery.pid, host: lock.recovery.host, state: lock.recovery.state },
      processes: lock.processes,
      ...(lock.warning === undefined ? {} : { warning: lock.warning }),
      action,
    });
  }
  return unlocked;
}

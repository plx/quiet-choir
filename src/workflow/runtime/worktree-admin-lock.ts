import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../../processes/identity.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { WorktreeGit } from '../../worktrees/git.js';
import {
  formatArgv,
  nextDetail,
  unlockWorktreeAdminNext,
  type CommandLauncher,
} from './commands.js';
import type { ProcessRunner } from './exec-model.js';
import {
  claimRecovery,
  isErrno,
  liveness,
  lockGone,
  markOwnerReleased,
  observeUnlock,
  ownerState,
  publishLock,
  readContended,
  readMarker,
  readOwner,
  removeObservedLock,
  retire,
  sweepStrays,
  takeMarker,
  type Marker,
  type Owner,
} from './lock.js';
import { decideUnlock } from './recovery-decision.js';
import { WorktreeAdminLockRefusedError } from './run-errors.js';
import { createStorageDirectory } from './storage-io.js';

/**
 * The repository's interprocess worktree administration lock. It lives in the common Git directory,
 * the one location every process administering that repository shares, whatever its state
 * directory or linked checkout. @internal
 */
export function worktreeAdminLockPath(commonGitDir: string): string {
  return join(commonGitDir, 'quiet-choir', 'worktree-admin.lock');
}

/** Waiting and identity options for one acquire. @internal */
export interface WorktreeAdminLockOptions {
  /** Cancels a wait; an abort rejects with the signal's reason and leaves the lock untouched. */
  readonly signal: AbortSignal;
  /** How long an unverifiable (remote, unknown or unreadable) holder may block before refusal. */
  readonly stuckAfterMs?: number;
  /** False records no OS start time for this process, skipping the `ps` probe (tests). */
  readonly probeOwner?: boolean;
}

/** Releases the lock; resolves when it was already gone. @internal */
export type WorktreeAdminRelease = () => Promise<void>;

/**
 * Tokens of the admin locks this process holds now, shared by every quiet-choir module instance in
 * the process (the CLI imports a second one with the workflow). A lock naming this process whose
 * token is not here was leaked by a release that could neither retire it nor mark it released, and
 * is recovered instead of waited on forever.
 */
function liveTokens(): Set<string> {
  const scope = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (scope[Symbol.for('quiet-choir.worktreeAdminTokens')] ??= new Set<string>());
}

let ownStart: string | null | undefined;

/** This process's OS start time, probed once: administration runs on every worktree add/list/remove. */
function ownStartTime(probe: boolean): string | null {
  if (!probe) return null;
  ownStart ??= processIdentity(process.pid)?.start ?? null;
  return ownStart;
}

/** A holder whose liveness this host cannot judge; refused after the stuck deadline. */
interface Unverifiable {
  /** Identifies the holder, so a different one restarts the deadline. */
  readonly key: string;
  readonly describe: () => string;
  /**
   * What `workflow unlock --worktree-admin` needs to clear it: `force-remote` for a foreign-host
   * holder, a local PID it refuses while that process may exist, or nothing extra (`unlock`) for
   * unreadable metadata, which never holds an unlock.
   */
  readonly remedy: 'unlock' | 'force-remote' | { readonly wait: number };
  readonly cause?: unknown;
}

/** The stuck-holder refusal's remedy: the unlock command, never a manual removal. */
function stuckRemedy(commonGitDir: string, remedy: Unverifiable['remedy']): string {
  const command = formatArgv(
    unlockWorktreeAdminNext(undefined, commonGitDir, {
      forceRemote: remedy === 'force-remote',
      why: '',
    }).argv,
  );
  if (typeof remedy === 'object')
    return `Unlock refuses while PID ${String(remedy.wait)} may still exist on this machine: wait for it to exit or stop it, then clear the lock with ${command}.`;
  return `After confirming that no quiet-choir process on any machine sharing this repository is administering its worktrees, clear it with ${command}.`;
}

/** Thrown inside one recovery attempt to send the loop back to look again. */
class Contention extends Error {
  public constructor(public readonly marker?: Marker | null) {
    super('Worktree administration lock changed during recovery.');
  }
}

const initialBackoffMs = 5;
const maximumBackoffMs = 200;
const defaultStuckAfterMs = 30_000;

/**
 * Acquire the repository's worktree administration lock, waiting while another process holds it.
 * Uses the run lock's crash-atomic primitives (ADR 0030): a lock directory published whole by
 * rename with a durable `owner.json`, a tombstone-and-verify retire, and a `recovery.json` claim so
 * exactly one contender retires a dead or released owner. A live local owner is waited on without a
 * bound until `signal` aborts; a remote, unverifiable or unreadable holder is refused after
 * `stuckAfterMs` (30 s) with the `workflow unlock --worktree-admin` command that clears it. A
 * release that cannot retire the lock still throws, but first marks its verified `owner.json`
 * released, so other processes, inspect and unlock treat it as free at once. See ADR 0032.
 * @internal
 */
export async function acquireWorktreeAdminLock(
  commonGitDir: string,
  options: WorktreeAdminLockOptions,
): Promise<WorktreeAdminRelease> {
  const { signal } = options;
  signal.throwIfAborted();
  const lockPath = worktreeAdminLockPath(commonGitDir);
  await createStorageDirectory(dirname(lockPath));
  const owner: Owner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    osStartTime: ownStartTime(options.probeOwner ?? true),
  };
  const tokens = liveTokens();
  // Registered before the publish rename, so no other module instance here can judge it leaked.
  tokens.add(owner.token);
  try {
    await contend(commonGitDir, lockPath, owner, options);
  } catch (error) {
    tokens.delete(owner.token);
    throw error;
  }
  await sweepStrays(lockPath);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      let current: Owner;
      try {
        current = await readOwner(lockPath);
      } catch (cause) {
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) return;
        throw new Error(
          `Worktree administration lock ownership could not be verified; inspect ${lockPath}.`,
          { cause },
        );
      }
      const lost = (): Error =>
        new Error(`Worktree administration lock ${lockPath} ownership was lost.`);
      if (current.token !== owner.token) throw lost();
      try {
        await retire(lockPath, { owner: owner.token }, lost);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return;
        throw await handOff(lockPath, owner, error);
      }
    } finally {
      // Removed whether or not the retire worked, so a leaked lock never hangs this process. Only
      // after any hand-off, so no other module instance here judges the lock leaked mid-rewrite.
      tokens.delete(owner.token);
    }
  };
}

/**
 * After a failed retire, mark this acquire's lock released, so every process recovers it at once
 * instead of waiting for this live process to exit. The lock at `lockPath` is re-verified to carry
 * this acquire's token first: a retire that moved it before failing, or that renamed back another
 * owner's lock, leaves nothing of this acquire's to hand off, and a lock carrying this live,
 * unreleased token cannot be retired by anyone else meanwhile. Returns the error the release
 * throws: the retire's own when the hand-off worked or was skipped, otherwise one that names both
 * failures, with the retire's as its cause; `judge` then still recovers the lock in this process.
 */
async function handOff(lockPath: string, owner: Owner, failure: unknown): Promise<unknown> {
  try {
    if ((await readOwner(lockPath)).token !== owner.token) return failure;
  } catch {
    return failure;
  }
  try {
    await markOwnerReleased(lockPath, owner);
    return failure;
  } catch (error) {
    // The lock vanished between the check and the rewrite; there is nothing left to hand off.
    if (isErrno(error, 'ENOENT')) return failure;
    return new Error(
      `Worktree administration lock ${lockPath} could not be released (${message(failure)}) or handed to recovery (${message(error)}); other processes wait until this one exits.`,
      { cause: failure },
    );
  }
}

/**
 * Judge a contended owner, treating this process's own leaked locks as released: a lock whose
 * release failed to both retire it and mark it released (see `handOff`) still names this live
 * process, under a token no acquire here holds any more.
 */
function judge(owner: Owner): ReturnType<typeof ownerState> {
  // Only this process can be alive under its own PID, so a token it does not hold is not live.
  if (owner.pid === process.pid && owner.host === hostname() && !liveTokens().has(owner.token))
    return 'released';
  return ownerState(owner);
}

async function contend(
  commonGitDir: string,
  lockPath: string,
  owner: Owner,
  options: WorktreeAdminLockOptions,
): Promise<void> {
  const { signal } = options;
  const stuckAfterMs = options.stuckAfterMs ?? defaultStuckAfterMs;
  let backoff = initialBackoffMs;
  let stuck: { readonly key: string; readonly since: number } | undefined;
  const wait = async (blocker?: Unverifiable): Promise<void> => {
    if (blocker === undefined) stuck = undefined;
    else {
      if (stuck?.key !== blocker.key) stuck = { key: blocker.key, since: Date.now() };
      if (Date.now() - stuck.since >= stuckAfterMs)
        throw new Error(
          `Worktree administration lock ${lockPath} is held by ${blocker.describe()} for over ${stuckAfterMs < 1000 ? `${String(stuckAfterMs)} ms` : `${String(Math.round(stuckAfterMs / 1000))} s`}. ${stuckRemedy(commonGitDir, blocker.remedy)}`,
          blocker.cause === undefined ? undefined : { cause: blocker.cause },
        );
    }
    try {
      await delay(backoff * (0.5 + Math.random()), undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    backoff = Math.min(backoff * 2, maximumBackoffMs);
  };
  for (;;) {
    signal.throwIfAborted();
    if ((await publishLock(lockPath, owner)) === 'published') return;
    let previous: Owner | 'gone';
    try {
      previous = await readContended(lockPath);
    } catch (cause) {
      await wait({
        key: 'unreadable',
        describe: () => 'an owner whose metadata is incomplete or unreadable',
        remedy: 'unlock',
        cause,
      });
      continue;
    }
    if (previous === 'gone') continue;
    const state = judge(previous);
    const holder = `PID ${String(previous.pid)} on ${previous.host}`;
    if (state === 'alive') {
      await wait();
      continue;
    }
    if (state === 'remote' || state === 'unknown') {
      await wait({
        key: `owner:${previous.token}`,
        describe: () =>
          state === 'remote'
            ? `${holder}, another host`
            : `${holder}, whose liveness cannot be determined`,
        remedy: state === 'remote' ? 'force-remote' : { wait: previous.pid },
      });
      continue;
    }
    try {
      await recover(lockPath, previous, owner);
    } catch (error) {
      if (!(error instanceof Contention)) throw error;
      const marker = error.marker;
      if (marker === undefined) continue;
      if (marker === null) {
        await wait({
          key: 'marker',
          describe: () => `a recoverer whose recovery.json is unreadable`,
          remedy: 'unlock',
        });
        continue;
      }
      const recoverer = liveness(marker);
      await wait(
        recoverer === 'alive'
          ? undefined
          : {
              key: `marker:${marker.token}`,
              describe: () =>
                `recoverer PID ${String(marker.pid)} on ${marker.host}, ${recoverer === 'remote' ? 'another host' : 'whose liveness cannot be determined'}`,
              remedy: recoverer === 'remote' ? 'force-remote' : { wait: marker.pid },
            },
      );
    }
  }
}

/**
 * Retire a dead or released owner's lock as the single winning recoverer. Throws `Contention` to
 * look again: with the holding marker (null when unreadable) when another recoverer holds the lock.
 */
async function recover(lockPath: string, previous: Owner, owner: Owner): Promise<void> {
  const changed = (): Error => new Contention();
  const marker: Marker = {
    pid: owner.pid,
    host: owner.host,
    osStartTime: owner.osStartTime,
    token: randomUUID(),
  };
  if (
    (await claimRecovery(
      lockPath,
      marker,
      changed,
      (existing) => new Contention(existing ?? null),
    )) === 'retry'
  )
    return;
  let retired = false;
  try {
    let current: Owner;
    try {
      current = await readOwner(lockPath);
    } catch {
      throw changed();
    }
    if (current.token !== previous.token || !['dead', 'released'].includes(judge(current)))
      throw changed();
    // A reclaimer that judged this recoverer dead may have taken the marker meanwhile.
    let mine: Marker;
    try {
      mine = await readMarker(join(lockPath, 'recovery.json'));
    } catch {
      throw changed();
    }
    if (mine.token !== marker.token) throw changed();
    try {
      await retire(lockPath, { owner: current.token, recovery: marker.token }, changed);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw changed();
      throw error;
    }
    retired = true;
  } finally {
    if (!retired) await takeMarker(lockPath, marker.token).catch(() => undefined);
  }
}

/**
 * Resolve any path inside a repository (a checkout, a linked worktree or the common Git directory
 * itself) to the canonical common Git directory that keys its worktree administration lock: the
 * realpath of `git rev-parse --path-format=absolute --git-common-dir`, as worktree isolation
 * resolves it. Runs only that read-only `rev-parse`; rejects when `path` is not inside a Git
 * repository. With a `supervisor`, the child is registered with it for the run of the command, so
 * an embedder's second-signal handler can force-kill it; there is no run lock to record it in.
 * @internal
 */
export async function resolveCommonGitDir(
  path: string,
  runner: ProcessRunner,
  signal: AbortSignal,
  supervisor?: ProcessSupervisor,
): Promise<string> {
  const git = new WorktreeGit(runner, true);
  return realpath(
    await git.text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      runId: 'worktree-admin',
      stepId: 'rev-parse',
      attempt: 1,
      signal,
      // There is no run whose lock could record the child; the CLI supervisor, when given, owns it.
      trackProcess: (child) => {
        const forget = supervisor?.track(child);
        return Promise.resolve({
          release: () => {
            forget?.();
            return Promise.resolve();
          },
        });
      },
    }),
  );
}

/** A repository's worktree administration lock as `workflow inspect` reports it. @internal */
export interface WorktreeAdminLockView {
  /** The canonical common Git directory the lock belongs to. */
  readonly commonGitDir: string;
  /** Absolute lock directory path. */
  readonly path: string;
  /** Owner metadata and liveness, or null when `owner.json` is missing or unreadable. */
  readonly owner: {
    /** Holder's recorded process ID. */
    readonly pid: number;
    /** Host on which the holder acquired the lock. */
    readonly host: string;
    /** Ownership token, which a guarded unlock compares before removal. */
    readonly token: string;
    /** Current local liveness, `remote` for another host, or `released`. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote' | 'released';
    /** The holder's recorded OS birth identity, or null when it recorded none. */
    readonly osStartTime: string | null;
    /**
     * Approximate acquisition time: the ISO modification time of `owner.json`, written just before
     * the lock was published (filesystem granularity, and clock skew on a network filesystem). Null
     * when it could not be read.
     */
    readonly acquiredAt: string | null;
  } | null;
  /** The recovery marker of a process retiring this lock, or null. */
  readonly recovery: {
    /** Recoverer's process ID. */
    readonly pid: number;
    /** Host on which the recoverer runs. */
    readonly host: string;
    /** Current local liveness of the recoverer, or `remote`. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote';
  } | null;
  /** Set when `owner.json` is missing, or `owner.json` or `recovery.json` cannot be read or parsed. */
  readonly warning?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a repository's worktree administration lock without changing anything, or undefined when no
 * lock is held. Owner and recoverer liveness are judged on this machine, as the acquire does.
 * @internal
 */
export async function inspectWorktreeAdminLock(
  commonGitDir: string,
): Promise<WorktreeAdminLockView | undefined> {
  const path = worktreeAdminLockPath(commonGitDir);
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    return { commonGitDir, path, owner: null, recovery: null, warning: message(error) };
  }
  const warnings: string[] = [];
  let owner: WorktreeAdminLockView['owner'] = null;
  if (names.includes('owner.json'))
    try {
      const value = await readContended(path);
      // Retired between the listing and the read: there is no lock to report.
      if (value === 'gone') return undefined;
      const acquiredAt = await stat(join(path, 'owner.json')).then(
        (info) => info.mtime.toISOString(),
        () => null,
      );
      owner = {
        pid: value.pid,
        host: value.host,
        token: value.token,
        state: ownerState(value),
        osStartTime: value.osStartTime ?? null,
        acquiredAt,
      };
    } catch (error) {
      warnings.push(`owner.json: ${message(error)}`);
    }
  else warnings.push("owner.json: missing (an older build's interrupted acquire, or damage)");
  let recovery: WorktreeAdminLockView['recovery'] = null;
  if (names.includes('recovery.json'))
    try {
      const value = await readMarker(join(path, 'recovery.json'));
      recovery = { pid: value.pid, host: value.host, state: liveness(value) };
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) warnings.push(`recovery.json: ${message(error)}`);
    }
  return {
    commonGitDir,
    path,
    owner,
    recovery,
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}

/** The worktree administration lock that unlock cleared, with the judgments it acted on. @internal */
export interface UnlockedWorktreeAdminLock {
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
  /** Missing or unreadable metadata. */
  readonly warning?: string;
  /** `absent` when the lock vanished before it could be renamed away. */
  readonly action: 'removed' | 'absent';
}

/** What `workflow unlock --worktree-admin` did. @internal */
export interface WorktreeAdminUnlockResult {
  /** The canonical common Git directory the lock belongs to. */
  readonly commonGitDir: string;
  /** Absolute lock directory path. */
  readonly lockPath: string;
  /** The lock found and cleared, or null when none was held. */
  readonly lock: UnlockedWorktreeAdminLock | null;
}

/** Why a plain unlock entry accompanies a refusal for a race that a retry usually clears. */
const transientWhy =
  'If a retry is refused again, unlock reports who holds the lock and clears it only once no process holds it; it never removes a live lock or signals.';

/**
 * Clear a repository's abandoned worktree administration lock for an operator. The lock is observed
 * once and judged with `decideUnlock`, as a run lock is: a foreign-host owner or recoverer is
 * refused unless `forceRemote` asserts that host is gone (then it is judged by local PID
 * observations), and a locally alive or unknown owner or recoverer is always refused, with
 * `WorktreeAdminLockRefusedError` (`worktree.locked`). Missing or unreadable metadata never holds
 * an unlock; its warning is reported. Removal re-reads and compares the observed tokens, then
 * retires the lock through the verified tombstone rename. Nothing is ever signaled. @internal
 */
export async function unlockWorktreeAdminLock(options: {
  readonly commonGitDir: string;
  readonly forceRemote?: boolean;
  /** The program words behind the command a refusal names; absent means `['quiet-choir']`. */
  readonly commandLauncher?: CommandLauncher | undefined;
}): Promise<WorktreeAdminUnlockResult> {
  const { commonGitDir } = options;
  const lockPath = worktreeAdminLockPath(commonGitDir);
  const lock = await observeUnlock('worktree-admin', lockPath, null);
  if (lock === undefined) return { commonGitDir, lockPath, lock: null };
  const decision = decideUnlock([lock], options.forceRemote ?? false);
  // No children are observed for this lock, so `orphans` cannot occur.
  if (decision.kind === 'orphans') throw new Error('Unexpected unlock decision.');
  if (decision.kind === 'locked') {
    const { role, holder, reason } = decision;
    const who = `Worktree administration lock ${lockPath} ${role === 'owner' ? 'owner' : 'recoverer'} PID ${String(holder.pid)}`;
    const entry = unlockWorktreeAdminNext(options.commandLauncher, commonGitDir, {
      forceRemote: reason === 'remote',
      why:
        reason === 'remote'
          ? `Only if ${holder.host} is this machine under an old name or is permanently gone.`
          : `Rerun once PID ${String(holder.pid)} on ${holder.host} has exited.`,
    });
    throw new WorktreeAdminLockRefusedError(
      reason === 'remote'
        ? `${who} is on foreign host ${holder.host}. If ${holder.host} is this machine under an old name or is permanently gone, rerun with ${formatArgv(entry.argv)}.`
        : `${who} on ${holder.host} is ${reason === 'alive' ? 'alive' : 'unverifiable'}; unlock never stops a process. Wait for it to exit or stop it, then retry.`,
      {
        lockPath,
        commonGitDir,
        role,
        pid: holder.pid,
        host: holder.host,
        state: reason,
        next: nextDetail([entry]),
      },
    );
  }
  const action = await removeObservedLock(
    lock,
    () =>
      new WorktreeAdminLockRefusedError(
        `Worktree administration lock ${lockPath} changed during unlock; retry.`,
        {
          lockPath,
          commonGitDir,
          next: nextDetail([
            unlockWorktreeAdminNext(options.commandLauncher, commonGitDir, { why: transientWhy }),
          ]),
        },
      ),
  );
  return {
    commonGitDir,
    lockPath,
    lock: {
      path: lockPath,
      owner: lock.owner && { pid: lock.owner.pid, host: lock.owner.host, state: lock.owner.state },
      recovery:
        lock.recovery === null || lock.recovery === 'unreadable'
          ? null
          : { pid: lock.recovery.pid, host: lock.recovery.host, state: lock.recovery.state },
      ...(lock.warning === undefined ? {} : { warning: lock.warning }),
      action,
    },
  };
}

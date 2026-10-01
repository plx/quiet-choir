import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../../processes/identity.js';
import {
  claimRecovery,
  isErrno,
  liveness,
  lockGone,
  ownerState,
  publishLock,
  readContended,
  readMarker,
  readOwner,
  retire,
  sweepStrays,
  takeMarker,
  type Marker,
  type Owner,
} from './lock.js';
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
 * token is not here was leaked by a failed release and is recovered instead of waited on forever.
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
  readonly cause?: unknown;
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
 * `stuckAfterMs` (30 s) with the lock path to remove. See ADR 0032. @internal
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
    await contend(lockPath, owner, options);
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
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    } finally {
      // Removed whether or not the retire worked, so a leaked lock never hangs this process.
      tokens.delete(owner.token);
    }
  };
}

/** Judge a contended owner, treating this process's own leaked locks as released. */
function judge(owner: Owner): ReturnType<typeof ownerState> {
  // Only this process can be alive under its own PID, so a token it does not hold is not live.
  if (owner.pid === process.pid && owner.host === hostname() && !liveTokens().has(owner.token))
    return 'released';
  return ownerState(owner);
}

async function contend(
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
          `Worktree administration lock ${lockPath} is held by ${blocker.describe()} for over ${stuckAfterMs < 1000 ? `${String(stuckAfterMs)} ms` : `${String(Math.round(stuckAfterMs / 1000))} s`}. After confirming that no quiet-choir process on any machine sharing this repository is administering its worktrees, remove ${lockPath}.`,
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

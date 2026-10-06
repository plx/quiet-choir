import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pidState, processIdentity } from '../processes/identity.js';
import { syncDirectory, syncHandle } from '../workflow/runtime/storage-io.js';

/*
 * Private CODEX_HOME for `instructions: 'none'` calls (ADR 0031). The child sees a fresh 0700
 * directory holding only a 0600 copy of the real auth.json, so Codex finds no user AGENTS.md,
 * skills or memories. After the child exits, a refreshed auth.json is written back to the real
 * home with compare-and-swap under a cross-process lock in os.tmpdir(). A lock whose owner is gone is
 * reclaimed silently; a lock file that is not an owner record (corrupt, or foreign) is reclaimed with
 * a warning once it is older than a threshold. Warnings name paths only; credential bytes never
 * leave this module except into the two auth.json files.
 */

/** What to do with the private auth.json after the call. @internal */
export type WriteBackDecision =
  | {
      readonly action: 'skip';
      readonly reason:
        | 'original absent'
        | 'private missing'
        | 'unchanged'
        | 'private unparseable'
        | 'already current';
    }
  /** The real file still equals the snapshot: replace it with the refreshed copy. */
  | { readonly action: 'write' }
  /** The real file changed too and the private copy is newer: replace it, with a warning. */
  | { readonly action: 'keep-private' }
  /** The real file changed and is newer, or the order is unknown: leave it, with a warning. */
  | { readonly action: 'keep-real' };

/** Bytes of the three auth.json versions; null means the file does not exist. @internal */
export interface WriteBackInput {
  /** The real file when the private home was created. */
  readonly original: Uint8Array | null;
  /** The private copy after the child exited. */
  readonly refreshed: Uint8Array | null;
  /** The real file now, read under the lock. */
  readonly real: Uint8Array | null;
}

const equal = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(right);

/** Top-level object of a JSON file, or undefined. Never surfaces parser messages, which quote input. */
function jsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function lastRefresh(bytes: Uint8Array | null): number | undefined {
  const value = bytes && jsonObject(bytes)?.['last_refresh'];
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** Pure compare-and-swap decision for auth.json write-back. @internal */
export function decideWriteBack(input: WriteBackInput): WriteBackDecision {
  const { original, refreshed, real } = input;
  // Never create or delete a real auth.json.
  if (original === null) return { action: 'skip', reason: 'original absent' };
  if (refreshed === null) return { action: 'skip', reason: 'private missing' };
  if (equal(refreshed, original)) return { action: 'skip', reason: 'unchanged' };
  // A child killed mid-write can leave a torn file.
  if (jsonObject(refreshed) === undefined) return { action: 'skip', reason: 'private unparseable' };
  if (real !== null && equal(real, refreshed)) return { action: 'skip', reason: 'already current' };
  if (real !== null && equal(real, original)) return { action: 'write' };
  if (real === null) return { action: 'keep-real' };
  const ours = lastRefresh(refreshed);
  const theirs = lastRefresh(real);
  return ours !== undefined && theirs !== undefined && ours > theirs
    ? { action: 'keep-private' }
    : { action: 'keep-real' };
}

/** Lock tuning; tests shorten the wait. @internal */
export interface CodexHomeOptions {
  /** Longest wait for the cross-process auth.json lock; default 10 s. */
  readonly lockTimeoutMs?: number;
  /** Directory holding lock files; default os.tmpdir(). */
  readonly lockDirectory?: string;
  /** Age after which a lock file that is not a quiet-choir owner record is reclaimed; default 60 s. */
  readonly unreadableLockAgeMs?: number;
}

/** A private CODEX_HOME owned by one invocation. @internal */
export interface PrivateCodexHome {
  /** Absolute path to give the child as CODEX_HOME. */
  readonly path: string;
  /** Write back a refreshed auth.json once the child has exited; idempotent, never throws. */
  readonly settle: () => Promise<readonly string[]>;
  /** Settle if needed, then remove the private home. */
  readonly dispose: () => Promise<void>;
}

const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.name
      : 'error';

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** The lock file shared by every quiet-choir process writing back to this Codex home. @internal */
export function codexAuthLockPath(home: string, directory = tmpdir()): string {
  const key = createHash('sha256').update(home).digest('hex').slice(0, 24);
  return join(directory, `quiet-choir-codex-auth-${key}.lock`);
}

interface LockOwner {
  readonly pid: number;
  readonly start: string | null;
  readonly nonce: string;
}

function parseOwner(bytes: Buffer): LockOwner | undefined {
  const value = jsonObject(bytes);
  return value && typeof value['pid'] === 'number' && typeof value['nonce'] === 'string'
    ? {
        pid: value['pid'],
        start: typeof value['start'] === 'string' ? value['start'] : null,
        nonce: value['nonce'],
      }
    : undefined;
}

/** A dead owner, or a live PID whose OS birth identity no longer matches, holds nothing. */
function stale(owner: LockOwner): boolean {
  const state = pidState(owner.pid);
  if (state === 'dead') return true;
  if (state !== 'alive' || owner.start === null) return false;
  const current = processIdentity(owner.pid);
  return current !== null && current.start !== owner.start;
}

/** One look at the lock: bytes and metadata from the same open handle, so both describe one inode. */
interface LockObservation {
  readonly bytes: Buffer;
  readonly mtimeMs: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

async function observeLock(path: string): Promise<LockObservation | 'gone'> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'gone';
    throw error;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    return { bytes, mtimeMs: Number(stats.mtimeMs), dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

/** EPERM/EACCES from rename: typically another user's file in a sticky shared /tmp. */
type MoveAside = 'moved' | 'skipped' | { readonly denied: string };

/**
 * Move the observed lock to a tombstone. If the moved file is not the observed one (another process
 * replaced the lock meanwhile), put it back. The inode check tells apart equal-byte files.
 */
async function moveAside(
  path: string,
  observed: LockObservation,
  nonce: string,
): Promise<MoveAside> {
  const tombstone = `${path}.${nonce}.stale`;
  try {
    try {
      await rename(path, tombstone);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EPERM' || code === 'EACCES') return { denied: code };
      throw error;
    }
    const moved = await observeLock(tombstone);
    if (moved === 'gone') return 'skipped';
    if (
      moved.dev === observed.dev &&
      moved.ino === observed.ino &&
      moved.bytes.equals(observed.bytes)
    )
      return 'moved';
    await link(tombstone, path).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    return 'skipped';
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return 'skipped';
  } finally {
    await rm(tombstone, { force: true });
  }
}

/** Whole seconds when exact, else milliseconds. */
const formatAge = (ms: number): string =>
  ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${String(ms)} ms`;

type LockResult =
  | {
      readonly status: 'acquired';
      /** Idempotent; removes the lock only while it still holds our nonce. */
      readonly release: () => Promise<void>;
      readonly notes: readonly string[];
    }
  /** The last holder seen was a quiet-choir owner record, or a file that is not one. */
  | { readonly status: 'timed out'; readonly holder: 'owner' | 'unreadable' }
  | { readonly status: 'denied'; readonly code: string };

/**
 * Publish a complete owner record by hard link, so no reader sees a partial lock. Our own code never
 * leaves an unparseable lock, so one older than `unreadableAgeMs` is moved aside; a younger one may
 * still be written by a foreign process and is waited on. A valid live owner is never reclaimed.
 */
async function acquireLock(
  path: string,
  timeoutMs: number,
  unreadableAgeMs: number,
): Promise<LockResult> {
  const owner: LockOwner = {
    pid: process.pid,
    start: processIdentity(process.pid)?.start ?? null,
    nonce: randomUUID(),
  };
  const draft = `${path}.${owner.nonce}.draft`;
  await writeFile(draft, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  const notes: string[] = [];
  let wait = 5;
  try {
    for (;;) {
      try {
        await link(draft, path);
        return {
          status: 'acquired',
          notes,
          release: async () => {
            const current = await readIfPresent(path);
            if (current && parseOwner(current)?.nonce === owner.nonce)
              await rm(path, { force: true });
          },
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const held = await observeLock(path);
      if (held === 'gone') continue;
      const holder = parseOwner(held.bytes);
      const reclaim = holder ? stale(holder) : Date.now() - held.mtimeMs >= unreadableAgeMs;
      if (reclaim) {
        const moved = await moveAside(path, held, owner.nonce);
        if (typeof moved === 'object') return { status: 'denied', code: moved.denied };
        if (moved === 'moved' && !holder)
          notes.push(
            `Reclaimed an unreadable Codex auth lock file ${path} older than ${formatAge(unreadableAgeMs)}.`,
          );
        continue;
      }
      if (Date.now() >= deadline)
        return { status: 'timed out', holder: holder ? 'owner' : 'unreadable' };
      await delay(Math.min(wait, Math.max(1, deadline - Date.now())));
      wait = Math.min(wait * 2, 200);
    }
  } finally {
    await rm(draft, { force: true });
  }
}

/** Replace target with bytes in its own directory, preserving its mode. */
async function replaceFile(target: string, bytes: Uint8Array): Promise<void> {
  const mode = (await stat(target)).mode & 0o777;
  const temporary = join(dirname(target), `.auth.json.quiet-choir-${randomUUID()}.tmp`);
  try {
    {
      await using file = await open(temporary, 'wx', mode);
      await file.chmod(mode);
      await file.writeFile(bytes);
      await syncHandle(file);
    }
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Create a private CODEX_HOME holding only a copy of `source`'s auth.json. A missing auth.json
 * gives an empty home and no write-back (API-key and env_key providers need none). @internal
 */
export async function prepareCodexHome(
  source: string,
  options: CodexHomeOptions = {},
): Promise<PrivateCodexHome> {
  const home = resolve(source);
  let target = join(home, 'auth.json');
  let original: Buffer | null = null;
  try {
    target = await realpath(target);
    original = await readFile(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const path = await mkdtemp(join(tmpdir(), 'quiet-choir-codex-home-'));
  try {
    await chmod(path, 0o700);
    if (original !== null) {
      await writeFile(join(path, 'auth.json'), original, { mode: 0o600, flag: 'wx' });
      await chmod(join(path, 'auth.json'), 0o600);
    }
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }

  const lockPath = codexAuthLockPath(await realpath(home).catch(() => home), options.lockDirectory);
  const unreadableAgeMs = options.unreadableLockAgeMs ?? 60_000;
  const failed = (reason: string): string =>
    `Could not save refreshed Codex credentials to ${target}: ${reason}.`;
  const underLock = async (refreshed: Buffer | null): Promise<readonly string[]> => {
    const real = await readIfPresent(target);
    const decision = decideWriteBack({ original, refreshed, real });
    if ((decision.action === 'write' || decision.action === 'keep-private') && refreshed)
      await replaceFile(target, refreshed);
    if (decision.action === 'keep-private' || decision.action === 'keep-real')
      return [
        `Codex auth.json in ${home} changed during the call; kept the ${
          decision.action === 'keep-private' || lastRefresh(real) !== undefined
            ? 'newer'
            : 'existing'
        } credentials.`,
      ];
    return [];
  };
  const writeBack = async (): Promise<readonly string[]> => {
    if (original === null) return [];
    let refreshed: Buffer | null;
    try {
      refreshed = await readIfPresent(join(path, 'auth.json'));
    } catch (error) {
      return [failed(errorCode(error))];
    }
    // Assume the real file is unchanged to skip the lock when nothing needs writing.
    if (decideWriteBack({ original, refreshed, real: original }).action === 'skip') return [];
    let lock: LockResult;
    try {
      lock = await acquireLock(lockPath, options.lockTimeoutMs ?? 10_000, unreadableAgeMs);
    } catch (error) {
      return [failed(`${errorCode(error)} on the lock ${lockPath}`)];
    }
    if (lock.status === 'timed out')
      return [
        failed(
          `timed out waiting for the lock ${lockPath}${
            lock.holder === 'unreadable'
              ? `, which is not a quiet-choir owner record and will be reclaimed once older than ${formatAge(unreadableAgeMs)}`
              : ''
          }`,
        ),
      ];
    if (lock.status === 'denied')
      return [
        failed(
          `cannot move aside the lock ${lockPath} (${lock.code}); remove it if no quiet-choir process is writing back`,
        ),
      ];
    const warnings = [...lock.notes];
    try {
      warnings.push(...(await underLock(refreshed)));
    } catch (error) {
      warnings.push(failed(errorCode(error)));
    }
    try {
      await lock.release();
    } catch (error) {
      warnings.push(`Could not remove the Codex auth lock ${lockPath}: ${errorCode(error)}.`);
    }
    return warnings;
  };
  let settled: Promise<readonly string[]> | undefined;
  const settle = (): Promise<readonly string[]> => (settled ??= writeBack());
  return {
    path,
    settle,
    dispose: async () => {
      await settle();
      await rm(path, { recursive: true, force: true });
    },
  };
}

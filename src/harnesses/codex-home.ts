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
 * home with compare-and-swap under a cross-process lock in os.tmpdir(). Warnings name paths only;
 * credential bytes never leave this module except into the two auth.json files.
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

/** Publish a complete owner record by hard link, so no reader sees a partial lock. */
async function acquireLock(
  path: string,
  timeoutMs: number,
): Promise<(() => Promise<void>) | undefined> {
  const owner: LockOwner = {
    pid: process.pid,
    start: processIdentity(process.pid)?.start ?? null,
    nonce: randomUUID(),
  };
  const draft = `${path}.${owner.nonce}.draft`;
  await writeFile(draft, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  let wait = 5;
  try {
    for (;;) {
      try {
        await link(draft, path);
        return async () => {
          const current = await readIfPresent(path);
          if (current && parseOwner(current)?.nonce === owner.nonce)
            await rm(path, { force: true });
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const held = await readIfPresent(path);
      const holder = held && parseOwner(held);
      if (held && holder && stale(holder)) {
        // Move the stale lock aside, and put it back if another process replaced it meanwhile.
        const tombstone = `${path}.${owner.nonce}.stale`;
        try {
          await rename(path, tombstone);
          const moved = await readIfPresent(tombstone);
          if (moved && !moved.equals(held))
            await link(tombstone, path).catch((error: unknown) => {
              if (errorCode(error) !== 'EEXIST') throw error;
            });
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        } finally {
          await rm(tombstone, { force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) return undefined;
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
  const writeBack = async (): Promise<readonly string[]> => {
    if (original === null) return [];
    const failed = (reason: string): string =>
      `Could not save refreshed Codex credentials to ${target}: ${reason}.`;
    try {
      const refreshed = await readIfPresent(join(path, 'auth.json'));
      // Assume the real file is unchanged to skip the lock when nothing needs writing.
      if (decideWriteBack({ original, refreshed, real: original }).action === 'skip') return [];
      const release = await acquireLock(lockPath, options.lockTimeoutMs ?? 10_000);
      if (!release) return [failed(`timed out waiting for the lock ${lockPath}`)];
      try {
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
      } finally {
        await release();
      }
    } catch (error) {
      return [failed(errorCode(error))];
    }
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

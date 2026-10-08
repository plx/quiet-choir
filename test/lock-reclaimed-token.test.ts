import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as storageIo from '../src/workflow/runtime/storage-io.js';
import { lockRun } from '../src/workflow/runtime/store.js';
import { openFileOwnedRun, reclaimedOwnerToken } from '../src/workflow/runtime/run-store.js';

// Issue #293 / ADR 0058: lockRun reports the token of the dead or released owner whose primary lock
// it retired itself immediately before publishing its own, and nothing else. Tick honours a forced
// cancel only against this token, so a request from an earlier acquisition never matches.

/**
 * Runs `plant(path)` once, for the nth directory sync of a primary-lock publish directory, and then
 * `next` (if any) at the next file sync, which is the recovery marker of a contended acquire.
 */
let planted:
  | { readonly nth: number; readonly plant: (lockPath: string) => void; next?: () => void }
  | undefined;
vi.mock('../src/workflow/runtime/storage-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof storageIo>();
  let seen = 0;
  let next: (() => void) | undefined;
  return {
    ...actual,
    syncDirectory: vi.fn(async (path: string) => {
      const name = basename(path);
      if (planted && name.startsWith('lock.') && name.endsWith('.tmp') && ++seen === planted.nth) {
        const { plant } = planted;
        next = planted.next;
        planted = undefined;
        seen = 0;
        plant(join(dirname(path), 'lock'));
      }
      await actual.syncDirectory(path);
    }),
    syncHandle: vi.fn(async (handle: Parameters<typeof actual.syncHandle>[0]) => {
      const run = next;
      next = undefined;
      run?.();
      await actual.syncHandle(handle);
    }),
  };
});

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-reclaimed-'));
});
afterEach(async () => {
  planted = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

const exitedPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

/** Leave a lock whose owner has exited, or (released) a live owner that handed it to recovery. */
async function abandonedLock(path: string, released = false): Promise<string> {
  const token = randomUUID();
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify(
      released
        ? { pid: process.pid, host: hostname(), token, released: true }
        : { pid: exitedPid(), host: hostname(), token },
    ),
  );
  return token;
}

it('is undefined for a fresh acquisition, including after a clean release', async () => {
  const first = await lockRun(stateDir, 'run');
  expect(first.reclaimedOwnerToken).toBeUndefined();
  await first();
  const owned = await openFileOwnedRun(stateDir, 'run');
  try {
    expect(reclaimedOwnerToken(owned)).toBeUndefined();
  } finally {
    await owned.release();
  }
});

it("names the dead primary owner's token, never the guard's", async () => {
  const primary = await abandonedLock(join(stateDir, 'run', 'lock'));
  const guard = await abandonedLock(join(stateDir, 'run.json.lock'));
  const owned = await openFileOwnedRun(stateDir, 'run');
  try {
    expect(reclaimedOwnerToken(owned)).toBe(primary);
    expect(reclaimedOwnerToken(owned)).not.toBe(guard);
  } finally {
    await owned.release();
  }
});

it("names a released owner's token", async () => {
  const token = await abandonedLock(join(stateDir, 'run', 'lock'), true);
  const release = await lockRun(stateDir, 'run');
  try {
    expect(release.reclaimedOwnerToken).toBe(token);
  } finally {
    await release();
  }
});

it('is undefined for a store other than the file store', () => {
  expect(
    reclaimedOwnerToken({
      read: () => Promise.resolve(undefined),
      append: () => Promise.resolve(),
      compact: () => Promise.resolve(),
      artifacts: () => Promise.resolve(''),
      trackProcess: () => Promise.reject(new Error('unused')),
      release: () => Promise.resolve(),
    }),
  ).toBeUndefined();
});

it('names only the lock retired right before the publish when another was published in between', async () => {
  const first = await abandonedLock(join(stateDir, 'run', 'lock'));
  let second: string | undefined;
  // The first publish is contended by the dead owner, which this call retires. Before the retry
  // publishes, another process publishes a lock and dies too: the token retired first is dropped.
  planted = {
    nth: 2,
    plant: (lockPath) => {
      second = randomUUID();
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: exitedPid(), host: hostname(), token: second }),
      );
    },
  };
  const release = await lockRun(stateDir, 'run');
  try {
    expect(second).toBeDefined();
    expect(release.reclaimedOwnerToken).toBe(second);
    expect(release.reclaimedOwnerToken).not.toBe(first);
  } finally {
    await release();
  }
});

it('is cleared when a lock published in between is released before this call could retire it', async () => {
  const first = await abandonedLock(join(stateDir, 'run', 'lock'));
  let path: string | undefined;
  // As above, but the other process releases its lock cleanly while this call claims recovery of
  // it, so this call publishes its own lock having retired nothing right before.
  planted = {
    nth: 2,
    plant: (lockPath) => {
      path = lockPath;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: exitedPid(), host: hostname(), token: randomUUID() }),
      );
    },
    next: () => {
      if (path !== undefined) rmSync(path, { recursive: true, force: true });
    },
  };
  const release = await lockRun(stateDir, 'run');
  try {
    expect(path).toBeDefined();
    expect(first).toBeDefined();
    expect(release.reclaimedOwnerToken).toBeUndefined();
  } finally {
    await release();
  }
});

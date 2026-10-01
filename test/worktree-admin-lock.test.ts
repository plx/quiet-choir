import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acquireWorktreeAdminLock,
  worktreeAdminLockPath,
} from '../src/workflow/runtime/worktree-admin-lock.js';
import { holdAdminLock } from './worktree-admin-holder.js';

let common: string, lockPath: string;
beforeEach(async () => {
  common = await realpath(await mkdtemp(join(tmpdir(), 'choir-admin-lock-')));
  lockPath = worktreeAdminLockPath(common);
});
afterEach(async () => {
  await chmod(dirname(lockPath), 0o700).catch(() => undefined);
  await rm(common, { recursive: true, force: true });
});

const signal = new AbortController().signal;

/** The PID of a process that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** Write a lock directory as another owner left it, without publishing through the lock module. */
async function plant(
  owner: { pid: number; host?: string; token?: string } | string,
  recovery?: { pid: number; host?: string; token?: string },
): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, 'owner.json'),
    typeof owner === 'string'
      ? owner
      : JSON.stringify({ host: hostname(), token: randomUUID(), osStartTime: null, ...owner }),
  );
  if (recovery)
    await writeFile(
      join(lockPath, 'recovery.json'),
      JSON.stringify({ host: hostname(), token: randomUUID(), osStartTime: null, ...recovery }),
    );
}

/** The lock's directory holds nothing: no lock, no publish directory, no tombstone. */
async function expectNoResidue(): Promise<void> {
  expect(await readdir(dirname(lockPath))).toEqual([]);
}

it('places the lock in a private quiet-choir directory of the common Git dir', () => {
  expect(lockPath).toBe(join(common, 'quiet-choir', 'worktree-admin.lock'));
});

it('acquires and releases without leaving a lock or strays, and tolerates a repeated release', async () => {
  const release = await acquireWorktreeAdminLock(common, { signal });
  const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
    pid: number;
    host: string;
  };
  expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
  await release();
  await release();
  await expectNoResidue();
});

it('recovers a dead owner automatically', async () => {
  await plant({ pid: deadPid() });
  const release = await acquireWorktreeAdminLock(common, { signal });
  await release();
  await expectNoResidue();
});

it('reclaims the recovery marker of a dead recoverer', async () => {
  await plant({ pid: deadPid() }, { pid: deadPid() });
  const release = await acquireWorktreeAdminLock(common, { signal });
  await release();
  await expectNoResidue();
});

it('takes over an empty lock directory left by an older build', async () => {
  await mkdir(lockPath, { recursive: true });
  const release = await acquireWorktreeAdminLock(common, { signal });
  await release();
  await expectNoResidue();
});

it('reclaims a lock this process leaked instead of waiting for itself', async () => {
  // Owned by this live PID under a token no acquire in this process holds.
  await plant({ pid: process.pid });
  const release = await acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 0 });
  await release();
  await expectNoResidue();
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'never hangs a later acquire after a release fails',
  async () => {
    const release = await acquireWorktreeAdminLock(common, { signal });
    // The retire rename needs a writable parent; without it the lock stays behind.
    await chmod(dirname(lockPath), 0o500);
    await expect(release()).rejects.toMatchObject({ code: 'EACCES' });
    await chmod(dirname(lockPath), 0o700);
    expect(await readdir(dirname(lockPath))).toEqual(['worktree-admin.lock']);
    const again = await acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 0 });
    await again();
    await expectNoResidue();
  },
);

it('waits for a live holder in another process, then acquires', async () => {
  const holder = holdAdminLock(common, 300);
  await holder.held;
  const release = await acquireWorktreeAdminLock(common, { signal });
  const acquired = Date.now();
  expect(acquired).toBeGreaterThanOrEqual(await holder.released);
  await release();
  expect((await holder.exited).code).toBe(0);
  await expectNoResidue();
});

it('rejects with the abort reason while waiting and leaves the holder untouched', async () => {
  // The parent of this test process is alive for the whole test.
  const owner = JSON.stringify({
    pid: process.ppid,
    host: hostname(),
    token: randomUUID(),
    osStartTime: null,
  });
  await plant(owner);
  const controller = new AbortController();
  const reason = new Error('stop waiting');
  setTimeout(() => {
    controller.abort(reason);
  }, 100);
  await expect(acquireWorktreeAdminLock(common, { signal: controller.signal })).rejects.toBe(
    reason,
  );
  expect(await readdir(dirname(lockPath))).toEqual(['worktree-admin.lock']);
  expect(await readdir(lockPath)).toEqual(['owner.json']);
  expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(owner);
});

it('refuses a remote owner after the stuck deadline, naming the lock and host', async () => {
  await plant({ pid: 4242, host: 'elsewhere.invalid' });
  const started = Date.now();
  const refusal = acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 100 });
  await expect(refusal).rejects.toThrow(lockPath);
  await expect(refusal).rejects.toThrow('PID 4242 on elsewhere.invalid, another host');
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(await readdir(dirname(lockPath))).toEqual(['worktree-admin.lock']);
});

it('refuses unreadable ownership metadata after the stuck deadline', async () => {
  await plant('{ torn');
  await expect(acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 50 })).rejects.toThrow(
    `${lockPath} is held by an owner whose metadata is incomplete or unreadable`,
  );
});

it('refuses a dead owner whose recoverer is on another host after the stuck deadline', async () => {
  await plant({ pid: deadPid() }, { pid: 4343, host: 'elsewhere.invalid' });
  await expect(acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 50 })).rejects.toThrow(
    'recoverer PID 4343 on elsewhere.invalid, another host',
  );
  expect(await readdir(lockPath)).toEqual(['owner.json', 'recovery.json']);
});

it('refuses to release a lock whose owner changed, and a later acquire still never hangs', async () => {
  const release = await acquireWorktreeAdminLock(common, { signal });
  const replaced = { pid: process.pid, host: hostname(), token: randomUUID(), osStartTime: null };
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify(replaced));
  await expect(release()).rejects.toThrow(`${lockPath} ownership was lost`);
  expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toEqual(replaced);
  // The replacement names this process under a token it does not hold, so it is reclaimed.
  const again = await acquireWorktreeAdminLock(common, { signal, stuckAfterMs: 0 });
  await again();
  await expectNoResidue();
});

it('waits for a live recoverer without a stuck deadline', async () => {
  // A dead owner whose lock the (live) parent of this test process is recovering.
  await plant({ pid: deadPid() }, { pid: process.ppid });
  const controller = new AbortController();
  const reason = new Error('stop waiting');
  setTimeout(() => {
    controller.abort(reason);
  }, 100);
  await expect(
    acquireWorktreeAdminLock(common, { signal: controller.signal, stuckAfterMs: 0 }),
  ).rejects.toBe(reason);
  expect(await readdir(lockPath)).toEqual(['owner.json', 'recovery.json']);
});

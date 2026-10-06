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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeUnlock, removeObservedLock } from '../src/workflow/runtime/lock.js';
import { WorktreeAdminLockRefusedError } from '../src/workflow/runtime/run-errors.js';
import {
  acquireWorktreeAdminLock,
  inspectWorktreeAdminLock,
  unlockWorktreeAdminLock,
  worktreeAdminLockPath,
} from '../src/workflow/runtime/worktree-admin-lock.js';
import { holdAdminLock } from './worktree-admin-holder.js';

let common: string, lockPath: string;
beforeEach(async () => {
  common = await realpath(await mkdtemp(join(tmpdir(), 'choir-admin-lock-')));
  lockPath = worktreeAdminLockPath(common);
});
afterEach(async () => {
  vi.restoreAllMocks();
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
  owner: { pid: number; host?: string; token?: string; released?: boolean } | string,
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

/** The stuck refusal's message: it names the unlock command and never a manual removal. */
async function stuckMessage(stuckAfterMs: number): Promise<string> {
  const error = await acquireWorktreeAdminLock(common, { signal, stuckAfterMs }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  const text = (error as Error).message;
  expect(text).not.toContain(`remove ${lockPath}`);
  return text;
}

it('refuses a remote owner after the stuck deadline, naming the lock, host and unlock command', async () => {
  await plant({ pid: 4242, host: 'elsewhere.invalid' });
  const started = Date.now();
  const text = await stuckMessage(100);
  expect(text).toContain(lockPath);
  expect(text).toContain('PID 4242 on elsewhere.invalid, another host');
  expect(text).toContain(
    `clear it with quiet-choir workflow unlock --worktree-admin ${common} --force-remote.`,
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(await readdir(dirname(lockPath))).toEqual(['worktree-admin.lock']);
});

it('refuses unreadable ownership metadata after the stuck deadline, naming the unlock command', async () => {
  await plant('{ torn');
  const text = await stuckMessage(50);
  expect(text).toContain(
    `${lockPath} is held by an owner whose metadata is incomplete or unreadable`,
  );
  expect(text).toContain(`clear it with quiet-choir workflow unlock --worktree-admin ${common}.`);
});

it('refuses a dead owner whose recoverer is on another host after the stuck deadline', async () => {
  await plant({ pid: deadPid() }, { pid: 4343, host: 'elsewhere.invalid' });
  const text = await stuckMessage(50);
  expect(text).toContain('recoverer PID 4343 on elsewhere.invalid, another host');
  expect(text).toContain(`workflow unlock --worktree-admin ${common} --force-remote.`);
  expect(await readdir(lockPath)).toEqual(['owner.json', 'recovery.json']);
});

it('tells the operator to wait for or stop a local holder of unknown liveness before unlocking', async () => {
  const pid = deadPid();
  // kill(pid, 0) fails with EPERM: some process exists under that PID.
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((target, sig) => {
    if (target === pid) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return kill(target, sig);
  });
  await plant({ pid });
  const text = await stuckMessage(50);
  expect(text).toContain(
    `PID ${String(pid)} on ${hostname()}, whose liveness cannot be determined`,
  );
  expect(text).toContain(
    `Unlock refuses while PID ${String(pid)} may still exist on this machine: wait for it to exit or stop it, then clear the lock with quiet-choir workflow unlock --worktree-admin ${common}.`,
  );
  expect(text).not.toContain('--force-remote');
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

/** An unlock refusal's error, asserting it is a worktree.locked refusal that names the command. */
async function refusal(forceRemote = false): Promise<WorktreeAdminLockRefusedError> {
  const error = await unlockWorktreeAdminLock({ commonGitDir: common, forceRemote }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorktreeAdminLockRefusedError);
  const refused = error as WorktreeAdminLockRefusedError;
  expect(refused.code).toBe('worktree.locked');
  return refused;
}

describe('inspectWorktreeAdminLock', () => {
  it('reports nothing when the lock is not held', async () => {
    expect(await inspectWorktreeAdminLock(common)).toBeUndefined();
  });

  it('reports a live holder in another process with its token and acquisition time', async () => {
    const holder = holdAdminLock(common, 'forever');
    try {
      await holder.held;
      const view = await inspectWorktreeAdminLock(common);
      const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
        token: string;
      };
      expect(view).toEqual({
        commonGitDir: common,
        path: lockPath,
        owner: {
          pid: holder.child.pid,
          host: hostname(),
          token: owner.token,
          state: 'alive',
          osStartTime: null,
          acquiredAt: expect.any(String) as unknown,
        },
        recovery: null,
      });
      expect(new Date(view?.owner?.acquiredAt ?? '').toISOString()).toBe(view?.owner?.acquiredAt);
      // Unlock refuses the live holder and leaves the lock in place.
      const refused = await refusal(true);
      expect(refused.details).toMatchObject({
        lockPath,
        commonGitDir: common,
        role: 'owner',
        pid: holder.child.pid,
        state: 'alive',
      });
      expect(await readdir(lockPath)).toEqual(['owner.json']);
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });

  it.for([
    ['dead', () => ({ pid: deadPid() })],
    ['released', () => ({ pid: process.pid, released: true })],
    ['remote', () => ({ pid: 4242, host: 'elsewhere.invalid' })],
  ] as const)('reports a %s owner', async ([state, owner]) => {
    await plant(owner());
    expect(await inspectWorktreeAdminLock(common)).toMatchObject({
      owner: { state },
      recovery: null,
    });
  });

  it('reports unreadable ownership metadata as a warning with no owner', async () => {
    await plant('{ torn');
    const view = await inspectWorktreeAdminLock(common);
    expect(view).toMatchObject({ owner: null, recovery: null });
    expect(view?.warning).toMatch(/^owner\.json: /u);
  });

  it('reports a dead owner with a remote recoverer', async () => {
    await plant({ pid: deadPid() }, { pid: 4343, host: 'elsewhere.invalid' });
    expect(await inspectWorktreeAdminLock(common)).toMatchObject({
      owner: { state: 'dead' },
      recovery: { pid: 4343, host: 'elsewhere.invalid', state: 'remote' },
    });
  });
});

describe('unlockWorktreeAdminLock', () => {
  it('returns no lock when none is held', async () => {
    expect(await unlockWorktreeAdminLock({ commonGitDir: common })).toEqual({
      commonGitDir: common,
      lockPath,
      lock: null,
    });
  });

  it('removes a dead owner and its dead recoverer without residue', async () => {
    const pid = deadPid();
    await plant({ pid }, { pid });
    expect(await unlockWorktreeAdminLock({ commonGitDir: common })).toEqual({
      commonGitDir: common,
      lockPath,
      lock: {
        path: lockPath,
        owner: { pid, host: hostname(), state: 'dead' },
        recovery: { pid, host: hostname(), state: 'dead' },
        action: 'removed',
      },
    });
    await expectNoResidue();
  });

  it('removes a released owner', async () => {
    await plant({ pid: process.pid, released: true });
    expect((await unlockWorktreeAdminLock({ commonGitDir: common })).lock).toMatchObject({
      owner: { pid: process.pid, state: 'released' },
      action: 'removed',
    });
    await expectNoResidue();
  });

  it('removes unreadable ownership metadata with a warning', async () => {
    await plant('{ torn');
    const { lock } = await unlockWorktreeAdminLock({ commonGitDir: common });
    expect(lock).toMatchObject({ owner: null, recovery: null, action: 'removed' });
    expect(lock?.warning).toMatch(/^owner\.json: /u);
    await expectNoResidue();
  });

  it('refuses a local owner of unknown liveness even with forceRemote', async () => {
    const pid = deadPid();
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((target, sig) => {
      if (target === pid) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return kill(target, sig);
    });
    await plant({ pid });
    const refused = await refusal(true);
    expect(refused.message).toContain('is unverifiable; unlock never stops a process');
    expect(refused.details).toMatchObject({ role: 'owner', pid, state: 'unknown' });
    expect(await readdir(lockPath)).toEqual(['owner.json']);
  });

  it('refuses a remote owner without forceRemote, naming --force-remote, and removes it with it', async () => {
    await plant({ pid: deadPid(), host: 'elsewhere.invalid' });
    const refused = await refusal();
    expect(refused.message).toContain(
      `rerun with quiet-choir workflow unlock --worktree-admin ${common} --force-remote.`,
    );
    expect(refused.details).toMatchObject({
      lockPath,
      commonGitDir: common,
      role: 'owner',
      host: 'elsewhere.invalid',
      state: 'remote',
      next: [
        {
          why: 'Only if elsewhere.invalid is this machine under an old name or is permanently gone.',
          argv: ['quiet-choir', 'workflow', 'unlock', '--worktree-admin', common, '--force-remote'],
        },
      ],
    });
    expect(await readdir(lockPath)).toEqual(['owner.json']);
    expect(
      (await unlockWorktreeAdminLock({ commonGitDir: common, forceRemote: true })).lock,
    ).toMatchObject({ owner: { host: 'elsewhere.invalid', state: 'dead' }, action: 'removed' });
    await expectNoResidue();
  });

  it('refuses a remote recoverer over a dead owner without forceRemote', async () => {
    await plant({ pid: deadPid() }, { pid: deadPid(), host: 'elsewhere.invalid' });
    const refused = await refusal();
    expect(refused.details).toMatchObject({ role: 'recovery', state: 'remote' });
    expect(await readdir(lockPath)).toEqual(['owner.json', 'recovery.json']);
  });

  it('names the plain command, behind the given launcher, for a live local holder', async () => {
    await plant({ pid: process.ppid });
    const error = await unlockWorktreeAdminLock({
      commonGitDir: common,
      commandLauncher: ['node', '/abs/bin/run.js'],
    }).catch((cause: unknown) => cause as WorktreeAdminLockRefusedError);
    expect(error).toBeInstanceOf(WorktreeAdminLockRefusedError);
    expect((error as WorktreeAdminLockRefusedError).details).toMatchObject({
      state: 'alive',
      next: [
        {
          argv: ['node', '/abs/bin/run.js', 'workflow', 'unlock', '--worktree-admin', common],
        },
      ],
    });
  });

  it('refuses with changed and keeps the new lock when the owner changes before removal', async () => {
    await plant({ pid: deadPid() });
    const observed = await observeUnlock('worktree-admin', lockPath, null);
    const replacement = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      osStartTime: null,
    });
    await writeFile(join(lockPath, 'owner.json'), replacement);
    const changed = new Error('changed during unlock');
    if (observed === undefined) throw new Error('The planted lock was not observed.');
    await expect(removeObservedLock(observed, () => changed)).rejects.toBe(changed);
    expect(await readdir(dirname(lockPath))).toEqual(['worktree-admin.lock']);
    expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(replacement);
  });
});

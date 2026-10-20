import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processIdentity } from '../src/processes/identity.js';
import { markOwnerReleased, publishLock, type Owner } from '../src/workflow/runtime/lock.js';
import { OrphanProcessesError } from '../src/workflow/runtime/process-registry.js';
import { lockRun } from '../src/workflow/runtime/store.js';

// Each hook runs once, just before the first matching call, which then proceeds for real.
type Operation = 'open' | 'readFile' | 'rename';
interface Hook {
  readonly operation: Operation;
  readonly matches: (path: string, target?: string) => boolean;
  readonly before: () => unknown;
}
const hooks = vi.hoisted(() => ({ current: undefined as Hook | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  // The lock module names every path as a string.
  const named = (path: unknown): string => (typeof path === 'string' ? path : '');
  const fire = async (operation: Operation, path: unknown, target?: unknown): Promise<void> => {
    const hook = hooks.current;
    if (
      hook?.operation === operation &&
      hook.matches(named(path), target === undefined ? undefined : named(target))
    ) {
      hooks.current = undefined;
      await hook.before();
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof fs.open>) => {
      await fire('open', args[0]);
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      await fire('readFile', args[0]);
      return actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fire('rename', args[0], args[1]);
      return actual.rename(...args);
    },
  };
});

const temporaryName = /^owner\.[0-9a-f-]{36}\.tmp$/u;

let root: string, lockPath: string, tombstone: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-released-owner-'));
  lockPath = join(root, 'lock');
  tombstone = `${lockPath}.gone`;
});
afterEach(async () => {
  const unfired = hooks.current;
  hooks.current = undefined;
  await rm(root, { recursive: true, force: true });
  // Every armed hook must have run, or its interleaving was never exercised.
  expect(unfired).toBeUndefined();
});

function owner(): Owner {
  return { pid: process.pid, host: hostname(), token: randomUUID(), osStartTime: null };
}

/** Run `before` once, just before the helper opens its temporary file in `at`. */
function beforeTemporaryOpen(at: string, before: () => unknown): void {
  hooks.current = {
    operation: 'open',
    matches: (path) => path.startsWith(`${at}/`) && temporaryName.test(basename(path)),
    before,
  };
}

/** Run `before` once, just before `owner.json` in `at` is read while a temporary file sits there. */
function beforeVerifyRead(at: string, before: () => unknown): void {
  hooks.current = {
    operation: 'readFile',
    matches: (path) =>
      path === join(at, 'owner.json') && readdirSync(at).some((name) => temporaryName.test(name)),
    before,
  };
}

/** Run `before` once, just before a temporary file is renamed onto `owner.json` in `at`. */
function beforeFinalRename(at: string, before: () => unknown): void {
  hooks.current = {
    operation: 'rename',
    matches: (from, to) => temporaryName.test(basename(from)) && to === join(at, 'owner.json'),
    before,
  };
}

/** A mismatching retire moves the lock at `at` aside, and a third owner publishes a new one there. */
function swap(at: string, third: Owner): () => Promise<void> {
  return async () => {
    await rename(at, `${at}.gone`);
    expect(await publishLock(at, third)).toBe('published');
  };
}

/** The lock at `at` is exactly what `publishLock` wrote for `third`: never marked released. */
async function expectUntouched(at: string, third: Owner): Promise<void> {
  expect(await readdir(at)).toEqual(['owner.json']);
  expect(await readFile(join(at, 'owner.json'), 'utf8')).toBe(JSON.stringify(third));
}

async function ownerJson(at: string): Promise<unknown> {
  return JSON.parse(await readFile(join(at, 'owner.json'), 'utf8'));
}

async function expectAbsent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('markOwnerReleased', () => {
  it('marks the verified owner released, leaves no temporary file and is idempotent', async () => {
    const a = owner();
    await publishLock(lockPath, a);
    await expect(markOwnerReleased(lockPath, a)).resolves.toBe('released');
    expect(await ownerJson(lockPath)).toEqual({ ...a, released: true });
    expect(await readdir(lockPath)).toEqual(['owner.json']);
    // A repeated orphan release under the same token stays a success.
    await expect(markOwnerReleased(lockPath, a)).resolves.toBe('released');
    expect(await ownerJson(lockPath)).toEqual({ ...a, released: true });
    expect(await readdir(lockPath)).toEqual(['owner.json']);
  });

  it('reports a lock carrying another token as changed and leaves it alone', async () => {
    const a = owner();
    const other = owner();
    await publishLock(lockPath, other);
    await expect(markOwnerReleased(lockPath, a)).resolves.toBe('changed');
    await expectUntouched(lockPath, other);
  });

  it.for([
    ['unparseable', 'not json'],
    ['missing', undefined],
  ] as const)('reports %s metadata in a present lock as changed', async ([, content]) => {
    await mkdir(lockPath);
    if (content !== undefined) await writeFile(join(lockPath, 'owner.json'), content);
    await expect(markOwnerReleased(lockPath, owner())).resolves.toBe('changed');
    expect(await readdir(lockPath)).toEqual(content === undefined ? [] : ['owner.json']);
  });

  it('never marks a lock released that a swap published before the temporary file', async () => {
    const a = owner();
    const c = owner();
    await publishLock(lockPath, a);
    // The temporary file lands in the third owner's lock; the check then sees its token.
    beforeTemporaryOpen(lockPath, swap(lockPath, c));
    await expect(markOwnerReleased(lockPath, a)).resolves.toBe('changed');
    await expectUntouched(lockPath, c);
    expect(await readdir(tombstone)).toEqual(['owner.json']);
    expect(await ownerJson(tombstone)).toEqual(a);
  });

  it('fails with ENOENT and creates nothing when the lock is moved away before the temporary file', async () => {
    const a = owner();
    await publishLock(lockPath, a);
    beforeTemporaryOpen(lockPath, () => rename(lockPath, tombstone));
    await expect(markOwnerReleased(lockPath, a)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectAbsent(lockPath);
    expect(await ownerJson(tombstone)).toEqual(a);
  });

  it('never marks a lock released that a swap published between the temporary file and the check', async () => {
    const a = owner();
    const c = owner();
    await publishLock(lockPath, a);
    beforeVerifyRead(lockPath, swap(lockPath, c));
    await expect(markOwnerReleased(lockPath, a)).resolves.toBe('changed');
    await expectUntouched(lockPath, c);
    // The verified lock keeps its owner unreleased; its stranded temporary file leaves with it.
    expect(await ownerJson(tombstone)).toEqual(a);
  });

  it('never marks a lock released that a swap published between the check and the rename', async () => {
    const a = owner();
    const c = owner();
    await publishLock(lockPath, a);
    // The rename's unique source is in the moved lock, so it cannot land in the new one.
    beforeFinalRename(lockPath, swap(lockPath, c));
    await expect(markOwnerReleased(lockPath, a)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectUntouched(lockPath, c);
    expect(await ownerJson(tombstone)).toEqual(a);
  });

  it('keeps ENOENT and never re-creates a lock removed before the call', async () => {
    const a = owner();
    await publishLock(lockPath, a);
    await rm(lockPath, { recursive: true });
    await expect(markOwnerReleased(lockPath, a)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectAbsent(lockPath);
    expect(await readdir(root)).toEqual([]);
  });

  it.for([
    ['the check', beforeVerifyRead],
    ['the rename', beforeFinalRename],
  ] as const)(
    'keeps ENOENT and never re-creates a lock removed just before %s',
    async ([, before]) => {
      const a = owner();
      await publishLock(lockPath, a);
      before(lockPath, () => rm(lockPath, { recursive: true }));
      await expect(markOwnerReleased(lockPath, a)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectAbsent(lockPath);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('removes the temporary file and keeps the errno when the final rename fails', async () => {
    const a = owner();
    await publishLock(lockPath, a);
    beforeFinalRename(lockPath, () => {
      throw Object.assign(new Error('EACCES: injected, rename'), { code: 'EACCES' });
    });
    await expect(markOwnerReleased(lockPath, a)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readdir(lockPath)).toEqual(['owner.json']);
    expect(await ownerJson(lockPath)).toEqual(a);
  });
});

describe.skipIf(process.platform === 'win32')('run lock orphan release', () => {
  /** Lock run `kids` with a live detached child recorded, then run `test` on its primary lock. */
  async function withOrphan(
    test: (lock: Awaited<ReturnType<typeof lockRun>>, primary: string) => Promise<void>,
  ): Promise<void> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      if (!child.pid) throw new Error('Missing fixture PID');
      const lock = await lockRun(root, 'kids');
      await lock.trackProcess(
        { runId: 'kids', stepId: 'step', attempt: 1 },
        {
          pid: child.pid,
          pgid: child.pid,
          binary: 'sleeper',
          cwd: root,
          startedAt: new Date().toISOString(),
          osStartTime: processIdentity(child.pid)?.start ?? null,
        },
      );
      try {
        await test(lock, join(root, 'kids', 'lock'));
      } finally {
        hooks.current = undefined;
        await lock().catch(() => undefined);
      }
    } finally {
      const exited = once(child, 'exit');
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
  }

  it.for([
    ['the temporary file', beforeTemporaryOpen],
    ['the check', beforeVerifyRead],
  ] as const)(
    'reports lost ownership instead of releasing a lock swapped in before %s',
    async ([, before]) => {
      await withOrphan(async (lock, primary) => {
        const c = owner();
        before(primary, swap(primary, c));
        const error = await lock.releaseOwner().then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(hooks.current).toBeUndefined();
        expect(error).not.toBeInstanceOf(OrphanProcessesError);
        expect(error).toMatchObject({ message: 'Run kids lock ownership was lost.' });
        await expectUntouched(primary, c);
      });
    },
  );

  it('fails with ENOENT instead of releasing a lock swapped in before the rename', async () => {
    await withOrphan(async (lock, primary) => {
      const c = owner();
      beforeFinalRename(primary, swap(primary, c));
      await expect(lock.releaseOwner()).rejects.toMatchObject({ code: 'ENOENT' });
      expect(hooks.current).toBeUndefined();
      await expectUntouched(primary, c);
    });
  });
});

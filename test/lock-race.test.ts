import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { lockRun } from '../src/workflow/runtime/store.js';
import { processIdentity } from '../src/processes/identity.js';
import { OrphanProcessesError } from '../src/workflow/runtime/process-registry.js';
import { openFileOwnedRun } from '../src/workflow/runtime/run-store.js';

// Locks are published and retired by rename (ADR 0030), so no process may ever see a lock directory
// without a complete owner.json. Separate processes race here, not one event loop.
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-lock-race-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const children = 4;
const cycles = 50;

type Observation = 'absent' | 'owned' | { readonly violation: string };

/**
 * One look at a lock path. A missing or unparseable owner.json counts only when the same directory
 * (inode and ctime) was there before and after the read, so a lock retired mid-look is not blamed.
 */
async function observe(path: string): Promise<Observation> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch {
    return 'absent';
  }
  let names: string[] = [];
  try {
    names = await readdir(path);
  } catch {
    // Retired between the lstat and the listing; judged by the second lstat below.
  }
  try {
    JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    return 'owned';
  } catch (error) {
    let after;
    try {
      after = await lstat(path, { bigint: true });
    } catch {
      return 'absent';
    }
    if (after.ino !== before.ino || after.ctimeNs !== before.ctimeNs) return 'absent';
    return { violation: `${path} [${names.join(', ')}]: ${String(error)}` };
  }
}

// measured: 0.9 s alone, 2.3 s in the full coverage run, 8.5-14.6 s with 6-10 copies running in
// parallel (four tsx child startups and 200 contended cycles dominate).
it(
  'never exposes a lock without a readable owner.json to 200 racing acquire/release cycles',
  { timeout: 15_000 },
  async () => {
    const childPath = fileURLToPath(new URL('./lock-race-child.mjs', import.meta.url));
    const paths = [join(stateDir, 'race', 'lock'), join(stateDir, 'race.json.lock')];
    const results = Array.from({ length: children }, () => {
      const child = fork(childPath, [stateDir, 'race', String(cycles)], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stderr = '';
      let acquired = 0;
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('message', (message) => {
        if (typeof message === 'object' && 'acquired' in message)
          acquired = Number(message.acquired);
      });
      return new Promise<{ code: number | null; stderr: string; acquired: number }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => {
            resolve({ code, stderr, acquired });
          });
        },
      );
    });
    const racing = { running: true };
    const exited = Promise.all(results).finally(() => {
      racing.running = false;
    });
    const violations: string[] = [];
    let owned = 0;
    while (racing.running)
      for (const path of paths) {
        const observation = await observe(path);
        if (observation === 'owned') owned++;
        else if (observation !== 'absent') violations.push(observation.violation);
      }
    const outcomes = await exited;
    for (const outcome of outcomes) {
      expect(outcome.code, outcome.stderr).toBe(0);
      expect(outcome.acquired).toBe(cycles);
    }
    expect(violations).toEqual([]);
    expect(owned).toBeGreaterThan(0);
    expect(await readdir(stateDir)).toEqual(['.gitignore', 'race']);
    expect(await readdir(join(stateDir, 'race'))).toEqual([]);
  },
);

it('releaseOwner gives up only the primary lock and keeps writers out until the guard goes', async () => {
  const primary = join(stateDir, 'held', 'lock');
  const guard = join(stateDir, 'held.json.lock');
  const lock = await lockRun(stateDir, 'held');
  await lock.releaseOwner();
  // At most once: a second call neither retires anything nor throws.
  await lock.releaseOwner();
  await expect(lstat(primary)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await lstat(guard)).isDirectory()).toBe(true);
  // The guard is still held by this live process, so a new writer is refused before the primary.
  await expect(lockRun(stateDir, 'held')).rejects.toMatchObject({ code: 'run.locked' });
  await expect(lstat(primary)).rejects.toMatchObject({ code: 'ENOENT' });
  // The full release now releases only the guard; the primary is not released twice.
  await lock();
  await expect(lstat(guard)).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await lockRun(stateDir, 'held');
  await next();
  expect(await readdir(stateDir)).toEqual(['.gitignore', 'held']);
});

it.each([
  ['dead', { pid: 2_000_000_000, host: hostname(), token: 'stale', osStartTime: null }],
  ['released', { pid: process.pid, host: hostname(), token: 'stale', released: true }],
] as const)(
  'reclaimStale: false refuses a %s owner without touching its lock; the default reclaims it',
  async (_state, owner) => {
    const primary = join(stateDir, 'held', 'lock');
    const guard = join(stateDir, 'held.json.lock');
    for (const lock of [guard, primary]) {
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
    }
    const refusal = { code: 'run.locked', details: { pid: owner.pid, next: [{}] } };
    await expect(lockRun(stateDir, 'held', { reclaimStale: false })).rejects.toMatchObject(refusal);
    for (const lock of [guard, primary]) {
      expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))).toEqual(owner);
      expect(await readdir(lock)).toEqual(['owner.json']);
    }
    // Through the owned store: the guard is taken and released again, the primary left alone.
    await rm(guard, { recursive: true });
    await expect(openFileOwnedRun(stateDir, 'held', { reclaimStale: false })).rejects.toMatchObject(
      refusal,
    );
    await expect(lstat(guard)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(primary, 'owner.json'), 'utf8'))).toEqual(owner);
    const release = await lockRun(stateDir, 'held');
    expect(JSON.parse(await readFile(join(primary, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    await release();
  },
);

it.skipIf(process.platform === 'win32')(
  'releaseOwner refuses live children once, and the full release then frees only the guard',
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      if (!child.pid) throw new Error('Missing fixture PID');
      const lock = await lockRun(stateDir, 'kids');
      await lock.trackProcess(
        { runId: 'kids', stepId: 'step', attempt: 1 },
        {
          pid: child.pid,
          pgid: child.pid,
          binary: 'sleeper',
          cwd: stateDir,
          startedAt: new Date().toISOString(),
          osStartTime: processIdentity(child.pid)?.start ?? null,
        },
      );
      await expect(lock.releaseOwner()).rejects.toBeInstanceOf(OrphanProcessesError);
      await lock();
      // The primary keeps its child records under a released owner; the guard is gone.
      const owner: unknown = JSON.parse(
        await readFile(join(stateDir, 'kids', 'lock', 'owner.json'), 'utf8'),
      );
      expect(owner).toMatchObject({ pid: process.pid, released: true });
      await expect(lstat(join(stateDir, 'kids.json.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      const exited = once(child, 'exit');
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
  },
);

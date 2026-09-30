import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonValue } from '../src/workflow/runtime/json.js';
import { classifyRecovery } from '../src/workflow/runtime/recovery-decision.js';
import { inspectRunOwnership, lockRun, readRun, writeRun } from '../src/workflow/runtime/store.js';
import type { RunRecord, StepRecord } from '../src/workflow/runtime/store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
  };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');

let stateDir: string;

function record(id = 'run-1'): RunRecord {
  return {
    formatVersion: 1,
    id,
    workflow: { name: 'test', version: '1', fingerprint: null },
    cwd: stateDir,
    input: { count: 1 },
    output: null,
    status: 'running',
    error: null,
    steps: {},
    createdAt: '2026-09-07T12:00:00.000Z',
    updatedAt: '2026-09-07T12:00:00.000Z',
  };
}

function step(): StepRecord {
  return {
    kind: 'step',
    fingerprint: 'abc',
    status: 'completed',
    attempts: 1,
    output: { value: 1 },
    error: null,
    wakeAt: null,
  };
}

function deadPid(): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });
}

/** Fail `process.kill(pid, 0)` with the given errno for the listed PIDs; others are real. */
function pids(codes: Record<number, string>): void {
  const real = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const code = codes[pid];
    if (code) throw Object.assign(new Error(code), { code });
    return real(pid, signal);
  });
}

/** Run `before` (then the real rename) for the first rename whose destination matches. */
function onRename(
  matches: (from: string, to: string) => boolean,
  before: (from: string, to: string) => Promise<void> | void,
  after?: (from: string, to: string) => Promise<void> | void,
): void {
  let done = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (done || !matches(String(from), String(to))) return actualFs.rename(from, to);
    done = true;
    await before(String(from), String(to));
    try {
      await actualFs.rename(from, to);
    } finally {
      await after?.(String(from), String(to));
    }
  });
}

async function abandonedLock(owner: object): Promise<string> {
  const path = join(stateDir, 'run-1.json.lock');
  await fs.mkdir(path);
  await fs.writeFile(join(path, 'owner.json'), JSON.stringify(owner));
  return path;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(join(tmpdir(), 'quiet-choir-store-'));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe('checkpoint storage', () => {
  it('cleans only the acquired run’s abandoned UUID temp files', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const stale = `run-1.json.${uuid}.tmp`;
    const preserved = [
      'run-1.json',
      'run-1.json.notes.tmp',
      `run-2.json.${uuid}.tmp`,
      `run-1.json.${uuid}.tmp.backup`,
      'notes.tmp',
    ];
    for (const name of [stale, ...preserved]) await fs.writeFile(join(stateDir, name), 'keep');
    const foreignRelease = await lockRun(stateDir, 'run-2');
    // A live foreign writer may be in the middle of an atomic write.
    await fs.writeFile(join(stateDir, `run-2.json.${uuid}.tmp`), 'live');
    const release = await lockRun(stateDir, 'run-1');
    try {
      await expect(fs.access(join(stateDir, stale))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const name of preserved)
        await expect(fs.access(join(stateDir, name))).resolves.toBeUndefined();
      await fs.writeFile(join(stateDir, stale), 'active');
      await expect(lockRun(stateDir, 'run-1')).rejects.toThrow('locked by PID');
      expect(await fs.readFile(join(stateDir, stale), 'utf8')).toBe('active');
    } finally {
      await release();
      await foreignRelease();
    }
    const nextRelease = await lockRun(stateDir, 'run-1');
    await nextRelease();
    await expect(fs.access(join(stateDir, stale))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('round-trips and atomically replaces complete checkpoints with private permissions', async () => {
    const original = record();
    await writeRun(stateDir, original);
    expect(await readRun({ stateDir, runId: original.id })).toEqual(original);
    const updated: RunRecord = { ...original, status: 'completed', output: { done: true } };
    await writeRun(stateDir, updated);
    expect(await readRun({ stateDir, runId: original.id })).toEqual(updated);
    expect(await fs.readdir(stateDir)).toEqual(['run-1.json']);
    expect((await fs.stat(join(stateDir, 'run-1.json'))).mode & 0o777).toBe(0o600);
  });

  it('preserves prototype-related JSON data and step IDs across validation', async () => {
    const saved = record();
    saved.input = jsonValue(JSON.parse('{"__proto__":{"safe":true}}'));
    Object.defineProperty(saved.steps, '__proto__', { value: step(), enumerable: true });
    Object.defineProperty(saved.steps, 'constructor', { value: step(), enumerable: true });
    await writeRun(stateDir, saved);
    const loaded = await readRun({ stateDir, runId: saved.id });
    expect(JSON.stringify(loaded.input)).toBe(JSON.stringify(saved.input));
    expect(Object.hasOwn(loaded.steps, '__proto__')).toBe(true);
    expect(loaded.steps['__proto__']).toEqual(step());
    expect(Object.getPrototypeOf(loaded.steps)).toBe(Object.prototype);
  });

  it.each(['', '../escape', '/absolute', '.hidden', 'a/b', 'a'.repeat(129)])(
    'rejects unsafe run ID %s before accessing storage',
    async (id) => {
      await expect(readRun({ stateDir, runId: id })).rejects.toThrow(/Run ID/);
      await expect(lockRun(stateDir, id)).rejects.toThrow(/Run ID/);
      await expect(writeRun(stateDir, record(id))).rejects.toThrow(/Run ID/);
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it('rejects corrupt JSON, incompatible formats, mismatched IDs and invalid step data', async () => {
    const path = join(stateDir, 'run-1.json');
    for (const content of [
      '{bad',
      JSON.stringify({ ...record(), formatVersion: 2 }),
      JSON.stringify({ ...record(), id: 'another-run' }),
      JSON.stringify({ ...record(), steps: { broken: { ...step(), attempts: -1 } } }),
      JSON.stringify({ ...record(), steps: JSON.parse('{"__proto__":"invalid"}') as unknown }),
    ]) {
      await fs.writeFile(path, content);
      await expect(readRun({ stateDir, runId: 'run-1' })).rejects.toThrow();
    }
  });

  it('leaves the old checkpoint intact and cleans temporary files if writing fails', async () => {
    const original = record();
    await writeRun(stateDir, original);
    const { open: realOpen } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
      return handle;
    });
    await expect(writeRun(stateDir, { ...original, output: 'new' })).rejects.toThrow('disk full');
    expect(await readRun({ stateDir, runId: original.id })).toEqual(original);
    expect(await fs.readdir(stateDir)).toEqual(['run-1.json']);
  });

  it('cleans temporary files if the atomic rename fails', async () => {
    await fs.mkdir(join(stateDir, 'run-1.json'));
    await expect(writeRun(stateDir, record())).rejects.toThrow();
    expect(await fs.readdir(stateDir)).toEqual(['run-1.json']);
  });

  it('rejects invalid in-memory checkpoint data before replacing a valid file', async () => {
    await writeRun(stateDir, record());
    await expect(writeRun(stateDir, { ...record(), input: { bad: Infinity } })).rejects.toThrow(
      /lossless JSON/,
    );
    expect(await readRun({ stateDir, runId: 'run-1' })).toEqual(record());
  });
});

describe('local run ownership', () => {
  it('excludes a live owner, releases ownership, and permits reacquisition', async () => {
    const release = await lockRun(stateDir, 'run-1');
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/locked by PID/);
    await release();
    const releaseAgain = await lockRun(stateDir, 'run-1');
    await releaseAgain();
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1']);
  });

  it('acquires the legacy guard for a brand-new run, excluding a pre-format-7 binary, and leaves no lock behind after release', async () => {
    const legacyLockPath = join(stateDir, 'run-3.json.lock');
    await fs.mkdir(legacyLockPath);
    await fs.writeFile(
      join(legacyLockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), token: 'pre-format-7' }),
    );
    await expect(lockRun(stateDir, 'run-3')).rejects.toMatchObject({ code: 'run.locked' });
    await fs.rm(legacyLockPath, { recursive: true });
    const release = await lockRun(stateDir, 'run-3');
    await release();
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-3']);
    expect(await fs.readdir(join(stateDir, 'run-3'))).toEqual([]);
  });

  it('creates the state directory when acquiring the first run', async () => {
    const nested = join(stateDir, 'new', 'state');
    const release = await lockRun(nested, 'valid_ID-2');
    await release();
    expect(await fs.readdir(nested)).toEqual(['.gitignore', 'valid_ID-2']);
  });

  it('recovers only a confirmed dead owner on this host', async () => {
    await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    deadPid();
    const release = await lockRun(stateDir, 'run-1');
    const owner: unknown = JSON.parse(
      await fs.readFile(join(stateDir, 'run-1.json.lock', 'owner.json'), 'utf8'),
    );
    expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    expect(owner).not.toMatchObject({ token: 'old' });
    await release();
  });

  it('refuses remote and permission-inaccessible owners instead of assuming they died', async () => {
    const path = await abandonedLock({ pid: 12345, host: 'another-host', token: 'old' });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/another-host/);
    await fs.writeFile(
      join(path, 'owner.json'),
      JSON.stringify({ pid: 12345, host: hostname(), token: 'old' }),
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/locked by PID/);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  it('takes over an empty lock left by an older build’s interrupted acquire', async () => {
    const path = join(stateDir, 'run-1.json.lock');
    await fs.mkdir(path);
    const release = await lockRun(stateDir, 'run-1');
    expect(JSON.parse(await fs.readFile(join(path, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
      host: hostname(),
    });
    await release();
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1']);
  });

  it('keeps missing or corrupt ownership metadata in a non-empty lock for manual inspection', async () => {
    const path = join(stateDir, 'run-1.json.lock');
    await fs.mkdir(join(path, 'recovery'), { recursive: true });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/incomplete ownership/);
    await fs.writeFile(join(path, 'owner.json'), '{bad');
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/incomplete ownership/);
    expect((await fs.readdir(path)).sort()).toEqual(['owner.json', 'recovery']);
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1.json.lock']);
  });

  it('does not delete a lock when its ownership token changed', async () => {
    const release = await lockRun(stateDir, 'run-1');
    const path = join(stateDir, 'run-1', 'lock');
    await fs.writeFile(
      join(path, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), token: 'replacement' }),
    );
    await expect(release()).rejects.toThrow(/ownership was lost/);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  it('rechecks ownership after claiming recovery and preserves a replacement lock', async () => {
    const path = await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      writeFileSync(
        join(path, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), token: 'replacement' }),
      );
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/ownership changed during recovery/);
    expect(await fs.readdir(path)).toEqual(['owner.json']);
  });
});

describe('lock publication and release by rename', () => {
  const lockFor = (from: string, to: string): boolean =>
    from.endsWith('.tmp') && to.endsWith('run-1.json.lock');

  it('looks again when a contended lock is released before its owner can be read', async () => {
    const path = await abandonedLock({ pid: process.pid, host: hostname(), token: 'live' });
    onRename(
      lockFor,
      () => undefined,
      async () => {
        await actualFs.rm(path, { recursive: true });
      },
    );
    const release = await lockRun(stateDir, 'run-1');
    expect(JSON.parse(await fs.readFile(join(path, 'owner.json'), 'utf8'))).not.toMatchObject({
      token: 'live',
    });
    await release();
  });

  it('judges a lock replaced between two looks by its new owner, not as incomplete', async () => {
    const path = await abandonedLock({ pid: process.pid, host: hostname(), token: 'live' });
    let missed = false;
    vi.mocked(fs.readFile).mockImplementation(async (file, options) => {
      // The first look races a release; by the second, a complete new lock has been published.
      if (!missed && file === join(path, 'owner.json')) {
        missed = true;
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return actualFs.readFile(file, options);
    });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/locked by PID/);
    expect(missed).toBe(true);
  });

  it('treats a Windows EPERM rename as contention only when the lock exists', async () => {
    const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const path = await abandonedLock({ pid: process.pid, host: hostname(), token: 'live' });
    vi.mocked(fs.rename).mockRejectedValueOnce(eperm());
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/locked by PID/);
    await fs.rm(path, { recursive: true });
    vi.mocked(fs.rename).mockRejectedValueOnce(eperm());
    await expect(lockRun(stateDir, 'run-1')).rejects.toMatchObject({ code: 'EPERM' });
    // The publish directory never outlives a failed acquire.
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore']);
  });

  it('renames a tombstone back and refuses when its owner changed during recovery', async () => {
    const path = await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    const replacement = JSON.stringify({ pid: process.pid, host: hostname(), token: 'new' });
    pids({ 12345: 'ESRCH' });
    onRename(
      (from, to) => from === path && to.endsWith('.gone'),
      () => {
        writeFileSync(join(path, 'owner.json'), replacement);
      },
    );
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/ownership changed during recovery/);
    expect(await fs.readFile(join(path, 'owner.json'), 'utf8')).toBe(replacement);
    // Our recovery marker is removed; no tombstone or publish directory remains.
    expect(await fs.readdir(path)).toEqual(['owner.json']);
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1.json.lock']);
  });

  it('renames a release tombstone back when its token changed, and treats a swept one as retired', async () => {
    const release = await lockRun(stateDir, 'run-1');
    const path = join(stateDir, 'run-1', 'lock');
    const replacement = JSON.stringify({ pid: process.pid, host: hostname(), token: 'new' });
    onRename(
      (from, to) => from === path && to.endsWith('.gone'),
      () => {
        writeFileSync(join(path, 'owner.json'), replacement);
      },
    );
    await expect(release()).rejects.toThrow(/ownership was lost/);
    expect(await fs.readFile(join(path, 'owner.json'), 'utf8')).toBe(replacement);
    expect(await fs.readdir(join(stateDir, 'run-1'))).toEqual(['lock']);
    await fs.rm(path, { recursive: true });

    const next = await lockRun(stateDir, 'run-1');
    // A new owner may sweep a tombstone before its retirer verifies it.
    onRename(
      (from, to) => from === path && to.endsWith('.gone'),
      () => undefined,
      async (_from, to) => {
        await actualFs.rm(to, { recursive: true });
      },
    );
    await next();
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1']);
    expect(await fs.readdir(join(stateDir, 'run-1'))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'sweeps stray tombstones and dead creators’ publish directories next to both locks',
    async () => {
      const run = join(stateDir, 'run-1');
      await fs.mkdir(run);
      const dead = 999_991;
      const plant = async (directory: string, name: string): Promise<string> => {
        await fs.mkdir(join(directory, name));
        await fs.writeFile(join(directory, name, 'owner.json'), '{}');
        return name;
      };
      const kept: [string, string][] = [];
      const swept: [string, string][] = [];
      const locked: string[] = [];
      for (const [directory, base] of [
        [run, 'lock'],
        [stateDir, 'run-1.json.lock'],
      ] as const) {
        swept.push([
          directory,
          await plant(directory, `${base}.${String(dead)}.${randomUUID()}.tmp`),
        ]);
        swept.push([
          directory,
          await plant(directory, `${base}.${String(dead)}.${randomUUID()}.gone`),
        ]);
        swept.push([
          directory,
          await plant(directory, `${base}.${String(process.pid)}.${randomUUID()}.gone`),
        ]);
        kept.push([
          directory,
          await plant(directory, `${base}.${String(process.pid)}.${randomUUID()}.tmp`),
        ]);
        kept.push([directory, await plant(directory, `${base}.notes.tmp`)]);
        kept.push([directory, await plant(directory, `${base}.${String(dead)}.not-a-uuid.gone`)]);
        // A tombstone that cannot be removed must not block ownership.
        const stuck = await plant(directory, `${base}.${String(dead)}.${randomUUID()}.gone`);
        await fs.chmod(join(directory, stuck), 0o500);
        locked.push(join(directory, stuck));
      }
      kept.push([
        stateDir,
        await plant(stateDir, `run-2.json.lock.${String(dead)}.${randomUUID()}.gone`),
      ]);
      pids({ [dead]: 'ESRCH' });
      try {
        const release = await lockRun(stateDir, 'run-1');
        for (const [directory, name] of swept)
          await expect(fs.access(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
        for (const [directory, name] of kept)
          await expect(fs.access(join(directory, name))).resolves.toBeUndefined();
        for (const path of locked) await expect(fs.access(path)).resolves.toBeUndefined();
        await release();
      } finally {
        for (const path of locked) await fs.chmod(path, 0o700);
      }
    },
  );
});

describe('recovery markers', () => {
  const marker = (pid: number, host = hostname(), token = 'theirs') => ({ pid, host, token });
  async function recovering(recovery: object | string): Promise<string> {
    const path = await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    await fs.writeFile(
      join(path, 'recovery.json'),
      typeof recovery === 'string' ? recovery : JSON.stringify(recovery),
    );
    return path;
  }

  it.each<[string, object | string, Record<number, string>]>([
    ['alive', marker(process.pid), {}],
    ['unknown', marker(23456), { 23456: 'EPERM' }],
    ['remote', marker(34567, 'another-host'), {}],
    ['unreadable', '{bad', {}],
  ])('respects an %s recoverer’s marker', async (_, value, codes) => {
    const path = await recovering(value);
    const before = await fs.readFile(join(path, 'recovery.json'), 'utf8');
    pids({ 12345: 'ESRCH', ...codes });
    await expect(lockRun(stateDir, 'run-1')).rejects.toMatchObject({
      code: 'run.locked',
      message: expect.stringContaining('lock recovery is in progress') as unknown,
    });
    expect(await fs.readFile(join(path, 'recovery.json'), 'utf8')).toBe(before);
    expect((await fs.readdir(path)).sort()).toEqual(['owner.json', 'recovery.json']);
  });

  it('reclaims a dead recoverer’s marker and acquires the lock', async () => {
    const path = await recovering(marker(45678));
    pids({ 12345: 'ESRCH', 45678: 'ESRCH' });
    const release = await lockRun(stateDir, 'run-1');
    expect(JSON.parse(await fs.readFile(join(path, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    expect(await fs.readdir(path)).toEqual(['owner.json']);
    await release();
    expect(await fs.readdir(stateDir)).toEqual(['.gitignore', 'run-1']);
  });

  it('ignores an older build’s recovery directory', async () => {
    const path = await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    await fs.mkdir(join(path, 'recovery'));
    deadPid();
    const release = await lockRun(stateDir, 'run-1');
    expect(await fs.readdir(path)).toEqual(['owner.json']);
    await release();
  });

  it('never steals a marker that replaced the dead one during reclaim', async () => {
    const path = await recovering(marker(45678, hostname(), 'dead-one'));
    const replacement = JSON.stringify(marker(process.pid, hostname(), 'replacement'));
    const real = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 45678) writeFileSync(join(path, 'recovery.json'), replacement);
      if (pid === 12345 || pid === 45678)
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      return real(pid, signal);
    });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(
      /ownership changed during recovery; retry/,
    );
    expect(await fs.readFile(join(path, 'recovery.json'), 'utf8')).toBe(replacement);
    expect((await fs.readdir(path)).sort()).toEqual(['owner.json', 'recovery.json']);
  });

  it('leaves a displaced marker aside when a newer one wins the name during reclaim', async () => {
    const path = await recovering(marker(45678, hostname(), 'dead-one'));
    const newer = JSON.stringify(marker(process.pid, hostname(), 'newer'));
    pids({ 12345: 'ESRCH', 45678: 'ESRCH' });
    onRename(
      (_from, to) => to.endsWith('.stale'),
      (from) => {
        // Between the liveness judgment and the take, the dead marker was replaced...
        writeFileSync(from, JSON.stringify(marker(process.pid, hostname(), 'middle')));
      },
      (from) => {
        // ...and yet another recoverer published while it was aside.
        writeFileSync(from, newer);
      },
    );
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/ownership changed during recovery/);
    expect(await fs.readFile(join(path, 'recovery.json'), 'utf8')).toBe(newer);
    expect((await fs.readdir(path)).filter((name) => name.endsWith('.stale'))).toHaveLength(1);
  });
});

describe('lock inspection', () => {
  async function write(path: string, name: string, value: object | string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  const primary = () => join(stateDir, 'run-1', 'lock');
  const guard = () => join(stateDir, 'run-1.json.lock');

  it('lists the primary lock and the guard of a held run', async () => {
    const release = await lockRun(stateDir, 'run-1');
    const alive = { pid: process.pid, host: hostname(), state: 'alive' };
    expect(await inspectRunOwnership({ stateDir, runId: 'run-1' })).toEqual({
      locked: true,
      owner: alive,
      processes: [],
      locks: [
        { kind: 'primary', path: primary(), owner: alive, recovery: null },
        { kind: 'guard', path: guard(), owner: alive, recovery: null },
      ],
    });
    await release();
    expect(await inspectRunOwnership({ stateDir, runId: 'run-1' })).toEqual({
      locked: false,
      owner: null,
      processes: [],
      locks: [],
    });
  });

  it('holds a run whose primary owner is dead while the guard owner lives', async () => {
    await write(primary(), 'owner.json', { pid: 12345, host: hostname(), token: 'a' });
    await write(guard(), 'owner.json', { pid: process.pid, host: hostname(), token: 'b' });
    pids({ 12345: 'ESRCH' });
    const ownership = await inspectRunOwnership({ stateDir, runId: 'run-1' });
    expect(ownership.owner).toEqual({ pid: 12345, host: hostname(), state: 'dead' });
    expect(ownership.locks.map((lock) => [lock.kind, lock.owner?.state])).toEqual([
      ['primary', 'dead'],
      ['guard', 'alive'],
    ]);
    expect(classifyRecovery(ownership)).toBe('held');
  });

  it('reports a dead recoverer’s marker as reclaimable', async () => {
    await write(primary(), 'owner.json', { pid: 12345, host: hostname(), token: 'a' });
    await write(guard(), 'owner.json', { pid: 12345, host: hostname(), token: 'b' });
    await write(guard(), 'recovery.json', { pid: 45678, host: 'h2', token: 'c' });
    pids({ 12345: 'ESRCH', 45678: 'ESRCH' });
    const remote = await inspectRunOwnership({ stateDir, runId: 'run-1' });
    expect(remote.locks[1]?.recovery).toEqual({ pid: 45678, host: 'h2', state: 'remote' });
    expect(classifyRecovery(remote)).toBe('held');
    await write(guard(), 'recovery.json', { pid: 45678, host: hostname(), token: 'c' });
    const ownership = await inspectRunOwnership({ stateDir, runId: 'run-1' });
    expect(ownership.locks[1]?.recovery).toEqual({ pid: 45678, host: hostname(), state: 'dead' });
    expect(classifyRecovery(ownership)).toBe('reclaimable');
  });

  it('warns about unreadable owner or recovery metadata in a lock', async () => {
    await write(primary(), 'owner.json', '{bad');
    await write(guard(), 'owner.json', { pid: 12345, host: hostname(), token: 'b' });
    await write(guard(), 'recovery.json', '{bad');
    const ownership = await inspectRunOwnership({ stateDir, runId: 'run-1' });
    expect(ownership).toMatchObject({ locked: true, owner: null });
    expect(ownership.warning).toBeDefined();
    const [first, second] = ownership.locks;
    expect(first).toMatchObject({ kind: 'primary', owner: null, recovery: null });
    expect(first?.warning).toMatch(/^owner\.json: /u);
    expect(second).toMatchObject({ kind: 'guard', recovery: null });
    expect(second?.warning).toMatch(/^recovery\.json: /u);
    expect(classifyRecovery(ownership)).toBe('held');
  });
});

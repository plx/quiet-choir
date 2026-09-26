import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonValue } from '../src/workflow/runtime/json.js';
import { lockRun, readRun, writeRun } from '../src/workflow/runtime/store.js';
import type { RunRecord, StepRecord } from '../src/workflow/runtime/store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

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
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it('creates the state directory when acquiring the first run', async () => {
    const nested = join(stateDir, 'new', 'state');
    const release = await lockRun(nested, 'valid_ID-2');
    await release();
    expect(await fs.readdir(nested)).toEqual([]);
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

  it('keeps incomplete or corrupt ownership metadata for manual inspection', async () => {
    const path = join(stateDir, 'run-1.json.lock');
    await fs.mkdir(path);
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/incomplete ownership/);
    await fs.writeFile(join(path, 'owner.json'), '{bad');
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/incomplete ownership/);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  it('does not delete a lock when its ownership token changed', async () => {
    const release = await lockRun(stateDir, 'run-1');
    const path = join(stateDir, 'run-1.json.lock');
    await fs.writeFile(
      join(path, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), token: 'replacement' }),
    );
    await expect(release()).rejects.toThrow(/ownership was lost/);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  it('allows only one contender to recover an abandoned lock', async () => {
    const path = await abandonedLock({ pid: 12345, host: hostname(), token: 'old' });
    await fs.mkdir(join(path, 'recovery'));
    deadPid();
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(/recovery is in progress/);
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

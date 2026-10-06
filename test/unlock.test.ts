import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { defineWorkflow, runWorkflow, z } from '../src/index.js';
import { groupState, processIdentity } from '../src/processes/identity.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { formatArgv, type CommandLauncher } from '../src/workflow/runtime/commands.js';
import { unlockRun } from '../src/workflow/runtime/lock.js';
import { OrphanProcessesError } from '../src/workflow/runtime/process-registry.js';
import { lockRun } from '../src/workflow/runtime/store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    readdir: vi.fn(actual.readdir),
  };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');

const DEAD = 2_000_000_000;
let stateDir: string;
let primary: string;
let guard: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  // Mock implementations outlive a test; start each from the real functions.
  vi.mocked(fs.rename).mockImplementation(actualFs.rename);
  vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  vi.mocked(fs.readdir).mockImplementation(actualFs.readdir);
  stateDir = await fs.mkdtemp(join(tmpdir(), 'quiet-choir-unlock-'));
  primary = join(stateDir, 'run-1', 'lock');
  guard = join(stateDir, 'run-1.json.lock');
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && groupState({ pid: child.pid, pgid: child.pid }) !== 'dead') {
      const ended = once(child, 'exit');
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* reaped already */
      }
      await ended;
    }
  }
  await actualFs.rm(stateDir, { recursive: true, force: true });
});

interface Planted {
  readonly owner?: object | string | null;
  readonly recovery?: object | string;
  readonly files?: Record<string, string>;
}

/** Create a lock directory with the given owner.json, recovery.json and other files. */
async function plant(path: string, planted: Planted = {}): Promise<void> {
  await fs.mkdir(path, { recursive: true });
  const write = (name: string, value: object | string): Promise<void> =>
    fs.writeFile(join(path, name), typeof value === 'string' ? value : JSON.stringify(value));
  if (planted.owner !== null) await write('owner.json', planted.owner ?? owner(DEAD, 'old'));
  if (planted.recovery !== undefined) await write('recovery.json', planted.recovery);
  for (const [name, value] of Object.entries(planted.files ?? {})) {
    await fs.mkdir(join(path, name, '..'), { recursive: true });
    await write(name, value);
  }
}

function owner(pid: number, token: string, host = hostname(), extra: object = {}): object {
  return { pid, host, token, ...extra };
}

/** Every file below a directory with its contents, to prove a refusal changed nothing. */
async function snapshot(path: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await actualFs.readdir(path, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      entries[file] = await actualFs.readFile(file, 'utf8');
    }
  return entries;
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

/** Run `before` (then the real rename) for the first rename of `path` to a tombstone. */
function onTombstone(path: string, before: () => Promise<void> | void): void {
  let done = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (done || String(from) !== path || !String(to).endsWith('.gone'))
      return actualFs.rename(from, to);
    done = true;
    await before();
    return actualFs.rename(from, to);
  });
}

function unlock(forceRemote = false) {
  return unlockRun({ runId: 'run-1', stateDir, forceRemote });
}

async function gone(path: string): Promise<boolean> {
  return actualFs.lstat(path).then(
    () => false,
    () => true,
  );
}

function processRecord(pid: number, token: string, osStartTime: string | null = null): object {
  return {
    pid,
    pgid: pid,
    binary: 'fake-harness',
    cwd: stateDir,
    startedAt: new Date().toISOString(),
    osStartTime,
    runId: 'run-1',
    stepId: 'review',
    attempt: 1,
    ownerToken: token,
  };
}

describe('unlockRun removal', () => {
  it('removes a dead owner’s lock pair through tombstones and reports each lock', async () => {
    await plant(primary);
    await plant(guard);
    const locks = await unlock();
    expect(locks).toEqual([
      {
        kind: 'primary',
        path: primary,
        owner: { pid: DEAD, host: hostname(), state: 'dead' },
        recovery: null,
        processes: [],
        action: 'removed',
      },
      {
        kind: 'guard',
        path: guard,
        owner: { pid: DEAD, host: hostname(), state: 'dead' },
        recovery: null,
        processes: [],
        action: 'removed',
      },
    ]);
    expect(await fs.readdir(stateDir)).toEqual(['run-1']);
    expect(await fs.readdir(join(stateDir, 'run-1'))).toEqual([]);
    // Only tombstones were deleted: never the live lock path.
    const removed = vi.mocked(fs.rm).mock.calls.map(([path]) => String(path));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((path) => /\.\d+\.[0-9a-f-]+\.gone$/u.test(path))).toBe(true);
    expect(removed).not.toContain(primary);
    expect(removed).not.toContain(guard);
  });

  it('removes a released owner whose children are dead, and returns an empty list when unlocked', async () => {
    await plant(primary, {
      owner: owner(process.pid, 'mine', hostname(), { released: true }),
      files: { [`processes/${String(DEAD)}.json`]: JSON.stringify(processRecord(DEAD, 'mine')) },
    });
    const [lock] = await unlock();
    expect(lock).toMatchObject({
      owner: { pid: process.pid, state: 'released' },
      processes: [{ file: `${String(DEAD)}.json`, state: 'dead' }],
      action: 'removed',
    });
    expect(await gone(primary)).toBe(true);
    expect(await unlock()).toEqual([]);
  });

  it('removes a metadata-less older-build lock and a dead recoverer’s marker, with warnings', async () => {
    await plant(guard, { owner: null, files: { stray: 'x' } });
    await plant(primary, { recovery: owner(DEAD + 1, 'marker') });
    const locks = await unlock();
    expect(locks).toMatchObject([
      {
        kind: 'primary',
        owner: { state: 'dead' },
        recovery: { pid: DEAD + 1, host: hostname(), state: 'dead' },
        action: 'removed',
      },
      { kind: 'guard', owner: null, recovery: null, action: 'removed' },
    ]);
    expect(locks[0]).not.toHaveProperty('warning');
    expect(locks[1]?.warning).toMatch(/owner\.json: missing/u);
    expect(await gone(primary)).toBe(true);
    expect(await gone(guard)).toBe(true);
  });

  it('removes unreadable owner and marker metadata, reporting both', async () => {
    await plant(primary, { owner: '{bad', recovery: '{worse' });
    const [lock] = await unlock();
    expect(lock).toMatchObject({ owner: null, recovery: null, action: 'removed' });
    expect(lock?.warning).toMatch(/^owner\.json: .+; recovery\.json: .+/u);
    expect(await gone(primary)).toBe(true);
  });

  it('clears a foreign-host lock only with forceRemote, judging it locally', async () => {
    const foreign = `${hostname()}-gone`;
    await plant(primary, { owner: owner(DEAD, 'far', foreign) });
    await plant(guard, { owner: owner(DEAD, 'far', foreign) });
    const refusal = unlock();
    await expect(refusal).rejects.toMatchObject({
      code: 'run.locked',
      details: { kind: 'primary', role: 'owner', pid: DEAD, host: foreign, state: 'remote' },
    });
    await expect(refusal).rejects.toThrow(
      `Run run-1 primary lock owner PID ${String(DEAD)} is on foreign host ${foreign}. If ${foreign} is this machine under an old name or is permanently gone, rerun with quiet-choir workflow unlock run-1 --state-dir ${stateDir} --force-remote.`,
    );
    expect(await gone(primary)).toBe(false);
    expect(await unlock(true)).toMatchObject([
      { kind: 'primary', owner: { host: foreign, state: 'dead' }, action: 'removed' },
      { kind: 'guard', owner: { host: foreign, state: 'dead' }, action: 'removed' },
    ]);
  });

  it('refuses a foreign recoverer without forceRemote', async () => {
    await plant(primary, { recovery: owner(DEAD, 'far', `${hostname()}-gone`) });
    await expect(unlock()).rejects.toMatchObject({
      code: 'run.locked',
      details: { role: 'recovery', state: 'remote' },
    });
    expect(await unlock(true)).toMatchObject([{ recovery: { state: 'dead' }, action: 'removed' }]);
  });
});

describe('unlockRun refusals', () => {
  it('refuses a live local owner and a live recoverer, removing nothing', async () => {
    const start = processIdentity(process.pid)?.start ?? null;
    await plant(primary, { owner: owner(process.pid, 'live', hostname(), { osStartTime: start }) });
    await plant(guard);
    const before = await snapshot(stateDir);
    const refusal = unlock(true);
    await expect(refusal).rejects.toMatchObject({
      code: 'run.locked',
      details: { lockPath: primary, role: 'owner', pid: process.pid, state: 'alive' },
    });
    await expect(refusal).rejects.toThrow(/is alive; unlock never stops a process\./u);
    expect(await snapshot(stateDir)).toEqual(before);

    await fs.writeFile(join(primary, 'owner.json'), JSON.stringify(owner(DEAD, 'old')));
    await fs.writeFile(join(guard, 'recovery.json'), JSON.stringify(owner(process.pid, 'rec')));
    await expect(unlock()).rejects.toMatchObject({
      code: 'run.locked',
      details: { lockPath: guard, kind: 'guard', role: 'recovery', state: 'alive' },
    });
    expect(await gone(primary)).toBe(false);
  });

  it('refuses an owner whose liveness cannot be verified', async () => {
    await plant(primary, { owner: owner(23_456, 'eperm') });
    pids({ 23_456: 'EPERM' });
    await expect(unlock()).rejects.toThrow(/owner PID 23456 on .+ is unverifiable/u);
    expect(await gone(primary)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses live children with the owner and records, leaving both locks intact',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', `console.log('ready'); setInterval(() => {}, 1000);`],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      children.push(child);
      await once(child.stdout, 'data');
      if (!child.pid) throw new Error('Missing fixture PID');
      const start = processIdentity(child.pid)?.start ?? null;
      expect(start).toBeTruthy();
      await plant(primary, {
        files: {
          [`processes/${String(child.pid)}.json`]: JSON.stringify(
            processRecord(child.pid, 'old', start),
          ),
        },
      });
      await plant(guard);
      const before = await snapshot(stateDir);
      const refusal = unlock();
      await expect(refusal).rejects.toBeInstanceOf(OrphanProcessesError);
      await expect(refusal).rejects.toMatchObject({
        code: 'run.orphans',
        details: {
          owner: { pid: DEAD, host: hostname(), state: 'dead' },
          processes: [{ file: `${String(child.pid)}.json`, state: 'alive' }],
        },
      });
      await expect(refusal).rejects.toThrow(
        new RegExp(
          `Owner PID ${String(DEAD)} on .+ \\(dead\\)\\..*workflow resume run-1 --state-dir .+ --kill-orphans\\.$`,
          'u',
        ),
      );
      expect(await snapshot(stateDir)).toEqual(before);
      // Nothing was renamed or deleted.
      expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.rm)).not.toHaveBeenCalled();

      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGKILL');
      await exited;
      expect(await unlock()).toMatchObject([
        { kind: 'primary', processes: [{ state: 'dead' }], action: 'removed' },
        { kind: 'guard', action: 'removed' },
      ]);
    },
  );

  it('observes a metadata-less lock’s children by identity instead of refusing them all', async () => {
    await plant(primary, {
      owner: null,
      files: {
        [`processes/${String(DEAD)}.json`]: JSON.stringify(processRecord(DEAD, 'lost-token')),
      },
    });
    expect(await unlock()).toMatchObject([
      { owner: null, processes: [{ state: 'dead', process: { ownerToken: 'lost-token' } }] },
    ]);
  });
});

describe('unlockRun races', () => {
  it('refuses when the owner changes between observation and removal, keeping the lock', async () => {
    await plant(primary);
    const replacement = JSON.stringify(owner(process.pid, 'new'));
    // Observation reads the process directory last; a new owner publishes right after.
    vi.mocked(fs.readdir).mockImplementation((async (path: string, options?: never) => {
      if (path === join(primary, 'processes'))
        writeFileSync(join(primary, 'owner.json'), replacement);
      return actualFs.readdir(path, options);
    }) as typeof fs.readdir);
    await expect(unlock()).rejects.toMatchObject({
      code: 'run.locked',
      message: 'Run run-1 lock ownership changed during unlock; retry.',
      details: { lockPath: primary },
    });
    expect(await fs.readFile(join(primary, 'owner.json'), 'utf8')).toBe(replacement);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });

  it.each<[string, (path: string) => void]>([
    [
      'a complete new owner replaced the empty lock',
      (path) => {
        writeFileSync(join(path, 'owner.json'), JSON.stringify(owner(process.pid, 'new')));
      },
    ],
    [
      'a recoverer linked its marker',
      (path) => {
        writeFileSync(join(path, 'recovery.json'), JSON.stringify(owner(process.pid, 'rec')));
      },
    ],
  ])('renames the tombstone back when %s just before the rename', async (_, change) => {
    await plant(guard, { owner: null });
    onTombstone(guard, () => {
      change(guard);
    });
    await expect(unlock()).rejects.toMatchObject({
      code: 'run.locked',
      message: expect.stringContaining('changed during unlock') as unknown,
    });
    // The lock is back in place with the new file, and no tombstone remains.
    expect((await fs.readdir(guard)).length).toBe(1);
    expect(await fs.readdir(stateDir)).toEqual(['run-1.json.lock']);
  });

  it('reports a lock that vanished before its rename as absent', async () => {
    await plant(primary);
    onTombstone(primary, () => actualFs.rm(primary, { recursive: true }));
    expect(await unlock()).toMatchObject([{ kind: 'primary', action: 'absent' }]);
  });

  it('reports a lock retired between observation and removal as absent', async () => {
    await plant(primary, { owner: null });
    vi.mocked(fs.readdir).mockImplementation((async (path: string, options?: never) => {
      if (path === join(primary, 'processes')) await actualFs.rm(primary, { recursive: true });
      return actualFs.readdir(path, options);
    }) as typeof fs.readdir);
    expect(await unlock()).toMatchObject([{ kind: 'primary', owner: null, action: 'absent' }]);
  });
});

describe('run.locked messages name workflow unlock', () => {
  const hint = (): string => `quiet-choir workflow unlock run-1 --state-dir ${stateDir}`;

  it('for incomplete metadata', async () => {
    await plant(guard, { owner: null, files: { stray: 'x' } });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(
      `Run run-1 is locked with incomplete ownership metadata (damage or an older build); after confirming no process owns ${guard}, clear it with ${hint()}.`,
    );
  });

  it('for a live and a foreign owner', async () => {
    await plant(guard, { owner: owner(process.pid, 'live') });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(
      `Run run-1 is locked by PID ${String(process.pid)} on ${hostname()}. Wait for it or stop it; ${hint()} clears the lock only once that owner is gone.`,
    );
    await fs.writeFile(join(guard, 'owner.json'), JSON.stringify(owner(DEAD, 'far', 'elsewhere')));
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(
      `Run run-1 is locked by PID ${String(DEAD)} on elsewhere. If elsewhere is this machine under an old name or is permanently gone, clear it with ${hint()} --force-remote.`,
    );
  });

  it.each<[string, object | string, RegExp]>([
    [
      'live',
      owner(process.pid, 'rec'),
      /; retry, or once recoverer PID \d+ on .+ is gone, clear it with quiet-choir workflow unlock run-1 --state-dir .+\.$/u,
    ],
    [
      'foreign',
      owner(DEAD, 'rec', 'elsewhere'),
      /once recoverer PID \d+ on elsewhere is gone, clear it with quiet-choir workflow unlock run-1 --state-dir .+ --force-remote \(only if elsewhere/u,
    ],
    [
      'unreadable',
      '{bad',
      /; retry, or clear the damaged marker in .+ with quiet-choir workflow unlock run-1 --state-dir .+\.$/u,
    ],
  ])('for a %s recoverer', async (_, recovery, pattern) => {
    await plant(guard, { recovery });
    await expect(lockRun(stateDir, 'run-1')).rejects.toMatchObject({
      code: 'run.locked',
      message: expect.stringMatching(/^Run run-1 lock recovery is in progress/u) as unknown,
    });
    await expect(lockRun(stateDir, 'run-1')).rejects.toThrow(pattern);
  });
});

/** The launchers whose unlock argv must come out right: the default, an installed bin, a checkout. */
const noInstall = [process.execPath, '/abs/bin/run.js'];
const launchers: [string, CommandLauncher | undefined, readonly string[]][] = [
  ['the default launcher', undefined, ['quiet-choir']],
  ['an installed bin', ['quiet-choir'], ['quiet-choir']],
  ['a no-install checkout', noInstall, noInstall],
];

describe.each(launchers)('run.locked details.next under %s', (_, launcher, program) => {
  const argv = (forceRemote = false): string[] => [
    ...program,
    'workflow',
    'unlock',
    'run-1',
    '--state-dir',
    resolve(stateDir),
    ...(forceRemote ? ['--force-remote'] : []),
  ];
  const options = (): { commandLauncher?: CommandLauncher } =>
    launcher === undefined ? {} : { commandLauncher: launcher };
  const acquire = (): Promise<unknown> => lockRun(stateDir, 'run-1', options());
  const release = (forceRemote = false): Promise<unknown> =>
    unlockRun({ runId: 'run-1', stateDir, forceRemote, ...options() });

  /** The refusal's details.next must be exactly one entry, and the message must embed its argv. */
  async function expectNext(
    attempt: Promise<unknown>,
    forceRemote: boolean,
    why: RegExp,
  ): Promise<void> {
    const error = (await attempt.then(
      () => undefined,
      (caught: unknown) => caught,
    )) as { code?: string; message: string; details: { next?: unknown } } | undefined;
    expect(error?.code).toBe('run.locked');
    expect(error?.details.next).toEqual([
      { why: expect.stringMatching(why) as unknown, argv: argv(forceRemote) },
    ]);
    // Prose that names unlock embeds the very command it lists; the transient races and the live-holder
    // unlock refusal only list it.
    if (!/ownership changed|Could not acquire|is alive|unverifiable/u.test(error?.message ?? ''))
      expect(error?.message).toContain(formatArgv(argv(forceRemote)));
    expect(argv(forceRemote).includes('--force-remote')).toBe(forceRemote);
  }

  it('for incomplete metadata', async () => {
    await plant(guard, { owner: null, files: { stray: 'x' } });
    await expectNext(acquire(), false, /no process owns it/u);
  });

  it('for a live local owner and a foreign owner', async () => {
    await plant(guard, { owner: owner(process.pid, 'live') });
    await expectNext(acquire(), false, /has exited/u);
    await fs.writeFile(join(guard, 'owner.json'), JSON.stringify(owner(DEAD, 'far', 'elsewhere')));
    await expectNext(acquire(), true, /only if elsewhere is this machine/iu);
  });

  it.each<[string, object | string, boolean, RegExp]>([
    ['live', owner(process.pid, 'rec'), false, /recoverer PID \d+ on .+ has exited/u],
    ['foreign', owner(DEAD, 'rec', 'elsewhere'), true, /only if elsewhere is this machine/iu],
    ['unreadable', '{bad', false, /damaged recovery marker/u],
  ])('for a %s recoverer', async (_kind, recovery, forceRemote, why) => {
    await plant(guard, { recovery });
    await expectNext(acquire(), forceRemote, why);
  });

  it('for ownership that changed during recovery', async () => {
    await plant(guard, { owner: owner(DEAD, 'old') });
    onTombstone(guard, () => {
      writeFileSync(join(guard, 'owner.json'), JSON.stringify(owner(process.pid, 'new')));
    });
    await expectNext(acquire(), false, /never removes a live lock or signals/u);
  });

  it('for a lock that kept vanishing while it was acquired', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(to) === guard)
        throw Object.assign(new Error('exists'), { code: 'EEXIST' as const });
      return actualFs.rename(from, to);
    });
    const attempt = acquire();
    await expectNext(attempt, false, /never removes a live lock or signals/u);
    await expect(attempt).rejects.toThrow(/Could not acquire run run-1; retry/u);
  });

  it('from unlock for an alive or unverifiable holder, and for a foreign one', async () => {
    await plant(primary, { owner: owner(process.pid, 'live') });
    await expectNext(release(), false, /PID \d+ on .+ has exited/u);
    await fs.writeFile(join(primary, 'owner.json'), JSON.stringify(owner(23_457, 'eperm')));
    pids({ 23_457: 'EPERM' });
    await expectNext(release(), false, /has exited/u);
    await fs.writeFile(
      join(primary, 'owner.json'),
      JSON.stringify(owner(DEAD, 'far', 'elsewhere')),
    );
    await expectNext(release(), true, /only if elsewhere is this machine/iu);
    await fs.rm(primary, { recursive: true });
    await plant(primary, { recovery: owner(DEAD, 'far', 'elsewhere') });
    await expectNext(release(), true, /only if elsewhere is this machine/iu);
  });

  it('from unlock for ownership that changed during unlock', async () => {
    await plant(guard, { owner: null });
    onTombstone(guard, () => {
      writeFileSync(join(guard, 'recovery.json'), JSON.stringify(owner(process.pid, 'rec')));
    });
    await expectNext(release(), false, /never removes a live lock or signals/u);
  });
});

it('adds --force-remote to next only for a foreign holder', async () => {
  await plant(guard, { owner: owner(process.pid, 'live') });
  const local = await lockRun(stateDir, 'run-1').catch((error: unknown) => error);
  expect(JSON.stringify(local)).not.toContain('--force-remote');
  await fs.writeFile(join(guard, 'owner.json'), JSON.stringify(owner(DEAD, 'far', 'elsewhere')));
  const foreign = (await lockRun(stateDir, 'run-1').catch((error: unknown) => error)) as {
    details: { next: { argv: string[] }[] };
  };
  expect(foreign.details.next).toHaveLength(1);
  expect(foreign.details.next[0]?.argv.filter((word) => word === '--force-remote')).toHaveLength(1);
});

describe('runWorkflow refusals', () => {
  const definition = defineWorkflow({
    name: 'nap',
    version: '1',
    input: z.null(),
    output: z.null(),
    run() {
      return Promise.resolve(null);
    },
  });
  const embedded = (options: { commandLauncher?: CommandLauncher }): Promise<unknown> =>
    runWorkflow(definition, { stateDir, runId: 'run-1', input: null, ...options }).catch(
      (error: unknown) => error,
    );

  it('puts the embedder launcher in details.next, and the documented default without one', async () => {
    await plant(primary, { owner: owner(DEAD, 'far', 'elsewhere') });
    const launcher = [process.execPath, '/abs/bin/run.js'];
    for (const [options, program] of [
      [{ commandLauncher: launcher }, launcher],
      [{}, ['quiet-choir']],
    ] as const) {
      const refusal = (await embedded(options)) as { code: string; details: { next: unknown } };
      expect(refusal.code).toBe('run.locked');
      expect(refusal.details.next).toEqual([
        {
          why: expect.any(String) as unknown,
          argv: [
            ...program,
            'workflow',
            'unlock',
            'run-1',
            '--state-dir',
            resolve(stateDir),
            '--force-remote',
          ],
        },
      ]);
    }
  });
});

describe('workflow.unlock plan', () => {
  const executor = (): WorkflowExecutor =>
    new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });

  it('runs without workflow source and returns the result document', async () => {
    await plant(primary);
    expect(
      await executor().execute({
        kind: 'workflow.unlock',
        runId: 'run-1',
        stateDir,
        forceRemote: false,
      }),
    ).toEqual({
      kind: 'workflow.unlock.result',
      ok: true,
      runId: 'run-1',
      stateDir,
      forceRemote: false,
      locks: [
        {
          kind: 'primary',
          path: primary,
          owner: { pid: DEAD, host: hostname(), state: 'dead' },
          recovery: null,
          processes: [],
          action: 'removed',
        },
      ],
    });
  });

  it('is a no-op for a saved run without a lock and run.not_found for an unknown one', async () => {
    const plan = {
      kind: 'workflow.unlock',
      runId: 'run-1',
      stateDir,
      forceRemote: true,
    } as const;
    await expect(executor().execute(plan)).resolves.toMatchObject({
      ok: false,
      code: 'run.not_found',
      runId: 'run-1',
    });
    for (const checkpoint of [join(stateDir, 'run-1.json'), join(stateDir, 'run-1', 'run.json')]) {
      await fs.mkdir(join(stateDir, 'run-1'), { recursive: true });
      await fs.writeFile(checkpoint, '{}');
      await expect(executor().execute(plan)).resolves.toEqual({
        kind: 'workflow.unlock.result',
        ok: true,
        runId: 'run-1',
        stateDir,
        forceRemote: true,
        locks: [],
      });
      await fs.rm(checkpoint);
    }
  });

  it('maps a refusal to its code and details', async () => {
    await plant(primary, { owner: owner(DEAD, 'far', 'elsewhere') });
    await expect(
      executor().execute({ kind: 'workflow.unlock', runId: 'run-1', stateDir, forceRemote: false }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'run.locked',
      details: { host: 'elsewhere', state: 'remote' },
    });
    await expect(
      executor().execute({ kind: 'workflow.unlock', runId: '../x', stateDir, forceRemote: false }),
    ).resolves.toMatchObject({ ok: false, code: 'usage.run_id' });
  });
});

describe('workflow.unlock.worktree-admin plan', () => {
  const executor = (): WorkflowExecutor =>
    new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

  /** A repository with one commit and a linked worktree; returns the realpath of its common dir. */
  async function repository(): Promise<{ checkout: string; linked: string; common: string }> {
    const checkout = join(stateDir, 'repo');
    const linked = join(stateDir, 'linked');
    await fs.mkdir(checkout);
    git(checkout, 'init', '--quiet');
    git(
      checkout,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'init',
    );
    git(checkout, 'worktree', 'add', '--quiet', '--detach', linked);
    return { checkout, linked, common: await fs.realpath(join(checkout, '.git')) };
  }

  it('resolves a checkout, a linked worktree or the common dir to one lock and clears it', async () => {
    const { checkout, linked, common } = await repository();
    const lockPath = join(common, 'quiet-choir', 'worktree-admin.lock');
    for (const path of [checkout, linked, common]) {
      await plant(lockPath);
      await expect(
        executor().execute({ kind: 'workflow.unlock.worktree-admin', path, forceRemote: false }),
      ).resolves.toEqual({
        kind: 'workflow.unlock.worktree-admin.result',
        ok: true,
        commonGitDir: common,
        lockPath,
        forceRemote: false,
        lock: {
          path: lockPath,
          owner: { pid: DEAD, host: hostname(), state: 'dead' },
          recovery: null,
          action: 'removed',
        },
      });
      expect(await gone(lockPath)).toBe(true);
    }
    await expect(
      executor().execute({
        kind: 'workflow.unlock.worktree-admin',
        path: linked,
        forceRemote: true,
      }),
    ).resolves.toMatchObject({ ok: true, lock: null, forceRemote: true });
  });

  it('refuses a path outside any repository as a usage error', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'quiet-choir-not-a-repo-'));
    try {
      await expect(
        executor().execute({
          kind: 'workflow.unlock.worktree-admin',
          path: outside,
          forceRemote: false,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'usage.flag',
        runId: null,
        stateDir: null,
        message: expect.stringContaining(
          `--worktree-admin ${outside} is not inside a Git repository`,
        ) as unknown,
      });
    } finally {
      await actualFs.rm(outside, { recursive: true, force: true });
    }
  });

  it('maps a refusal to worktree.locked with details.next as the top-level next', async () => {
    const { checkout, common } = await repository();
    const lockPath = join(common, 'quiet-choir', 'worktree-admin.lock');
    await plant(lockPath, { owner: owner(DEAD, 'far', 'elsewhere.invalid') });
    const result = await executor().execute({
      kind: 'workflow.unlock.worktree-admin',
      path: checkout,
      forceRemote: false,
    });
    const next = [
      {
        why: 'Only if elsewhere.invalid is this machine under an old name or is permanently gone.',
        argv: ['quiet-choir', 'workflow', 'unlock', '--worktree-admin', common, '--force-remote'],
      },
    ];
    expect(result).toMatchObject({
      ok: false,
      code: 'worktree.locked',
      runId: null,
      stateDir: null,
      details: { lockPath, commonGitDir: common, host: 'elsewhere.invalid', state: 'remote', next },
      next,
    });
    expect(await gone(lockPath)).toBe(false);
  });
});

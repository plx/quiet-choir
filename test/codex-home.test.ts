import { fork, spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliHarness, HarnessError } from '../src/index.js';
import {
  codexAuthLockPath,
  decideWriteBack,
  prepareCodexHome,
  type WriteBackInput,
} from '../src/harnesses/codex-home.js';
import { materializeInvocation, planInvocation } from '../src/harnesses/invocation.js';
import { processIdentity } from '../src/processes/identity.js';
import { testInvocation } from './harness-invocation.js';

const secret = 'TOKEN_SECRET_MARKER_8812';
const auth = (lastRefresh: string | null, token = secret): string =>
  `${JSON.stringify({ tokens: { access_token: token }, ...(lastRefresh === null ? {} : { last_refresh: lastRefresh }) })}\n`;
const bytes = (text: string): Buffer => Buffer.from(text);

let root: string;
let realHome: string;
let locks: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-codex-home-')));
  realHome = join(root, 'real-home');
  locks = join(root, 'locks');
  await mkdir(realHome, { recursive: true });
  await mkdir(locks);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('write-back decision', () => {
  const original = bytes(auth('2026-09-01T00:00:00Z'));
  const older = bytes(auth('2026-09-02T00:00:00Z', 'older'));
  const newer = bytes(auth('2026-09-03T00:00:00Z', 'newer'));
  const untimed = bytes(auth(null, 'untimed'));
  it.each<[string, WriteBackInput, ReturnType<typeof decideWriteBack>]>([
    [
      'unchanged',
      { original, refreshed: original, real: original },
      { action: 'skip', reason: 'unchanged' },
    ],
    ['refreshed', { original, refreshed: newer, real: original }, { action: 'write' }],
    [
      'real changed to a newer file',
      { original, refreshed: older, real: newer },
      { action: 'keep-real' },
    ],
    [
      'real changed to an older file',
      { original, refreshed: newer, real: older },
      { action: 'keep-private' },
    ],
    [
      'real changed without last_refresh',
      { original, refreshed: newer, real: untimed },
      { action: 'keep-real' },
    ],
    [
      'private refreshed without last_refresh',
      { original, refreshed: untimed, real: newer },
      { action: 'keep-real' },
    ],
    [
      'real already holds the refreshed file',
      { original, refreshed: newer, real: newer },
      { action: 'skip', reason: 'already current' },
    ],
    ['real deleted', { original, refreshed: newer, real: null }, { action: 'keep-real' }],
    [
      'unparseable private',
      { original, refreshed: bytes('{"tokens": {"access'), real: original },
      { action: 'skip', reason: 'private unparseable' },
    ],
    [
      'private array',
      { original, refreshed: bytes('[1]'), real: original },
      { action: 'skip', reason: 'private unparseable' },
    ],
    [
      'original absent',
      { original: null, refreshed: newer, real: null },
      { action: 'skip', reason: 'original absent' },
    ],
    [
      'private missing',
      { original, refreshed: null, real: original },
      { action: 'skip', reason: 'private missing' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(decideWriteBack(input)).toEqual(expected);
  });
});

async function listing(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const info = await lstat(full);
      const mode = (info.mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        result[`${relative(path, full)}/`] = mode;
        await walk(full);
      } else if (entry.isSymbolicLink())
        result[relative(path, full)] = `${mode} -> ${await readlink(full)}`;
      else
        result[relative(path, full)] =
          `${mode} ${(await readFile(full)).toString('base64').slice(0, 64)}`;
    }
  };
  await walk(path);
  return result;
}

async function seedRealHome(credentials: string | null): Promise<void> {
  await writeFile(join(realHome, 'AGENTS.md'), 'USER_AGENTS_CANARY');
  await mkdir(join(realHome, 'skills', 'canary'), { recursive: true });
  await writeFile(join(realHome, 'skills', 'canary', 'SKILL.md'), 'skill');
  await writeFile(join(realHome, 'config.toml'), 'model = "x"\n');
  await writeFile(join(realHome, 'memories_1.sqlite'), 'memories', { mode: 0o640 });
  if (credentials !== null)
    await writeFile(join(realHome, 'auth.json'), credentials, { mode: 0o600 });
}

const withoutAuth = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'auth.json'));

describe('private home', () => {
  it('holds only a 0600 auth.json copy in a 0700 directory and removes it on dispose', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    expect(home.path.startsWith(tmpdir())).toBe(true);
    expect(home.path).not.toBe(realHome);
    expect(await readdir(home.path)).toEqual(['auth.json']);
    expect((await stat(home.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home.path, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home.path, 'auth.json'), 'utf8')).toBe(
      await readFile(join(realHome, 'auth.json'), 'utf8'),
    );
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    await expect(stat(home.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts empty without a source auth.json and never creates one', async () => {
    await seedRealHome(null);
    const before = await listing(realHome);
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    expect(await readdir(home.path)).toEqual([]);
    await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    expect(await listing(realHome)).toEqual(before);
  });

  it('writes a refreshed auth.json back atomically, keeping its mode, without temp or lock files', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    await chmod(join(realHome, 'auth.json'), 0o640);
    const before = await listing(realHome);
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    const refreshed = auth('2026-09-03T00:00:00Z', 'refreshed-token');
    await writeFile(join(home.path, 'auth.json'), refreshed);
    expect(await home.settle()).toEqual([]);
    // settle is idempotent; dispose does not write again.
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(refreshed);
    expect((await stat(join(realHome, 'auth.json'))).mode & 0o777).toBe(0o640);
    expect(withoutAuth(await listing(realHome))).toEqual(withoutAuth(before));
    expect(await readdir(locks)).toEqual([]);
  });

  it('writes through a symlinked auth.json to its target', async () => {
    const store = join(root, 'store');
    await mkdir(store);
    await writeFile(join(store, 'auth.json'), auth('2026-09-01T00:00:00Z'), { mode: 0o600 });
    await symlink(join(store, 'auth.json'), join(realHome, 'auth.json'));
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    expect((await lstat(join(home.path, 'auth.json'))).isFile()).toBe(true);
    const refreshed = auth('2026-09-03T00:00:00Z', 'refreshed-token');
    await writeFile(join(home.path, 'auth.json'), refreshed);
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    expect((await lstat(join(realHome, 'auth.json'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(store, 'auth.json'), 'utf8')).toBe(refreshed);
    expect(await readdir(store)).toEqual(['auth.json']);
  });

  it('skips a torn private auth.json', async () => {
    const original = auth('2026-09-01T00:00:00Z');
    await seedRealHome(original);
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    await writeFile(join(home.path, 'auth.json'), '{"tokens":{"access_token":"TOKEN_SECRET');
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
  });

  it('keeps newer real credentials and warns without naming their contents', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    const newer = auth('2026-09-05T00:00:00Z', `${secret}-newer`);
    await writeFile(join(realHome, 'auth.json'), newer);
    await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z', `${secret}-older`));
    const warnings = await home.settle();
    await home.dispose();
    expect(warnings).toEqual([expect.stringContaining('kept the newer credentials')]);
    expect(warnings[0]).toContain(realHome);
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(newer);
  });

  it.each(['dead', 'reused'] as const)('reclaims a lock whose owner PID is %s', async (owner) => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    const lock = codexAuthLockPath(realHome, locks);
    // A live PID whose OS birth identity differs from the recorded one belongs to someone else.
    const stale =
      owner === 'dead'
        ? { pid: Number(dead.stdout), start: null, nonce: 'old' }
        : { pid: process.pid, start: 'darwin:another-boot:another-start', nonce: 'old' };
    await writeFile(lock, JSON.stringify(stale));
    const home = await prepareCodexHome(realHome, { lockDirectory: locks });
    const refreshed = auth('2026-09-03T00:00:00Z', 'refreshed-token');
    await writeFile(join(home.path, 'auth.json'), refreshed);
    expect(await home.settle()).toEqual([]);
    await home.dispose();
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(refreshed);
    expect(await readdir(locks)).toEqual([]);
  });

  it('warns instead of failing when the lock stays held', async () => {
    const original = auth('2026-09-01T00:00:00Z');
    await seedRealHome(original);
    const lock = codexAuthLockPath(realHome, locks);
    const owner = JSON.stringify({
      pid: process.pid,
      start: processIdentity(process.pid)?.start ?? null,
      nonce: 'held',
    });
    await writeFile(lock, owner);
    const home = await prepareCodexHome(realHome, { lockDirectory: locks, lockTimeoutMs: 50 });
    await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
    const warnings = await home.settle();
    await home.dispose();
    expect(warnings).toEqual([expect.stringContaining('timed out waiting for the lock')]);
    expect(warnings[0]).toContain(lock);
    expect(warnings[0]).not.toContain('not a quiet-choir owner record');
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
    expect(await readFile(lock, 'utf8')).toBe(owner);
    await expect(stat(home.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const twoHoursAgo = (): Date => new Date(Date.now() - 2 * 60 * 60 * 1000);

  it.each(['', 'not json', '{"pid":"1"}'])(
    'reclaims an old unreadable lock %j at once and writes back',
    async (content) => {
      await seedRealHome(auth('2026-09-01T00:00:00Z'));
      const lock = codexAuthLockPath(realHome, locks);
      await writeFile(lock, content);
      await utimes(lock, twoHoursAgo(), twoHoursAgo());
      // Any wait would outlast the test timeout.
      const home = await prepareCodexHome(realHome, {
        lockDirectory: locks,
        lockTimeoutMs: 60_000,
      });
      const refreshed = auth('2026-09-03T00:00:00Z', 'refreshed-token');
      await writeFile(join(home.path, 'auth.json'), refreshed);
      const warnings = await home.settle();
      await home.dispose();
      expect(warnings).toEqual([expect.stringContaining('Reclaimed')]);
      expect(warnings[0]).toContain(lock);
      expect(warnings[0]).toContain('60 s');
      expect(JSON.stringify(warnings)).not.toContain(secret);
      expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(refreshed);
      expect(await readdir(locks)).toEqual([]);
    },
  );

  it('respects a recent unreadable lock until the timeout', async () => {
    const original = auth('2026-09-01T00:00:00Z');
    await seedRealHome(original);
    const lock = codexAuthLockPath(realHome, locks);
    await writeFile(lock, 'not json');
    const home = await prepareCodexHome(realHome, { lockDirectory: locks, lockTimeoutMs: 50 });
    await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
    const warnings = await home.settle();
    await home.dispose();
    expect(warnings).toEqual([expect.stringContaining('timed out waiting for the lock')]);
    expect(warnings[0]).toContain(lock);
    expect(warnings[0]).toContain(
      'not a quiet-choir owner record and will be reclaimed once older than 60 s',
    );
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
    expect(await readFile(lock, 'utf8')).toBe('not json');
  });

  it('reclaims a recent unreadable lock once it ages out during the wait', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const lock = codexAuthLockPath(realHome, locks);
    await writeFile(lock, 'not json');
    const home = await prepareCodexHome(realHome, {
      lockDirectory: locks,
      lockTimeoutMs: 10_000,
      unreadableLockAgeMs: 200,
    });
    const refreshed = auth('2026-09-03T00:00:00Z', 'refreshed-token');
    await writeFile(join(home.path, 'auth.json'), refreshed);
    const warnings = await home.settle();
    await home.dispose();
    expect(warnings).toEqual([expect.stringContaining('Reclaimed')]);
    expect(warnings[0]).toContain(lock);
    expect(warnings[0]).toContain('200 ms');
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(refreshed);
    expect(await readdir(locks)).toEqual([]);
  });

  it('never steals an old lock from a live foreign owner', async () => {
    const original = auth('2026-09-01T00:00:00Z');
    await seedRealHome(original);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      stdio: 'ignore',
    });
    try {
      const pid = sleeper.pid;
      if (pid === undefined) throw new Error('sleeper did not start');
      const lock = codexAuthLockPath(realHome, locks);
      const owner = JSON.stringify({
        pid,
        start: processIdentity(pid)?.start ?? null,
        nonce: 'foreign',
      });
      await writeFile(lock, owner);
      await utimes(lock, twoHoursAgo(), twoHoursAgo());
      const home = await prepareCodexHome(realHome, {
        lockDirectory: locks,
        lockTimeoutMs: 50,
        unreadableLockAgeMs: 1,
      });
      await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
      const warnings = await home.settle();
      await home.dispose();
      expect(warnings).toEqual([expect.stringContaining('timed out waiting for the lock')]);
      expect(warnings[0]).toContain(lock);
      expect(JSON.stringify(warnings)).not.toContain(secret);
      expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
      expect(await readFile(lock, 'utf8')).toBe(owner);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  // chflags lets an unprivileged owner make rename fail as another user's sticky-/tmp file would.
  it.runIf(process.platform === 'darwin')(
    'fails fast, naming the lock, when an old unreadable lock cannot be moved aside',
    async () => {
      const original = auth('2026-09-01T00:00:00Z');
      await seedRealHome(original);
      const lock = codexAuthLockPath(realHome, locks);
      await writeFile(lock, 'not json');
      await utimes(lock, twoHoursAgo(), twoHoursAgo());
      spawnSync('chflags', ['uchg', lock]);
      try {
        const home = await prepareCodexHome(realHome, {
          lockDirectory: locks,
          lockTimeoutMs: 60_000,
        });
        await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
        const warnings = await home.settle();
        await home.dispose();
        expect(warnings).toEqual([
          expect.stringContaining(`cannot move aside the lock ${lock} (EPERM)`),
        ]);
        expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
        expect(await readdir(locks)).toEqual([lock.slice(locks.length + 1)]);
      } finally {
        spawnSync('chflags', ['nouchg', lock]);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'names the lock path when the lock directory is not writable',
    async () => {
      const original = auth('2026-09-01T00:00:00Z');
      await seedRealHome(original);
      const lock = codexAuthLockPath(realHome, locks);
      const home = await prepareCodexHome(realHome, { lockDirectory: locks });
      await writeFile(join(home.path, 'auth.json'), auth('2026-09-03T00:00:00Z'));
      await chmod(locks, 0o500);
      try {
        const warnings = await home.settle();
        expect(warnings).toEqual([expect.stringContaining(`EACCES on the lock ${lock}`)]);
      } finally {
        await chmod(locks, 0o700);
        await home.dispose();
      }
      expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(original);
    },
  );

  it('refuses a private-home plan without a source CODEX_HOME', async () => {
    const request = {
      harness: 'codex' as const,
      cwd: root,
      outputSchema: null,
      options: { prompt: 'x', instructions: 'none' as const },
    };
    const plan = planInvocation(request);
    expect(plan.codexHome).toBe('private');
    await expect(materializeInvocation(plan, request)).rejects.toThrow('source CODEX_HOME');
  });
});

interface ChildResult {
  readonly warnings: readonly string[];
  readonly path: string;
}
function child(refreshed: string | null): {
  ready: Promise<void>;
  go: () => void;
  done: Promise<ChildResult>;
} {
  const path = fileURLToPath(new URL('./codex-home-child.mjs', import.meta.url));
  const process_ = fork(path, [realHome, locks, ...(refreshed === null ? [] : [refreshed])], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  process_.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = new Promise<ChildResult>((resolve, reject) => {
    let result: ChildResult | undefined;
    process_.on('message', (message: { ready?: boolean } & Partial<ChildResult>) => {
      if (message.ready) ready();
      else result = message as ChildResult;
    });
    process_.once('error', reject);
    process_.once('exit', (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`child exited ${String(code)}: ${stderr}`));
    });
  });
  return { ready: readyPromise, go: () => process_.send('go'), done };
}

// Fits the default timeout: 0.11-0.12 s alone and 0.14-0.22 s per case in the full coverage run.
describe('concurrent write-back across processes', () => {
  const original = auth('2026-09-01T00:00:00Z');
  const older = auth('2026-09-02T00:00:00Z', `${secret}-older`);
  const newer = auth('2026-09-03T00:00:00Z', `${secret}-newer`);

  it.each(['refresher first', 'refresher last', 'together'] as const)(
    'keeps the only refresh whatever the finish order: %s',
    async (order) => {
      await seedRealHome(original);
      const refresher = child(older);
      const idle = child(null);
      await Promise.all([refresher.ready, idle.ready]);
      if (order === 'together') {
        refresher.go();
        idle.go();
      } else {
        const [first, second] = order === 'refresher first' ? [refresher, idle] : [idle, refresher];
        first.go();
        await first.done;
        second.go();
      }
      const results = await Promise.all([refresher.done, idle.done]);
      expect(results.flatMap((result) => result.warnings)).toEqual([]);
      expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(older);
      for (const result of results) await expect(stat(result.path)).rejects.toThrow();
      expect(await readdir(locks)).toEqual([]);
    },
  );

  it.each(['newer first', 'older first', 'together'] as const)(
    'keeps the newer of two refreshes and warns the other call: %s',
    async (order) => {
      await seedRealHome(original);
      const before = withoutAuth(await listing(realHome));
      const fresh = child(newer);
      const stale = child(older);
      await Promise.all([fresh.ready, stale.ready]);
      if (order === 'together') {
        fresh.go();
        stale.go();
      } else {
        const [first, second] = order === 'newer first' ? [fresh, stale] : [stale, fresh];
        first.go();
        await first.done;
        second.go();
      }
      const results = await Promise.all([fresh.done, stale.done]);
      const final = await readFile(join(realHome, 'auth.json'), 'utf8');
      expect(final).toBe(newer);
      expect(JSON.parse(final)).toMatchObject({ last_refresh: '2026-09-03T00:00:00Z' });
      const warnings = results.flatMap((result) => result.warnings);
      expect(warnings).toEqual([expect.stringContaining('kept the newer credentials')]);
      expect(JSON.stringify(warnings)).not.toContain(secret);
      expect(withoutAuth(await listing(realHome))).toEqual(before);
      expect(await readdir(locks)).toEqual([]);
    },
  );
});

// A Codex stand-in recording CODEX_HOME, its listing, argv and env, then optionally refreshing
// auth.json, changing the real one, failing, or hanging until killed.
async function fakeCodex(): Promise<string> {
  const path = join(root, 'fake-codex');
  await writeFile(
    path,
    `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.157.1');process.exit(0);}
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const home=process.env.CODEX_HOME;const list={};
 const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);const m=(fs.lstatSync(f).mode&0o777).toString(8);list[path.relative(home,f)]=m;if(e.isDirectory())walk(f);}};
 walk(home);
 fs.writeFileSync(process.env.QC_CAPTURE,JSON.stringify({home,homeMode:(fs.statSync(home).mode&0o777).toString(8),list,args,env:{QUIET_CHOIR_RUN_ID:process.env.QUIET_CHOIR_RUN_ID??null}}));
 if(process.env.QC_REFRESH){const t=path.join(home,'auth.json.tmp');fs.writeFileSync(t,process.env.QC_REFRESH);fs.renameSync(t,path.join(home,'auth.json'));}
 if(process.env.QC_REAL_CHANGE)fs.writeFileSync(path.join(process.env.QC_REAL_HOME,'auth.json'),process.env.QC_REAL_CHANGE);
 fs.mkdirSync(path.join(home,'sqlite'),{recursive:true});fs.writeFileSync(path.join(home,'sqlite','state_1.sqlite'),'state');
 if(process.env.QC_HANG){setInterval(()=>{},1000);return;}
 if(process.env.QC_EXIT)process.exit(Number(process.env.QC_EXIT));
 console.log([JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}),JSON.stringify({type:'turn.completed'})].join('\\n'));
});`,
    { mode: 0o700 },
  );
  return path;
}

interface Capture {
  home: string;
  homeMode: string;
  list: Record<string, string>;
  args: string[];
  env: Record<string, string | null>;
}

describe('NativeCliHarness with a private CODEX_HOME', () => {
  const capturePath = (): string => join(root, 'capture.json');
  const readCapture = async (): Promise<Capture> =>
    JSON.parse(await readFile(capturePath(), 'utf8')) as Capture;
  const call = (instructions: 'native' | 'none' | undefined, set: Record<string, string> = {}) => ({
    harness: 'codex' as const,
    cwd: root,
    outputSchema: null,
    options: {
      prompt: 'x',
      ...(instructions === undefined ? {} : { instructions }),
      env: { set: { CODEX_HOME: realHome, QC_CAPTURE: capturePath(), ...set } },
    },
  });

  it('gives the child only auth.json, writes a refresh back and leaves the real home alone', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const before = await listing(realHome);
    const harness = new CliHarness({ codexBinary: await fakeCodex() });
    const refreshed = auth('2026-09-04T00:00:00Z', 'refreshed-token');
    const context = testInvocation();
    const response = await harness.invoke(call('none', { QC_REFRESH: refreshed }), context);
    expect(response.text).toBe('ok');
    expect(response.warnings ?? []).toEqual([]);
    const capture = await readCapture();
    expect(capture.home).not.toBe(realHome);
    expect(capture.home.startsWith(tmpdir())).toBe(true);
    expect(capture.list).toEqual({ 'auth.json': '600' });
    expect(capture.homeMode).toBe('700');
    expect(capture.env['QUIET_CHOIR_RUN_ID']).toBe(context.runId);
    const flag = capture.args.indexOf('project_doc_max_bytes=0');
    expect(capture.args[flag - 1]).toBe('--config');
    await expect(stat(capture.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(refreshed);
    expect(withoutAuth(await listing(realHome))).toEqual(withoutAuth(before));
    const lock = codexAuthLockPath(realHome);
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the private home after a failed call and reports write-back warnings', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const before = await listing(realHome);
    const harness = new CliHarness({ codexBinary: await fakeCodex() });
    const error: unknown = await harness
      .invoke(
        call('none', {
          QC_EXIT: '3',
          QC_REFRESH: auth('2026-09-02T00:00:00Z', `${secret}-older`),
          QC_REAL_HOME: realHome,
          QC_REAL_CHANGE: auth('2026-09-04T00:00:00Z', `${secret}-newer`),
        }),
        testInvocation(),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as Error).message).toContain('Cleanup:');
    expect((error as Error).message).toContain('kept the newer credentials');
    expect((error as Error).message).not.toContain(secret);
    const capture = await readCapture();
    await expect(stat(capture.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(withoutAuth(await listing(realHome))).toEqual(withoutAuth(before));
  });

  it('puts write-back warnings into a successful response', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const harness = new CliHarness({ codexBinary: await fakeCodex() });
    const newer = auth('2026-09-04T00:00:00Z', `${secret}-newer`);
    const response = await harness.invoke(
      call('none', {
        QC_REFRESH: auth('2026-09-02T00:00:00Z', `${secret}-older`),
        QC_REAL_HOME: realHome,
        QC_REAL_CHANGE: newer,
      }),
      testInvocation(),
    );
    expect(response.warnings).toEqual([expect.stringContaining('kept the newer credentials')]);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(await readFile(join(realHome, 'auth.json'), 'utf8')).toBe(newer);
  });

  it('removes the private home after cancellation', async () => {
    await seedRealHome(auth('2026-09-01T00:00:00Z'));
    const before = await listing(realHome);
    const harness = new CliHarness({ codexBinary: await fakeCodex(), killGraceMs: 200 });
    const controller = new AbortController();
    const pending = harness.invoke(
      call('none', { QC_HANG: '1' }),
      testInvocation(controller.signal),
    );
    const outcome = pending.catch((caught: unknown) => caught);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await stat(capturePath()).catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort(new Error('cancelled by test'));
    expect(String(await outcome)).toContain('cancelled');
    const capture = await readCapture();
    await expect(stat(capture.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listing(realHome)).toEqual(before);
  });

  it.each([undefined, 'native'] as const)(
    'uses the real CODEX_HOME with instructions %s',
    async (instructions) => {
      await seedRealHome(auth('2026-09-01T00:00:00Z'));
      const harness = new CliHarness({ codexBinary: await fakeCodex() });
      await harness.invoke(call(instructions), testInvocation());
      const capture = await readCapture();
      expect(capture.home).toBe(realHome);
      expect(capture.args.join(' ')).not.toContain('project_doc_max_bytes');
    },
  );
});

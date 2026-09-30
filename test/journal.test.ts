import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type RunRecord,
  type RunStore,
} from '../src/index.js';
import { JournalWriter, readJournalRun } from '../src/workflow/runtime/journal.js';
import { artifactName } from '../src/workflow/runtime/run-store.js';
import { writeRun } from '../src/workflow/runtime/store.js';
import { enableRealStorageSync } from './setup/durable-sync.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(join(tmpdir(), 'choir-journal-'));
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('group commits sibling completions before any effect promise resolves', async () => {
  enableRealStorageSync();
  const syncing = deferred(),
    permit = deferred();
  let started = false,
    resolved = 0,
    commits = 0;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args);
    const sync = file.sync.bind(file);
    vi.spyOn(file, 'sync').mockImplementation(async () => {
      if (
        started &&
        typeof args[0] === 'string' &&
        args[0].endsWith('journal.jsonl') &&
        resolved === 0
      ) {
        commits++;
        syncing.resolve();
        await permit.promise;
      }
      await sync();
    });
    return file;
  });
  const definition = defineWorkflow({
    name: 'group',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) => {
      await Promise.all(
        Array.from({ length: 16 }, (_, n) =>
          ctx
            .step(`s-${String(n)}`, {
              input: null,
              schema: z.number(),
              run: () => {
                started = true;
                return n;
              },
            })
            .then(() => {
              resolved++;
            }),
        ),
      );
      return resolved;
    },
  });
  const running = runWorkflow(definition, { stateDir, runId: 'group', input: null });
  await syncing.promise;
  expect(resolved).toBe(0);
  expect(commits).toBe(1);
  permit.resolve();
  expect((await running).output).toBe(16);
  expect((await readRun({ stateDir, runId: 'group' })).seq).toBeGreaterThan(0);
});

it('writes less than ten times the final state for 500 local 5KB results at concurrency eight', async () => {
  let bytes = 0;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args);
    const writeFile = file.writeFile.bind(file),
      write = file.write.bind(file);
    vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
      bytes +=
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : Buffer.isBuffer(data)
            ? data.length
            : 0;
      await writeFile(data, options);
    });
    vi.spyOn(file, 'write').mockImplementation(async (...values) => {
      const result = await write(...values);
      bytes += result.bytesWritten;
      return result;
    });
    return file;
  });
  const definition = defineWorkflow({
    name: 'bytes',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) =>
      (
        await ctx.map(
          'batch',
          Array.from({ length: 500 }, (_, n) => n),
          { concurrency: 8 },
          (n) =>
            ctx.step(`value-${String(n)}`, {
              input: null,
              schema: z.string(),
              run: () => 'x'.repeat(5120),
            }),
        )
      ).length,
  });
  expect((await runWorkflow(definition, { stateDir, runId: 'bytes', input: null })).output).toBe(
    500,
  );
  const final = (await fs.stat(join(stateDir, 'bytes', 'run.json'))).size;
  expect(bytes).toBeLessThan(final * 10);
  expect(await fs.readFile(join(stateDir, 'bytes', 'journal.jsonl'), 'utf8')).toBe('');
}, 20_000);

it('ignores a torn final journal line and repairs it before the next owner appends', async () => {
  let fail = true,
    calls = 0;
  const definition = defineWorkflow({
    name: 'torn',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) => {
      const value = await ctx.step('saved', {
        input: null,
        schema: z.number(),
        run: () => ++calls,
      });
      if (fail) throw new Error('tail');
      return value;
    },
  });
  const options = { stateDir, runId: 'torn', input: null };
  await expect(runWorkflow(definition, options)).rejects.toThrow('tail');
  const path = join(stateDir, 'torn', 'journal.jsonl');
  await fs.appendFile(path, '{"seq":100,"changes":[');
  expect((await readRun(options)).steps['saved']?.output).toBe(1);
  fail = false;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe(1);
  expect(calls).toBe(1);
  expect(await fs.readFile(path, 'utf8')).toBe('');
  await fs.appendFile(path, '{corrupt}\n');
  await expect(readRun(options)).rejects.toThrow();
});

it('retries lock-free reads when compaction changes the snapshot during a journal read', async () => {
  const definition = defineWorkflow({
    name: 'race',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  await runWorkflow(definition, { stateDir, runId: 'race', input: null });
  const original = await readRun({ stateDir, runId: 'race' });
  const writer = new JournalWriter(stateDir, 'race');
  let changed = false;
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    const content = await actualFs.readFile(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('journal.jsonl') && !changed) {
      changed = true;
      await writer.append({ ...original, status: 'failed', error: 'new snapshot' });
    }
    return content;
  });
  const current = await readJournalRun(stateDir, 'race');
  expect(current.error).toBe('new snapshot');
  expect(current.seq).toBeGreaterThan(original.seq ?? 0);
});

it('migrates a flat format-six run under its old owner and preserves exact backup bytes', async () => {
  let fail = true,
    calls = 0;
  const definition = defineWorkflow({
    name: 'migration',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) => {
      const value = await ctx.step('saved', {
        input: null,
        schema: z.number(),
        run: () => ++calls,
      });
      if (fail) throw new Error('tail');
      return value;
    },
  });
  const options = { stateDir, runId: 'legacy', input: null };
  await expect(runWorkflow(definition, options)).rejects.toThrow('tail');
  const record = await readRun(options);
  record.formatVersion = 6;
  delete record.seq;
  delete record.engine;
  await fs.rm(join(stateDir, 'legacy'), { recursive: true });
  await writeRun(stateDir, record);
  const bytes = await fs.readFile(join(stateDir, 'legacy.json'), 'utf8');
  fail = false;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe(1);
  expect(calls).toBe(1);
  expect(await fs.readFile(join(stateDir, 'legacy.json.v6'), 'utf8')).toBe(bytes);
  expect(JSON.parse(await fs.readFile(join(stateDir, 'legacy.json'), 'utf8'))).toMatchObject({
    formatVersion: 7,
  });
  expect((await readRun(options)).formatVersion).toBe(7);
});

it('keeps artifact path components bounded and distinct under case folding', () => {
  const ids = ['Case', 'case', 'a/b.c:d', 'a/b'.repeat(66), 'A'.repeat(200)];
  const names = ids.map(artifactName);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(ids.length);
  expect(names.every((name) => Buffer.byteLength(name) < 255 && !name.includes('/'))).toBe(true);
  expect(() => artifactName('../escape')).toThrow();
});

it('refuses a missing journal instead of silently falling back to a stale migration marker', async () => {
  const definition = defineWorkflow({
    name: 'missing',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  const options = { stateDir, runId: 'missing', input: null };
  const run = await runWorkflow(definition, options);
  await fs.writeFile(join(stateDir, 'missing.json'), JSON.stringify(run));
  await fs.rm(join(stateDir, 'missing', 'journal.jsonl'));
  await expect(readRun(options)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['empty', 'torn'])(
  'starts fresh over a %s journal orphaned before the first directory snapshot',
  async (shape) => {
    const definition = defineWorkflow({
      name: 'orphan',
      version: '1',
      input: z.null(),
      output: z.number(),
      run: (ctx) => ctx.step('count', { input: null, schema: z.number(), run: () => 1 }),
    });
    const options = { stateDir, runId: 'orphan', input: null };
    const first = await runWorkflow(definition, options);
    expect(first.output).toBe(1);
    // compact() truncates the journal on completion, so this reproduces the pre-snapshot crash
    // window directly: run.json is gone and only an empty or torn journal remains.
    await fs.rm(join(stateDir, 'orphan', 'run.json'));
    await fs.writeFile(
      join(stateDir, 'orphan', 'journal.jsonl'),
      shape === 'torn' ? '{"seq":1,"at":' : '',
    );
    const resumed = await runWorkflow(definition, options);
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(1);
  },
);

it.each([3, 11, 29])(
  'keeps every resolved fan-out result after SIGKILL near completion %s',
  async (stopAfter) => {
    const { fork } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const childPath = fileURLToPath(new URL('./storage-crash-child.mjs', import.meta.url));
    const launch = (resume: boolean) =>
      fork(childPath, [stateDir, resume ? 'resume' : 'start'], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    const child = launch(false);
    let messages = 0,
      stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('message', (message) => {
      if (typeof message === 'object' && 'resolved' in message && ++messages === stopAfter)
        child.kill('SIGKILL');
    });
    const interrupted = await new Promise<string | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (_code, signal) => {
        resolve(signal);
      });
    });
    expect(interrupted, stderr).toBe('SIGKILL');
    const acknowledged = (await fs.readFile(join(stateDir, 'resolved.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    const checkpoint = await readRun({ stateDir, runId: 'crash' });
    for (const id of acknowledged)
      expect(checkpoint.steps[`fan/${id}/effect`]?.status).toBe('completed');
    // Simulate a short final write from the killed process as well as the actual process crash.
    await fs.appendFile(join(stateDir, 'crash', 'journal.jsonl'), '{"seq":');
    const resumed = launch(true);
    let resumedErrors = '';
    resumed.stderr?.on('data', (chunk) => {
      resumedErrors += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      resumed.once('error', reject);
      resumed.once('exit', resolve);
    });
    expect(code, resumedErrors).toBe(0);
    const actions = (await fs.readFile(join(stateDir, 'actions.jsonl'), 'utf8')).trim().split('\n');
    for (const id of acknowledged) expect(actions.filter((value) => value === id)).toHaveLength(1);
    expect((await readRun({ stateDir, runId: 'crash' })).output).toBe(80);
  },
  20_000,
);

it('recovers a crash after the old-binary guard but before the first directory snapshot', async () => {
  const { prepareStorageMigration } = await import('../src/workflow/runtime/storage-migration.js');
  const { lockRun } = await import('../src/workflow/runtime/store.js');
  const definition = defineWorkflow({
    name: 'guard',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  const options = { stateDir, runId: 'guard', input: null };
  const next = await runWorkflow(definition, options);
  const previous = { ...next, formatVersion: 6 as const };
  delete previous.seq;
  delete previous.engine;
  await fs.rm(join(stateDir, 'guard'), { recursive: true });
  await writeRun(stateDir, previous);
  const release = await lockRun(stateDir, 'guard');
  await prepareStorageMigration(stateDir, 'guard', next);
  await release();
  expect(JSON.parse(await fs.readFile(join(stateDir, 'guard.json'), 'utf8'))).toMatchObject({
    formatVersion: 7,
    migrationPending: 6,
  });
  expect((await readRun(options)).formatVersion).toBe(6);
  expect((await runWorkflow(definition, { ...options, resume: true })).status).toBe('completed');
  expect((await readRun(options)).formatVersion).toBe(7);
  expect(JSON.parse(await fs.readFile(join(stateDir, 'guard.json'), 'utf8'))).not.toHaveProperty(
    'migrationPending',
  );
});

it('migrates a real format-one local identity but refuses a completed agent without pinned isolation', async () => {
  const original = await fs.readFile(
    new URL('./fixtures/storage/v1.json', import.meta.url),
    'utf8',
  );
  await fs.writeFile(join(stateDir, 'legacy.json'), original);
  let calls = 0;
  const definition = defineWorkflow({
    name: 'legacy-v1',
    version: '1',
    input: z.null(),
    output: z.string(),
    run: async (ctx) => {
      const value = await ctx.step('local', {
        input: null,
        schema: z.number(),
        run: () => {
          calls++;
          return 7;
        },
      });
      const agent = await ctx.claude.text('agent', { prompt: 'legacy question' });
      await ctx.sleep('pause', 0);
      return `${String(value)}/${agent.output}`;
    },
  });
  const options = {
    stateDir,
    runId: 'legacy',
    cwd: '/quiet-choir/legacy-project',
    input: null,
    resume: true,
    fingerprint: 'fixed-source',
  };
  await expect(runWorkflow(definition, options)).rejects.toThrow('format version 1');
  expect(await fs.readFile(join(stateDir, 'legacy.json'), 'utf8')).toBe(original);
  await expect(runWorkflow(definition, { ...options, acceptCodeChange: true })).rejects.toThrow(
    'no pinned isolation mode',
  );
  const migrated = await readRun(options);
  expect(calls).toBe(0);
  expect(migrated.formatVersion).toBe(7);
  expect(migrated.steps['local']?.legacyIdentity).toBeUndefined();
  expect(migrated.steps['agent']?.legacyIdentity).toBe(1);
  expect(migrated.steps['agent']?.legacyAttempts).toBe(1);
  expect(await fs.readFile(join(stateDir, 'legacy.json.v1'), 'utf8')).toBe(original);
  expect((await readRun(options)).codeChanges).toHaveLength(1);
});

it('retains original format-one step checks even when source drift is explicitly accepted', async () => {
  const original = await fs.readFile(
    new URL('./fixtures/storage/v1.json', import.meta.url),
    'utf8',
  );
  await fs.writeFile(join(stateDir, 'legacy.json'), original);
  const definition = defineWorkflow({
    name: 'legacy-v1',
    version: '1',
    input: z.null(),
    output: z.string(),
    run: async (ctx) => {
      await ctx.step('local', { input: { changed: true }, schema: z.number(), run: () => 7 });
      return 'unreachable';
    },
  });
  await expect(
    runWorkflow(definition, {
      stateDir,
      runId: 'legacy',
      cwd: '/quiet-choir/legacy-project',
      resume: true,
      fingerprint: 'fixed',
      acceptCodeChange: true,
    }),
  ).rejects.toThrow('original format-one identity changed');
  expect((await readRun({ stateDir, runId: 'legacy' })).steps['local']?.legacyIdentity).toBe(1);
});

it('runs and resumes local effects with an injected in-memory store and no state directory', async () => {
  const records = new Map<string, RunRecord>();
  const locked = new Set<string>();
  let releases = 0,
    calls = 0,
    fail = true;
  const store: RunStore = {
    read(runId) {
      const record = records.get(runId);
      return record
        ? Promise.resolve(structuredClone(record))
        : Promise.reject(new Error('missing'));
    },
    list: () => Promise.resolve([...records.keys()]),
    open(runId) {
      if (locked.has(runId)) return Promise.reject(new Error('locked'));
      locked.add(runId);
      return Promise.resolve({
        read: () =>
          Promise.resolve(records.has(runId) ? structuredClone(records.get(runId)) : undefined),
        append: (record) => {
          records.set(runId, structuredClone(record));
          return Promise.resolve();
        },
        compact: () => Promise.resolve(),
        artifacts: () => Promise.reject(new Error('No files in this test store.')),
        trackProcess: () => Promise.reject(new Error('No native processes in this test store.')),
        release: () => {
          locked.delete(runId);
          releases++;
          return Promise.resolve();
        },
      });
    },
  };
  const definition = defineWorkflow({
    name: 'memory',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: async (ctx) => {
      const value = await ctx.step('saved', {
        input: null,
        schema: z.number(),
        run: () => ++calls,
      });
      if (fail) throw new Error('tail');
      return value;
    },
  });
  const options = {
    store,
    stateDir: join(stateDir, 'never-created'),
    runId: 'memory',
    input: null,
  };
  await expect(runWorkflow(definition, options)).rejects.toThrow('tail');
  fail = false;
  expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe(1);
  expect(calls).toBe(1);
  expect(releases).toBe(2);
  expect(locked.size).toBe(0);
  await expect(fs.stat(options.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('allocates private case-distinct artifact directories and refuses mutations after release', async () => {
  const { FileRunStore } = await import('../src/index.js');
  const store = new FileRunStore(stateDir);
  const owner = await store.open('artifacts', { probeOwner: false });
  const upper = await owner.artifacts('Case', 1),
    lower = await owner.artifacts('case', 1);
  expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  expect((await fs.stat(upper)).mode & 0o777).toBe(0o700);
  expect(await store.list()).toEqual([]);
  await expect(owner.artifacts('id', 0)).rejects.toThrow('positive');
  await owner.compact();
  await owner.release();
  await expect(owner.compact()).rejects.toThrow('closed');
  await expect(owner.artifacts('Case', 2)).rejects.toThrow('closed');
});

it('does not let a dead legacy lock bypass a live directory owner', async () => {
  const { lockRun } = await import('../src/workflow/runtime/store.js');
  const { hostname } = await import('node:os');
  // Simulate a migrated run mid-crash: a pre-format-7 binary's guard died while a current-format
  // binary's directory lock is still genuinely live.
  const primary = join(stateDir, 'dual', 'lock', 'owner.json');
  await fs.mkdir(dirname(primary), { recursive: true });
  const before = JSON.stringify({ pid: process.pid, host: hostname(), token: 'directory-owner' });
  await fs.writeFile(primary, before);
  await fs.mkdir(join(stateDir, 'dual.json.lock'));
  await fs.writeFile(
    join(stateDir, 'dual.json.lock', 'owner.json'),
    JSON.stringify({ pid: 90_000_000, host: hostname(), token: 'abandoned-old-tool' }),
  );
  await expect(lockRun(stateDir, 'dual')).rejects.toThrow('locked by PID');
  expect(await fs.readFile(primary, 'utf8')).toBe(before);
});

it.each(['partial-write', 'flush'])(
  'retries a %s failure without repeating a successful action',
  async (failure) => {
    if (failure === 'flush') enableRealStorageSync();
    let ready = false,
      injected = false,
      calls = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args);
      if (typeof args[0] !== 'string' || !args[0].endsWith('journal.jsonl')) return file;
      if (failure === 'flush') {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementation(async () => {
          if (ready && !injected) {
            injected = true;
            throw Object.assign(new Error('injected flush'), { code: 'EIO' });
          }
          await sync();
        });
      } else {
        const write = file.write.bind(file);
        vi.spyOn(file, 'write').mockImplementation(async (...values) => {
          if (ready && !injected) {
            injected = true;
            await actualFs.appendFile(String(args[0]), Buffer.from(values[0]).subarray(0, 17));
            throw Object.assign(new Error('injected partial write'), { code: 'EIO' });
          }
          return write(...values);
        });
      }
      return file;
    });
    const definition = defineWorkflow({
      name: 'retry-storage',
      version: '1',
      input: z.null(),
      output: z.number(),
      run: (ctx) =>
        ctx.step('saved', {
          input: null,
          schema: z.number(),
          run: () => {
            ready = true;
            return ++calls;
          },
        }),
    });
    const options = { stateDir, runId: 'retry', input: null };
    expect((await runWorkflow(definition, options)).output).toBe(1);
    expect(injected).toBe(true);
    expect(calls).toBe(1);
    expect((await readRun(options)).steps['saved']?.attempts).toBe(1);
    expect((await runWorkflow(definition, { ...options, resume: true })).output).toBe(1);
    expect(calls).toBe(1);
  },
);

it('resolves canonical projects and honors explicit, environment, and legacy precedence', async () => {
  const { resolveStateDir } = await import('../src/index.js');
  const project = join(stateDir, 'project'),
    alias = join(stateDir, 'alias');
  await fs.mkdir(project);
  await fs.symlink(project, alias);
  const canonical = await fs.realpath(project);
  vi.stubEnv('XDG_STATE_HOME', join(stateDir, 'external'));
  vi.stubEnv('QUIET_CHOIR_STATE_DIR', undefined);
  try {
    const external = resolveStateDir({ cwd: project, runId: 'old' });
    expect(resolveStateDir({ cwd: alias })).toBe(external);
    const legacy = join(canonical, '.quiet-choir', 'runs');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'old.json'), '{}');
    expect(resolveStateDir({ cwd: alias, runId: 'old' })).toBe(legacy);
    expect(resolveStateDir({ cwd: alias, runId: 'new' })).toBe(external);
    vi.stubEnv('QUIET_CHOIR_STATE_DIR', 'environment');
    expect(resolveStateDir({ cwd: alias, runId: 'old' })).toBe(join(canonical, 'environment'));
    expect(resolveStateDir({ cwd: alias, runId: 'old', stateDir: 'explicit' })).toBe(
      join(canonical, 'explicit'),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it('registers the default project for an embedded run that omits cwd and stateDir', async () => {
  const { defaultStateDir, projectStateDirectories } =
    await import('../src/workflow/runtime/paths.js');
  vi.stubEnv('XDG_STATE_HOME', join(stateDir, 'external'));
  vi.stubEnv('QUIET_CHOIR_STATE_DIR', undefined);
  try {
    const definition = defineWorkflow({
      name: 'embedded',
      version: '1',
      input: z.null(),
      output: z.null(),
      run: () => Promise.resolve(null),
    });
    expect(
      (await runWorkflow(definition, { runId: 'embedded-default-root', input: null })).status,
    ).toBe('completed');
    const runs = defaultStateDir();
    expect(JSON.parse(await fs.readFile(join(runs, '..', 'project.json'), 'utf8'))).toEqual({
      cwd: await fs.realpath(process.cwd()),
    });
    expect((await projectStateDirectories()).directories).toEqual([runs]);
  } finally {
    vi.unstubAllEnvs();
  }
});

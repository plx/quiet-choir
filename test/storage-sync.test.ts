import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  runWorkflow,
  writeAnswer,
  z,
  type Harness,
  type RunRecord,
} from '../src/index.js';
import { setStorageSyncForTesting, syncDirectory } from '../src/workflow/runtime/storage-io.js';
import { enableRealStorageSync } from './setup/durable-sync.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'choir-sync-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/** Record the path of every opened handle, and every path that a FileHandle sync() flushes. */
async function spyOnSync(): Promise<string[]> {
  const paths = new WeakMap<object, string>();
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args);
    paths.set(handle, String(args[0]));
    return handle;
  });
  const probe = await actualFs.open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const original = Reflect.get(prototype, 'sync');
  const synced: string[] = [];
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: fs.FileHandle) {
    synced.push(relative(directory, paths.get(this) ?? '<unknown>'));
    await original.call(this);
  });
  return synced;
}

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const harness: Harness = {
  async invoke(_request, invocation) {
    await invocation.onSession?.('session-1');
    await invocation.onOutput?.('stdout', Buffer.from('transcript bytes'));
    return { text: 'done', sessionId: 'session-1', usage };
  },
};

/** A step, a map, a file write, an agent call with a transcript, and a question that gets answered. */
async function exercise(): Promise<RunRecord> {
  const definition = defineWorkflow({
    name: 'sync-coverage',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      await ctx.step('plain', { input: null, schema: z.number(), run: () => 1 });
      await ctx.map('items', [1, 2, 3], { concurrency: 2 }, (n) =>
        ctx.step('item', { input: n, schema: z.number(), run: () => n }),
      );
      await ctx.writeFile('publish', 'published.txt', 'content');
      await ctx.codex.text('agent', { prompt: 'say done' });
      return ctx.ask('gate', { prompt: 'Ship?', schema: z.enum(['ship', 'revise']) });
    },
  });
  const options = {
    stateDir: join(directory, 'state'),
    runId: 'sync',
    cwd: directory,
    input: null,
  };
  const suspended = await runWorkflow(definition, { ...options, harness });
  expect(suspended.status).toBe('suspended');
  await writeAnswer({ ...options, stepId: 'gate', value: 'ship' });
  const done = await runWorkflow(definition, { ...options, harness, resume: true });
  expect(done.status).toBe('completed');
  return done;
}

describe('runtime fsync', () => {
  it('flushes journal, snapshot, lock, inbox, file and transcript writes when enabled', async () => {
    enableRealStorageSync();
    const synced = await spyOnSync();
    await exercise();
    const has = (fragment: string): boolean => synced.some((path) => path.includes(fragment));
    expect(synced.length).toBeGreaterThan(0);
    expect(has('journal.jsonl')).toBe(true);
    expect(has(`run.json.`)).toBe(true);
    expect(has('owner.json')).toBe(true);
    expect(has('.answer-')).toBe(true);
    expect(has('.quiet-choir-')).toBe(true);
    expect(has('.codex.jsonl')).toBe(true);
    // Directory entries are flushed through the same FileHandle method.
    expect(synced.some((path) => path.split(sep).at(-1) === 'inbox')).toBe(true);
  });

  it('makes no FileHandle sync calls under the default test setup', async () => {
    expect(setStorageSyncForTesting(false)).toBe(false);
    const synced = await spyOnSync();
    await exercise();
    expect(synced).toEqual([]);
  });

  it('still opens directories when syncing is off, so path errors surface', async () => {
    expect(setStorageSyncForTesting(false)).toBe(false);
    await expect(syncDirectory(join(directory, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(syncDirectory(directory)).resolves.toBeUndefined();
  });

  it('restores the previous setting from the test-only switch', () => {
    expect(setStorageSyncForTesting(true)).toBe(false);
    expect(setStorageSyncForTesting(false)).toBe(true);
  });
});

async function sources(root: string): Promise<{ file: string; text: string }[]> {
  const entries = await actualFs.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map(async (entry) => {
        const file = join(entry.parentPath, entry.name);
        return { file: relative(root, file), text: await actualFs.readFile(file, 'utf8') };
      }),
  );
}

describe('storage sync boundary', () => {
  const source = new URL('../src', import.meta.url).pathname;

  it('keeps direct sync calls in storage-io.ts and the spawned guard program only', async () => {
    const direct = /\.(?:data)?sync\(|\bf(?:data)?sync(?:Sync)?\(/u;
    const offenders = (await sources(source))
      .filter(({ text }) => direct.test(text))
      .map(({ file }) => file)
      .sort();
    expect(offenders).toEqual([
      join('workflow', 'helpers', 'guard-program.ts'),
      join('workflow', 'runtime', 'storage-io.ts'),
    ]);
  });

  it('references the test-only switch nowhere in src but storage-io.ts', async () => {
    const users = (await sources(source))
      .filter(({ text }) => text.includes('setStorageSyncForTesting'))
      .map(({ file }) => file);
    expect(users).toEqual([join('workflow', 'runtime', 'storage-io.ts')]);
  });

  it('exports neither the switch nor the helpers from any public entry point', async () => {
    const entries = [
      await import('../src/index.js'),
      await import('../src/harness-kit.js'),
      await import('../src/integrations/decision.js'),
    ];
    for (const entry of entries)
      for (const name of ['setStorageSyncForTesting', 'syncHandle', 'syncDirectory'])
        expect(Object.keys(entry)).not.toContain(name);
    const manifest = JSON.parse(
      await actualFs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './decision',
      './harness-kit',
      './package.json',
    ]);
  });
});

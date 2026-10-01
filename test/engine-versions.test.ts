import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
import type * as Engine from '../src/workflow/runtime/engine.js';
import { parseRunRecord } from '../src/workflow/runtime/record.js';

// The mock is hoisted. It overrides only the recorded toolchain versions and spreads the real
// module, so engineInfo (and therefore workflow.identity.engine) stays the real one.
const mocked = vi.hoisted(() => ({
  versions: undefined as { zod: string; tsx: string } | undefined,
}));
vi.mock('../src/workflow/runtime/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Engine>();
  return {
    ...actual,
    recordedEngine: () => ({ ...actual.recordedEngine(), ...mocked.versions }),
  };
});

const require = createRequire(import.meta.url);
const installedVersion = async (name: string): Promise<string> =>
  z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'))).version;

const older = { zod: '4.3.0', tsx: '4.0.0' };
let cwd: string;
let stateDir: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-engine-versions-')));
  stateDir = join(cwd, 'state');
});
afterEach(async () => {
  mocked.versions = undefined;
  await rm(cwd, { recursive: true, force: true });
});
const setup = () => ({ cwd, stateDir, runId: 'test', input: null });

function counted() {
  const state = { callbacks: 0, failTail: false };
  const definition = defineWorkflow({
    name: 'engine-versions',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const value = await ctx.step('first', {
        input: null,
        schema: z.string(),
        run: () => {
          state.callbacks++;
          return 'saved';
        },
      });
      if (state.failTail) throw new Error('tail failed');
      return value;
    },
  });
  return { state, definition };
}

it('records the installed zod and tsx versions on a new run', async () => {
  const { definition } = counted();
  await runWorkflow(definition, setup());
  expect((await readRun(setup())).engine).toEqual({
    quietChoir: expect.any(String) as string,
    node: process.version,
    zod: await installedVersion('zod'),
    tsx: await installedVersion('tsx'),
  });
});

it('resumes an unfinished run recorded under other zod and tsx versions', async () => {
  const { state, definition } = counted();
  state.failTail = true;
  mocked.versions = older;
  await expect(runWorkflow(definition, setup())).rejects.toThrow('tail failed');
  const before = await readRun(setup());
  expect(before.engine).toMatchObject(older);

  mocked.versions = undefined;
  state.failTail = false;
  const resumed = await runWorkflow(definition, { ...setup(), resume: true });
  expect(resumed.status).toBe('completed');
  expect(state.callbacks).toBe(1);
  expect(resumed.steps['first']?.fingerprint).toBe(before.steps['first']?.fingerprint);
  expect(resumed.steps['first']?.identity).toEqual(before.steps['first']?.identity);

  const after = await readRun(setup());
  expect(before.workflow.identity?.engine).toBeDefined();
  expect(after.workflow.identity?.engine).toEqual(before.workflow.identity?.engine);
  expect(after.engine).toMatchObject({
    zod: await installedVersion('zod'),
    tsx: await installedVersion('tsx'),
  });
});

it('resumes a completed run recorded under other versions and refreshes its engine', async () => {
  const { state, definition } = counted();
  mocked.versions = older;
  await runWorkflow(definition, setup());
  const before = await readRun(setup());
  expect(before.engine).toMatchObject(older);

  mocked.versions = undefined;
  const resumed = await runWorkflow(definition, { ...setup(), resume: true });
  expect(resumed.status).toBe('completed');
  expect(resumed.output).toBe('saved');
  expect(state.callbacks).toBe(1);

  const after = await readRun(setup());
  expect(after.engine).toMatchObject({
    zod: await installedVersion('zod'),
    tsx: await installedVersion('tsx'),
  });
  expect(after.steps['first']?.fingerprint).toBe(before.steps['first']?.fingerprint);
  expect(before.workflow.identity?.engine).toBeDefined();
  expect(after.workflow.identity?.engine).toEqual(before.workflow.identity?.engine);
});

it('still parses a record whose engine predates the zod and tsx fields', async () => {
  const { definition } = counted();
  await runWorkflow(definition, setup());
  const record = await readRun(setup());
  const engine = { quietChoir: record.engine?.quietChoir ?? '', node: process.version };
  const parsed = parseRunRecord(JSON.stringify({ ...record, engine }), 'test');
  expect(parsed.engine).toEqual(engine);
});

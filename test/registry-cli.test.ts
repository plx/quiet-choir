/* eslint-disable @typescript-eslint/require-await -- Probe fixtures return immediately without inference. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  readHarnessSelection,
  selectedAdapters,
} from '../src/workflow/loader/harness-selection.js';
import { DoctorExecutor } from '../src/application/doctor.js';
import { defineHarness, defineWorkflow, z } from '../src/index.js';
import { describeWorkflow } from '../src/workflow/runtime/definition.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'choir-registry-cli-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('parses named fixture overrides and per-package JSON configuration before importing source', async () => {
  const cwd = await directory();
  await writeFile(
    join(cwd, 'fixture.json'),
    JSON.stringify({ version: 1, calls: [{ step: '**', text: 'fixture' }] }),
  );
  const selection = await readHarnessSelection(
    ['third=fixture:fixture.json'],
    '{"harnesses":{"third":{"binary":"third-cli"},"codex":{"binary":"custom-codex"}}}',
    cwd,
  );
  expect(selection).toMatchObject({
    kind: 'cli',
    named: { third: { calls: [{ text: 'fixture' }] } },
    configurations: { third: { binary: 'third-cli' } },
  });
  const adapters = selectedAdapters(selection);
  expect(adapters['third']?.kind).toBe('fixture');
  expect(adapters['codex']?.policyDefaults?.().binary).toBe('custom-codex');
  await writeFile(
    join(cwd, 'fixture=copy.json'),
    JSON.stringify({ version: 1, calls: [{ step: '**', text: 'global' }] }),
  );
  expect(await readHarnessSelection('fixture:fixture=copy.json', undefined, cwd)).toMatchObject({
    kind: 'fixture',
    fixtures: { calls: [{ text: 'global' }] },
  });
  await expect(
    readHarnessSelection(
      ['third=fixture:fixture.json', 'third=fixture:fixture.json'],
      undefined,
      cwd,
    ),
  ).rejects.toThrow('Duplicate');
  await expect(
    readHarnessSelection(['cli', 'fixture:fixture.json'], undefined, cwd),
  ).rejects.toThrow('one global harness');
  await expect(readHarnessSelection('third=unknown:file', undefined, cwd)).rejects.toThrow(
    'name=fixture',
  );
  expect(() =>
    selectedAdapters({ ...selection, configurations: { codex: { unknown: true } } }),
  ).toThrow();
});

it('resolves relative nested built-in binaries against the command cwd', async () => {
  const cwd = await directory();
  const selection = await readHarnessSelection(
    'cli',
    '{"harnesses":{"codex":{"binary":"./bin/codex"},"claude":{"binary":"claude-next"},"third":{"binary":"./bin/third"}}}',
    cwd,
  );
  expect(selection.configurations).toEqual({
    codex: { binary: join(cwd, 'bin', 'codex') },
    claude: { binary: 'claude-next' },
    third: { binary: './bin/third' },
  });
  const adapters = selectedAdapters(selection);
  expect(adapters['codex']?.policyDefaults?.().binary).toBe(join(cwd, 'bin', 'codex'));
  expect(adapters['claude']?.policyDefaults?.().binary).toBe('claude-next');
});

it('publishes registry schemas and capabilities without constructing adapters or running workflow bodies', () => {
  const third = defineHarness({
    name: 'third',
    revision: 9,
    options: z.object({ prompt: z.string(), effort: z.enum(['brief', 'deep']).optional() }),
    capabilities: { structuredOutput: 'none', effort: ['brief', 'deep'] },
    access: () => 'none',
    createAdapter: () => {
      throw new Error('must stay lazy');
    },
    probe: async () => ({ version: 'test' }),
  });
  const workflow = defineWorkflow({
    name: 'described',
    version: '1',
    harnesses: [third],
    input: z.null(),
    output: z.null(),
    async run() {
      throw new Error('must not run');
    },
  });
  expect(describeWorkflow(workflow).harnesses).toMatchObject([
    { name: 'claude' },
    { name: 'codex' },
    {
      name: 'third',
      revision: 9,
      factory: true,
      probe: true,
      capabilities: { structuredOutput: 'none' },
      options: { properties: { effort: { enum: ['brief', 'deep'] } } },
    },
  ]);
});

it('doctor typechecks a trusted registry, forwards configuration, and invokes only optional zero-inference probes', async () => {
  const cwd = await directory();
  const path = join(cwd, 'doctor.workflow.mts');
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  await writeFile(
    path,
    `import {defineHarness, defineWorkflow, z} from ${JSON.stringify(entry)};
    const third = defineHarness({name:'third', revision:1, options:z.object({prompt:z.string()}), capabilities:{structuredOutput:'none'}, access: () => 'none',
      createAdapter() {throw new Error('doctor must not construct adapters');},
      async probe(config) {return {version: z.object({version:z.string()}).parse(config).version};}});
    export default defineWorkflow({name:'probe',version:'1',harnesses:[third],input:z.null(),output:z.null(),async run(){throw new Error('doctor must not run workflows');}});`,
  );
  const executor = new DoctorExecutor({
    log() {
      /* Silent diagnostic test logger. */
    },
  });
  const result = await executor.execute({
    kind: 'configuration.doctor',
    cwd,
    workflow: path,
    configuration: { kind: 'cli', config: {}, configurations: { third: { version: 'fake-1' } } },
  });
  expect(result).toMatchObject({
    ok: true,
    verdict: 'ok',
    warnings: [],
    zeroInference: true,
    checks: [
      { harness: 'claude', check: 'registry' },
      { harness: 'codex', check: 'registry' },
      { harness: 'third', check: 'version', message: 'fake-1' },
    ],
    harnesses: { third: { version: 'fake-1' } },
  });
  const failed = await executor.execute({ kind: 'configuration.doctor', cwd, workflow: path });
  expect(failed).toMatchObject({
    ok: false,
    verdict: 'blocked',
    warnings: [],
    checks: [
      { ok: true, status: 'pass' },
      { ok: true, status: 'pass' },
      { harness: 'third', ok: false, status: 'fail' },
    ],
  });
  const selected = await executor.execute({
    kind: 'configuration.doctor',
    cwd,
    workflow: path,
    harness: 'third',
    configuration: { kind: 'cli', config: {}, configurations: { third: { version: 'selected' } } },
  });
  expect(selected.checks).toEqual([
    { harness: 'third', check: 'version', status: 'pass', ok: true, message: 'selected' },
  ]);
  await expect(
    executor.execute({ kind: 'configuration.doctor', cwd, harness: 'third' }),
  ).rejects.toThrow('requires --workflow');
  await expect(
    executor.execute({ kind: 'configuration.doctor', cwd, workflow: path, harness: 'missing' }),
  ).rejects.toThrow('no declared harness missing');
  // measured: 4.0 s alone, 16.5-39.1 s in local full coverage runs and 50.0 s on the Node 22.13 CI
  // leg (dominated by TypeScript compiles)
}, 100_000);

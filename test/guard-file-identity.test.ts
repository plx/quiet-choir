import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as GuardProgram from '../src/workflow/helpers/guard-program.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  guardFile,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  z,
  type Command,
  type ProcessRunner,
  type WorkflowContext,
} from '../src/index.js';

// The mock is hoisted; its getters let a test edit the program or version between run and resume.
const mocked = vi.hoisted(() => ({
  program: undefined as string | undefined,
  version: undefined as string | undefined,
}));
vi.mock('../src/workflow/helpers/guard-program.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GuardProgram>();
  return {
    get guardProgram() {
      return mocked.program ?? actual.guardProgram;
    },
    get GUARD_PROGRAM_VERSION() {
      return mocked.version ?? actual.GUARD_PROGRAM_VERSION;
    },
  };
});

const originalExecPath = process.execPath;
let cwd: string;
let stateDir: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-guard-identity-')));
  stateDir = join(cwd, 'state');
});
afterEach(async () => {
  process.execPath = originalExecPath;
  mocked.program = undefined;
  mocked.version = undefined;
  await rm(cwd, { recursive: true, force: true });
});

const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({
    name: 'guard-identity',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run,
  });
const setup = () => ({ cwd, stateDir, runId: 'test', input: null });
const native = new NodeProcessRunner();

/** A guard run whose restore fails once, leaving baseline completed for the resume. */
async function failedRestore() {
  const state = { bodies: 0 };
  const processRunner: ProcessRunner = {
    run: (request, invocation) =>
      invocation.stepId === 'guard/restore' && invocation.attempt === 1
        ? Promise.reject(new ExecError('restore unavailable', 'process'))
        : native.run(request, invocation),
  };
  const workflow = definition(async (ctx) => {
    await ctx.exec('init', ['git', 'init', '-q']);
    await ctx.writeFile('original', 'file', 'baseline');
    return guardFile(ctx, 'guard', 'file', async () => {
      state.bodies++;
      await ctx.writeFile('mutate', 'file', 'changed');
      return 'done';
    });
  });
  await expect(runWorkflow(workflow, { ...setup(), processRunner })).rejects.toThrow(
    'restore unavailable',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('changed');
  return { state, processRunner, workflow };
}

it('replays a completed guard baseline after the Node path and program text change', async () => {
  const { state, processRunner, workflow } = await failedRestore();
  const before = (await readRun(setup())).steps['guard/baseline'];
  expect(before?.identity).toHaveProperty('helper');
  expect(before?.identity).not.toHaveProperty('command');

  const link = join(cwd, 'node-link');
  await symlink(originalExecPath, link);
  process.execPath = link;
  const { guardProgram } = await vi.importActual<typeof GuardProgram>(
    '../src/workflow/helpers/guard-program.js',
  );
  mocked.program = `${guardProgram}\n// edited\n`;

  const resumed = await runWorkflow(workflow, { ...setup(), processRunner, resume: true });
  expect(resumed.output).toBe('done');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('baseline');
  expect(state.bodies).toBe(1);

  const after = await readRun(setup());
  expect(after.steps['guard/baseline']?.identity).toEqual(before?.identity);
  expect(after.steps['guard/baseline']?.attemptHistory ?? []).toHaveLength(
    before?.attemptHistory?.length ?? 0,
  );
  // The real argv is still what runs and what inspection shows.
  const restore = after.steps['guard/restore'];
  expect(restore?.exec?.command).toEqual(
    expect.arrayContaining([link, '--input-type=module', mocked.program]),
  );
  expect(restore?.identity).toHaveProperty('helper');
  expect(restore?.identity).not.toHaveProperty('command');
});

it('refuses to resume a completed guard step after a GUARD_PROGRAM_VERSION bump', async () => {
  const { processRunner, workflow } = await failedRestore();
  mocked.version = 'guardFile/2';
  await expect(runWorkflow(workflow, { ...setup(), processRunner, resume: true })).rejects.toThrow(
    'helper changed on a completed step',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('changed');
});

it('keeps a command component, and no helper component, on an ordinary exec step', async () => {
  const command: Command = ['fake'];
  const run = await runWorkflow(
    definition((ctx) => ctx.exec('plain', command)),
    {
      ...setup(),
      processRunner: {
        run: () =>
          Promise.resolve({
            code: 0,
            signal: null,
            stdout: '',
            stderr: '',
            truncated: false,
            durationMs: 1,
          }),
      },
    },
  );
  expect(run.steps['plain']?.identity).toHaveProperty('command');
  expect(run.steps['plain']?.identity).not.toHaveProperty('helper');
});

it('pins the guard program text to GUARD_PROGRAM_VERSION', async () => {
  const actual = await vi.importActual<typeof GuardProgram>(
    '../src/workflow/helpers/guard-program.js',
  );
  const sha = createHash('sha256').update(actual.guardProgram).digest('hex');
  expect(
    { version: actual.GUARD_PROGRAM_VERSION, sha },
    'guardProgram changed. If its behavior or argv/stdout contract changed, bump GUARD_PROGRAM_VERSION (it invalidates earlier guard steps on resume); for formatting-only edits keep it. Then update the pinned hash here.',
  ).toEqual({
    version: 'guardFile/1',
    sha: '2f2e4a03e15d2934c024f7fd3574991f44543cd6d9ba9f674f71dfc1bf4f01c2',
  });
});

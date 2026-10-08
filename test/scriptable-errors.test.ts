import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isCliErrorCode } from '../src/workflow/runtime/run-errors.js';
import {
  defineWorkflow,
  isValidRunId,
  readRun,
  runWorkflow,
  RunInterruptedError,
  RunRefusedError,
  WorkflowInputError,
  WorkflowRunError,
  z,
} from '../src/index.js';
import * as store from '../src/workflow/runtime/store.js';
import { lockRun } from '../src/workflow/runtime/store.js';
import { readRequiredRun } from '../src/workflow/runtime/read-required-run.js';
import { OrphanProcessesError } from '../src/workflow/runtime/process-registry.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { readWorkflowInput } from '../src/cli/input.js';
import { jsonErrorPosition } from '../src/cli/json-position.js';
import { workflowArgvFailure } from '../src/cli/launch.js';
import {
  requestedJson,
  workflowErrorDocument,
  workflowExitCodes,
  WorkflowCommandError,
} from '../src/cli/workflow-errors.js';

vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, writeRun: vi.fn(actual.writeRun), lockRun: vi.fn(actual.lockRun) };
});
const actualStore = await vi.importActual<typeof store>('../src/workflow/runtime/store.js');
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-errors-'));
  vi.mocked(store.writeRun).mockImplementation(actualStore.writeRun);
  vi.mocked(store.lockRun).mockImplementation(actualStore.lockRun);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(stateDir, { recursive: true, force: true });
});
const options = () => ({ runId: 'run', stateDir, input: null });
const definition = defineWorkflow({
  name: 'errors',
  version: '1',
  input: z.null(),
  output: z.string(),
  run: () => Promise.resolve('done'),
});

it('wraps saved workflow failures while retaining original error identity and root step attribution', async () => {
  const original = new TypeError('effect failed');
  const workflow = defineWorkflow({
    ...definition,
    async run(ctx) {
      return ctx.step('failing', {
        input: null,
        schema: z.string(),
        run() {
          throw original;
        },
      });
    },
  });
  const error: unknown = await runWorkflow(workflow, options()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  if (!(error instanceof WorkflowRunError)) throw error;
  expect(error.cause).toBe(original);
  expect(error.stepId).toBe('failing');
  expect(error.run).toEqual(await readRun(options()));
  expect(error.run.status).toBe('failed');
  const bodyError: unknown = await runWorkflow(
    { ...definition, run: () => Promise.reject(original) },
    { ...options(), runId: 'body' },
  ).catch((cause: unknown) => cause);
  expect(bodyError).toBeInstanceOf(WorkflowRunError);
  if (!(bodyError instanceof WorkflowRunError)) throw bodyError;
  expect(bodyError.cause).toBe(original);
  expect(bodyError.stepId).toBeNull();
});

it('types input failures before a record exists and preserves the validator cause', async () => {
  const error: unknown = await runWorkflow(definition, { ...options(), input: 'wrong' }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowInputError);
  if (!(error instanceof WorkflowInputError)) throw error;
  expect(error.code).toBe('usage.input_schema');
  expect(error.cause).toBeInstanceOf(z.ZodError);
  expect(error.details).toMatchObject([{ code: 'invalid_type', path: [] }]);
  await expect(readRun(options())).rejects.toHaveProperty('code', 'ENOENT');
  await runWorkflow(definition, options());
  const before = await readFile(join(stateDir, 'run', 'run.json'), 'utf8');
  await expect(
    runWorkflow(definition, { ...options(), input: 'wrong', resume: true }),
  ).rejects.toBeInstanceOf(WorkflowInputError);
  expect(await readFile(join(stateDir, 'run', 'run.json'), 'utf8')).toBe(before);
});

it('returns typed refusals with compatibility and ownership details without changing checkpoints', async () => {
  await runWorkflow(definition, options());
  const before = await readFile(join(stateDir, 'run', 'run.json'), 'utf8');
  await expect(runWorkflow(definition, options())).rejects.toMatchObject({
    name: 'RunRefusedError',
    code: 'run.exists',
    runId: 'run',
  });
  await expect(
    runWorkflow({ ...definition, version: '2' }, { ...options(), resume: true }),
  ).rejects.toMatchObject({
    name: 'RunRefusedError',
    code: 'run.incompatible',
    details: { changed: ['version'] },
  });
  const release = await lockRun(stateDir, 'run');
  try {
    await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toMatchObject({
      code: 'run.locked',
      details: { pid: process.pid },
    });
  } finally {
    await release();
  }
  expect(await readFile(join(stateDir, 'run', 'run.json'), 'utf8')).toBe(before);
  await writeFile(join(stateDir, 'broken.json'), '{broken');
  const unreadable: unknown = await runWorkflow(definition, {
    ...options(),
    runId: 'broken',
    resume: true,
  }).catch((cause: unknown) => cause);
  expect(unreadable).toBeInstanceOf(RunRefusedError);
  if (!(unreadable instanceof RunRefusedError)) throw unreadable;
  expect(unreadable.code).toBe('run.unreadable');
  expect(unreadable.cause).toBeInstanceOf(SyntaxError);
});

it('bounds and sorts available IDs for an unknown run', async () => {
  // No registered project may hold the run: keep the candidate search off the real state.
  vi.stubEnv('XDG_STATE_HOME', join(stateDir, 'xdg'));
  for (let index = 0; index < 25; index++)
    await writeFile(join(stateDir, `run-${String(index).padStart(2, '0')}.json`), '{}');
  await writeFile(join(stateDir, 'not a run.json'), '{}');
  const error: unknown = await readRequiredRun({ stateDir, runId: 'missing' }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(RunRefusedError);
  if (!(error instanceof RunRefusedError)) throw error;
  expect(error.code).toBe('run.not_found');
  expect(error.details).toEqual({
    runId: 'missing',
    stateDir,
    count: 25,
    available: Array.from({ length: 20 }, (_, index) => `run-${String(index).padStart(2, '0')}`),
    candidates: [],
  });
  expect(error.cause).toHaveProperty('code', 'ENOENT');
  await expect(
    readRequiredRun({ stateDir: join(stateDir, 'absent'), runId: 'missing' }),
  ).rejects.toMatchObject({ details: { count: 0, available: [] } });
});

it.each(['', '../run', 'a/b', 'bad id', '_run', 'é', 'a'.repeat(129)])(
  'rejects unsafe identifier %j',
  (id) => {
    expect(isValidRunId(id)).toBe(false);
  },
);
it.each(['a', '0', 'a_b-c', 'a'.repeat(128)])('accepts safe identifier %j', (id) => {
  expect(isValidRunId(id)).toBe(true);
});

it('reads inline and file input and retains source/offset on failure', async () => {
  const signal = new AbortController().signal;
  expect(await readWorkflowInput('{"value":1}', signal)).toEqual({ value: 1 });
  await expect(readWorkflowInput('position 20', signal)).rejects.toMatchObject({
    failure: { code: 'usage.input_json', details: { source: '--input', position: 0 } },
  });
  const file = join(stateDir, 'input.json');
  await writeFile(file, '{"value":2}');
  expect(await readWorkflowInput('@' + file, signal)).toEqual({ value: 2 });
  await expect(readWorkflowInput('@' + join(stateDir, 'missing'), signal)).rejects.toMatchObject({
    failure: { code: 'usage.input_file' },
  });
  await writeFile(file, '[true, @]');
  const error: unknown = await readWorkflowInput('@' + file, signal).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowCommandError);
  if (!(error instanceof WorkflowCommandError)) throw error;
  expect(error.failure).toMatchObject({
    code: 'usage.input_json',
    details: { source: file, position: 7 },
  });
});

it.each([
  ['', 0],
  ['[true, @]', 7],
  ['[1,]', 3],
  ['{"a":}', 5],
  ['{"a" 1}', 5],
  ['[false null]', 7],
  ['{"a":nul}', 8],
  ['{"a":true', 9],
  ['"abc', 4],
  ['"\\x"', 2],
  ['"\\uX000"', 3],
  ['"a\nb"', 2],
  ['1e+', 1],
  ['01', 1],
  ['{"a":[false,null,"x\\n\\u0000"],"b":{}} junk', 38],
])('locates a syntax failure in %j', (text, offset) => {
  expect(jsonErrorPosition(text)).toBe(offset);
});

it('keeps launcher topic validation and JSON detection independent of successful parsing', () => {
  expect(requestedJson(['--json', '--', '--unknown'])).toBe(true);
  expect(requestedJson(['--', '--json'])).toBe(false);
  expect(workflowArgvFailure(['workflow', '--json', 'inspect', 'run'])).toMatchObject({
    code: 'usage.flag',
  });
  expect(workflowArgvFailure(['workflow', '--verbose', 'execute', 'file'])).toMatchObject({
    code: 'usage.flag',
  });
  expect(workflowArgvFailure(['workflow', '--help'])).toBeNull();
  expect(workflowArgvFailure(['workflow:inspect', 'run', '--help', '--json'])).toMatchObject({
    code: 'usage.flag',
  });
  expect(workflowArgvFailure(['info', 'version'])).toBeNull();
  expect(workflowArgvFailure(['workflow', 'inspect', 'run', '--json'])).toBeNull();
});

it('names the launcher in use in the usage.flag example', () => {
  const argv = ['workflow', '--json', 'inspect', 'run'];
  expect(workflowArgvFailure(argv)?.message).toContain('quiet-choir workflow inspect ID --json.');
  expect(workflowArgvFailure(argv, ['/x/node', '/y/run.js'])?.message).toBe(
    'Put flags after the command name, for example: /x/node /y/run.js workflow inspect ID --json.',
  );
  expect(workflowArgvFailure(argv, ['/x/my node', '/y/run.js'])?.message).toContain(
    "'/x/my node' /y/run.js workflow inspect ID --json.",
  );
});

it('renders explicit empty context for pre-run failures and reserves exit 1 for saved failure', () => {
  const failure = workflowFailure('load.import', 'failed import');
  expect(workflowErrorDocument(failure)).toEqual({
    kind: 'workflow.error',
    ok: false,
    exitCode: 4,
    error: { code: 'load.import', message: 'failed import', stepId: null, details: null },
    runId: null,
    stateDir: null,
    status: null,
    run: null,
    failedSteps: [],
    diagnostics: [],
    next: [],
  });
  expect(Object.entries(workflowExitCodes).filter(([, exit]) => exit === 1)).toEqual([
    ['workflow.failed', 1],
  ]);
  expect(workflowExitCodes['workflow.storage']).toBe(74);
});

it('maps the workflow start codes to their own exits and recognizes every code', () => {
  expect(workflowExitCodes['start.timeout']).toBe(124);
  expect(workflowExitCodes['start.exited']).toBe(70);
  for (const exit of [124, 70])
    expect(Object.values(workflowExitCodes).filter((code) => code === exit)).toHaveLength(1);
  for (const code of Object.keys(workflowExitCodes)) expect(isCliErrorCode(code)).toBe(true);
  for (const value of ['start.unknown', 'toString', 42, null])
    expect(isCliErrorCode(value)).toBe(false);
  const launch = {
    runId: 'r',
    pid: 7,
    log: '/s/r/launch/1.log',
    result: '/s/r/launch/1.result.json',
    exitCode: null,
    signal: 'SIGKILL',
  };
  expect(
    workflowErrorDocument(workflowFailure('start.exited', 'Runner exited.', { launch })),
  ).toMatchObject({ exitCode: 70, runId: null, launch });
  expect(workflowErrorDocument(workflowFailure('usage.flag', 'Bad flag.'))).not.toHaveProperty(
    'launch',
  );
});

it('refuses an unowned cancel with exit 3, like the other run refusals', () => {
  expect(isCliErrorCode('run.unowned')).toBe(true);
  expect(workflowExitCodes['run.unowned']).toBe(3);
  expect(
    workflowErrorDocument(
      workflowFailure('run.unowned', 'Run r1 is suspended and no process owns it.', {
        runId: 'r1',
        details: { reason: 'unlocked', signalsSent: 0, forced: false },
      }),
    ),
  ).toMatchObject({
    ok: false,
    exitCode: 3,
    error: { code: 'run.unowned', details: { reason: 'unlocked' } },
  });
});

it('refuses a held worktree administration lock with exit 3 and no run', () => {
  expect(isCliErrorCode('worktree.locked')).toBe(true);
  expect(workflowExitCodes['worktree.locked']).toBe(3);
  expect(
    workflowErrorDocument(
      workflowFailure('worktree.locked', 'Worktree administration lock /l owner PID 7 is alive.', {
        details: { lockPath: '/l', state: 'alive' },
      }),
    ),
  ).toMatchObject({
    ok: false,
    exitCode: 3,
    runId: null,
    stateDir: null,
    error: { code: 'worktree.locked', details: { state: 'alive' } },
  });
});

it('refuses an active run removal with exit 3, like the other run refusals', () => {
  expect(isCliErrorCode('run.active')).toBe(true);
  expect(workflowExitCodes['run.active']).toBe(3);
  expect(
    workflowErrorDocument(
      workflowFailure('run.active', 'Run r1 is suspended; rerun with --force to remove it.', {
        runId: 'r1',
        details: { status: 'suspended', waiting: [] },
      }),
    ),
  ).toMatchObject({ ok: false, exitCode: 3, error: { code: 'run.active' } });
});

it('gives the watch bounds their own exits, distinct from stale, suspended and interrupted', () => {
  expect(workflowExitCodes['watch.timeout']).toBe(79);
  expect(workflowExitCodes['watch.record_not_created']).toBe(66);
  for (const exit of [79, 66])
    expect(Object.values(workflowExitCodes).filter((code) => code === exit)).toHaveLength(1);
  for (const reserved of [1, 2, 3, 4, 70, 74, 75, 124, 130])
    for (const code of ['watch.timeout', 'watch.record_not_created'] as const)
      expect(workflowExitCodes[code]).not.toBe(reserved);
  expect(isCliErrorCode('watch.timeout')).toBe(true);
  expect(isCliErrorCode('watch.record_not_created')).toBe(true);
  expect(isCliErrorCode('watch.unknown')).toBe(false);
  expect(
    workflowErrorDocument(
      workflowFailure('watch.record_not_created', 'Run late was not created within 300ms.', {
        runId: 'late',
        details: { waitCreatedMs: 300 },
      }),
    ),
  ).toMatchObject({
    exitCode: 66,
    status: null,
    error: { code: 'watch.record_not_created', details: { waitCreatedMs: 300 } },
  });
});

// measured: 0.5 s alone, 1.9-3.6 s in local full coverage runs, 6.0 s on the Node 22.13 CI leg
// (real compiler passes)
it(
  'classifies a lock setup I/O failure through the executor as workflow.storage/74',
  { timeout: 15_000 },
  async () => {
    const root = join(stateDir, 'workflow-lock');
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
    const file = join(root, 'workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({
  name: 'lock-storage', version: '1', input: z.null(), output: z.string(),
  run: () => Promise.resolve('done'),
});`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
    if (!analysis.ok) throw new Error(analysis.error.message);
    vi.mocked(lockRun).mockRejectedValueOnce(
      Object.assign(new Error('injected EACCES'), { code: 'EACCES' }),
    );
    const result = await new WorkflowExecutor({ logger: { log: vi.fn() } }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'lock-storage',
      stateDir: join(stateDir, 'state'),
      cwd: root,
      resume: false,
      input: null,
    });
    if (result.ok) throw new Error('expected a failure');
    expect(result.code).toBe('workflow.storage');
    expect(workflowExitCodes[result.code]).toBe(74);
    expect(result.message).toContain('injected EACCES');
  },
);

// measured: 1.2 s alone, 2.7-4.0 s in local full coverage runs, 6.3 s on the Node 22.13 CI leg
// (real compiler passes)
it(
  'keeps a failed cancellation save as a storage failure when an interrupt also occurs',
  { timeout: 15_000 },
  async () => {
    const root = join(stateDir, 'workflow');
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
    const file = join(root, 'workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({
  name: 'interrupted-storage', version: '1', input: z.null(), output: z.string(),
  run: (ctx) => ctx.step('wait', {
    input: null,
    schema: z.string(),
    run: ({ signal }) => new Promise<string>((_, reject) => {
      const stop = () => { reject(signal.reason as Error); };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }),
  }),
});`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const controller = new AbortController();
    const result = await new WorkflowExecutor({
      signal: controller.signal,
      logger: {
        log(_level, message) {
          // Debug events are `<at> <runId> <type> <detail>`.
          if (!message.includes(' step.started wait ')) return;
          // Every save after the interrupt, including the cancellation snapshot, fails.
          vi.mocked(store.writeRun).mockRejectedValue(
            Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' }),
          );
          controller.abort();
        },
      },
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'interrupted',
      stateDir: join(stateDir, 'state'),
      cwd: root,
      resume: false,
      input: null,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'workflow.storage' });
    if (result.ok) throw new Error('expected a failure');
    expect(workflowExitCodes[result.code]).toBe(74);
    expect(result.message).toContain('injected ENOSPC');
    expect(
      (await readRun({ runId: 'interrupted', stateDir: join(stateDir, 'state') })).status,
    ).toBe('running');
  },
);

// measured: 0.4 s alone, 1.7-3.6 s in local full coverage runs, 5.1 s on the Node 22.13 CI leg
// (real compiler passes)
it(
  'keeps a saved failed checkpoint as a workflow failure when a signal also arrives',
  { timeout: 15_000 },
  async () => {
    const root = join(stateDir, 'workflow');
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
    const file = join(root, 'workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
const hooks = globalThis as unknown as { choirBodyWaiting?: () => void };
export default defineWorkflow({
  name: 'interrupted-failure', version: '1', input: z.null(), output: z.string(),
  // Application code that turns the abort into its own ordinary error, outside any effect.
  run: (ctx) => new Promise<string>((_, reject) => {
    ctx.signal.addEventListener('abort', () => { reject(new Error('application failure')); }, { once: true });
    hooks.choirBodyWaiting?.();
  }),
});`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const controller = new AbortController();
    const hooks = globalThis as { choirBodyWaiting?: () => void };
    hooks.choirBodyWaiting = () => {
      controller.abort();
    };
    try {
      const result = await new WorkflowExecutor({
        signal: controller.signal,
        logger: { log: vi.fn() },
      }).execute({
        kind: 'workflow.execute',
        typecheck: analysis.plan,
        runId: 'interrupted-failure',
        stateDir: join(stateDir, 'state'),
        cwd: root,
        resume: false,
        input: null,
      });
      expect(controller.signal.aborted).toBe(true);
      if (result.ok) throw new Error('expected a failure');
      expect(result.code).toBe('workflow.failed');
      expect(result.message).toContain('application failure');
      expect(workflowErrorDocument(result)).toMatchObject({
        exitCode: 1,
        error: { code: 'workflow.failed', details: { errorKind: null, retryable: false } },
        status: 'failed',
        run: { status: 'failed', error: 'application failure' },
      });
    } finally {
      delete hooks.choirBodyWaiting;
    }
  },
);

// measured: 0.5 s alone; the same real compiler pass as the neighbouring signal case dominates
// (1.7-3.6 s in local full coverage runs, 5.1 s on the Node 22.13 CI leg)
it('maps a saved interrupted suspension to workflow.interrupted', { timeout: 15_000 }, async () => {
  const root = join(stateDir, 'workflow');
  await mkdir(root);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  const file = join(root, 'workflow.ts');
  await writeFile(
    file,
    `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
const hooks = globalThis as unknown as { choirStepWaiting?: () => void };
export default defineWorkflow({
  name: 'interrupted-suspension', version: '1', input: z.null(), output: z.string(),
  run: (ctx) => ctx.step('wait', {
    input: null,
    schema: z.string(),
    run: ({ signal }) => new Promise<string>((_, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error); }, { once: true });
      hooks.choirStepWaiting?.();
    }),
  }),
});`,
  );
  const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
  if (!analysis.ok) throw new Error(analysis.error.message);
  const controller = new AbortController();
  const hooks = globalThis as { choirStepWaiting?: () => void };
  hooks.choirStepWaiting = () => {
    controller.abort(new RunInterruptedError('Workflow interrupted by SIGTERM.'));
  };
  try {
    const result = await new WorkflowExecutor({
      signal: controller.signal,
      logger: { log: vi.fn() },
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'interrupted-suspension',
      stateDir: join(stateDir, 'state'),
      cwd: root,
      resume: false,
      input: null,
    });
    if (result.ok) throw new Error('expected a failure');
    expect(result.code).toBe('workflow.interrupted');
    expect(workflowExitCodes[result.code]).toBe(130);
    expect(result.message).toBe('Workflow interrupted by SIGTERM.');
    expect(workflowErrorDocument(result)).toMatchObject({
      exitCode: 130,
      error: { code: 'workflow.interrupted', details: null },
      status: 'suspended',
      run: {
        status: 'suspended',
        error: null,
        interruptedBy: { reason: 'Workflow interrupted by SIGTERM.' },
      },
    });
  } finally {
    delete hooks.choirStepWaiting;
  }
});

// measured: 1.1 s alone, 3.7 s in the full local coverage run (three real compiler passes; the
// one-pass lock test above takes 6.0 s on the Node 22.13 CI leg, so this allows about 18 s there)
it(
  'puts runnable next entries on failed, empty, orphaned, dry-run and moved-entrypoint failures',
  { timeout: 40_000 },
  async () => {
    const root = join(stateDir, 'workflow-next');
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
    const file = join(root, 'workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({
  name: 'next-entries', version: '1', input: z.boolean().nullable(), output: z.string(),
  run: (ctx, early) => early
    ? Promise.reject(new Error('body failed'))
    : ctx.step('flaky', { input: null, schema: z.string(), run: () => { throw new Error('flaky failed'); } }),
});`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const runs = join(stateDir, 'state');
    const launcher = ['/x/node', '/y/run.js'];
    const executor = new WorkflowExecutor({ logger: { log: vi.fn() }, commandLauncher: launcher });
    const resume = (...flags: string[]) => [
      ...launcher,
      'workflow',
      'resume',
      'next-run',
      '--state-dir',
      runs,
      ...flags,
    ];
    const failed = await executor.execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'next-run',
      stateDir: runs,
      cwd: root,
      resume: false,
      input: null,
    });
    if (failed.ok) throw new Error('expected a failure');
    expect(failed.code).toBe('workflow.failed');
    expect(failed.next?.map((entry) => entry.argv)).toEqual([resume()]);
    expect(workflowErrorDocument(failed)).toMatchObject({ next: [{ argv: resume() }] });

    // A body that fails before recording any step gets no hint and no next entry (#284).
    const empty = await executor.execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'empty-run',
      stateDir: runs,
      cwd: root,
      resume: false,
      input: true,
    });
    if (empty.ok) throw new Error('expected a failure');
    expect(empty.code).toBe('workflow.failed');
    expect(empty.run?.steps).toEqual({});
    expect(empty.run?.recoveryHint).toBeUndefined();
    expect(empty.run?.recoveryCause).toEqual({ kind: 'authoring' });
    expect(empty.next).toBeUndefined();
    expect(workflowErrorDocument(empty)).toMatchObject({ next: [] });

    const rehearsal = await executor.execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'next-run',
      stateDir: runs,
      cwd: root,
      resume: true,
      dryRun: true,
    });
    if (rehearsal.ok) throw new Error('expected a rehearsal failure');
    expect(rehearsal.next).toBeUndefined();
    expect(workflowErrorDocument(rehearsal)).toMatchObject({ next: [] });

    vi.mocked(lockRun).mockRejectedValueOnce(new OrphanProcessesError('next-run', []));
    const orphans = await executor.execute({
      kind: 'workflow.resume',
      runId: 'next-run',
      stateDir: runs,
    });
    if (orphans.ok) throw new Error('expected an orphan refusal');
    expect(orphans.code).toBe('run.orphans');
    expect(orphans.next?.[0]?.argv).toEqual(resume('--kill-orphans'));

    const stored = await realpath(file);
    await rename(root, `${root}-moved`);
    const moved = await executor.execute({
      kind: 'workflow.resume',
      runId: 'next-run',
      stateDir: runs,
    });
    if (moved.ok) throw new Error('expected a refusal');
    expect(moved.code).toBe('run.incompatible');
    expect(workflowExitCodes[moved.code]).toBe(3);
    expect(moved.details).toEqual({ storedEntrypoint: stored, reason: 'entrypoint_missing' });
    expect(moved.next?.[0]?.argv).toEqual([
      ...launcher,
      'workflow',
      'execute',
      '<ENTRYPOINT>',
      '--fork-from',
      'next-run',
      '--run-id',
      '<NEW_RUN_ID>',
      '--state-dir',
      runs,
    ]);

    // A different FILE does not hide the deleted stored entrypoint behind a mismatch refusal
    // whose resume entry could not succeed.
    const other = join(stateDir, 'other.workflow.ts');
    await writeFile(other, 'export {};');
    const different = await executor.execute({
      kind: 'workflow.execute',
      typecheck: { ...analysis.plan, entrypoint: other },
      runId: 'next-run',
      stateDir: runs,
      cwd: root,
      resume: true,
    });
    if (different.ok) throw new Error('expected a refusal');
    expect(different.code).toBe('run.incompatible');
    expect(different.details).toEqual({ storedEntrypoint: stored, reason: 'entrypoint_missing' });
    expect(different.next?.[0]?.argv).toContain('<ENTRYPOINT>');
  },
);

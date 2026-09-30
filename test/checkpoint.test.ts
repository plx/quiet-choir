/* eslint-disable @typescript-eslint/no-deprecated -- Exercise the supported legacy map/replay contract. */
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  CheckpointError,
  defineWorkflow,
  readRun,
  RunRefusedError,
  runWorkflow,
  writeAnswer,
  z,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';
import * as store from '../src/workflow/runtime/store.js';

vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, writeRun: vi.fn(actual.writeRun), lockRun: vi.fn(actual.lockRun) };
});
const actualStore = await vi.importActual<typeof store>('../src/workflow/runtime/store.js');
const ioError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });
let stateDir: string;

function workflow(run: WorkflowDefinition<null, string>['run']): WorkflowDefinition<null, string> {
  return defineWorkflow({
    name: 'checkpoint',
    version: '1',
    input: z.null(),
    output: z.string(),
    run,
  });
}
function options(): { runId: string; stateDir: string; input: null } {
  return { runId: 'run', stateDir, input: null };
}
function failRelease(error: Error): void {
  vi.mocked(store.lockRun).mockImplementation(async (...args) => {
    const release = await actualStore.lockRun(...args);
    return Object.assign(() => Promise.reject(error), {
      trackProcess: release.trackProcess.bind(release),
    });
  });
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-checkpoint-'));
  vi.mocked(store.writeRun).mockImplementation(actualStore.writeRun);
  vi.mocked(store.lockRun).mockImplementation(actualStore.lockRun);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('does not claim a suspended transition that failed to persist', async () => {
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    record.status === 'suspended'
      ? Promise.reject(ioError('ENOSPC'))
      : actualStore.writeRun(directory, record),
  );
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.ask('question', { prompt: 'Answer?', schema: z.string() })),
      options(),
    ),
  ).rejects.toThrow('ENOSPC');
  const saved = await readRun(options());
  expect(saved.status).toBe('failed');
  expect(saved.steps['question']?.status).toBe('waiting');
  expect(saved.events?.some((event) => event.type === 'run.suspended')).toBe(false);
  expect((await store.inspectRunOwnership(options())).locked).toBe(false);
});

it('recovers an accepted answer through a later failure save without requesting it again', async () => {
  const definition = workflow((ctx) =>
    ctx.ask('question', { prompt: 'Answer?', schema: z.string() }),
  );
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  await writeAnswer({ ...options(), stepId: 'question', value: 'saved' });
  let unavailable = true;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (
      unavailable &&
      record.status === 'running' &&
      record.steps['question']?.status === 'completed'
    ) {
      return Promise.reject(ioError('ENOSPC'));
    }
    return actualStore.writeRun(directory, record);
  });
  await expect(runWorkflow(definition, { ...options(), resume: true })).rejects.toThrow('ENOSPC');
  unavailable = false;
  expect((await readRun(options())).steps['question']?.status).toBe('completed');
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.output).toBe('saved');
  expect(resumed.steps['question']?.attempts).toBe(1);
});

it('retries transient completion writes without retrying the successful action', async () => {
  let failures = 0;
  const action = vi.fn(() => 'done');
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.steps['effect']?.status === 'completed' && failures++ < 2)
      return Promise.reject(ioError('EACCES'));
    return actualStore.writeRun(directory, record);
  });
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.step('effect', {
        input: null,
        schema: z.string(),
        retry: { maxAttempts: 3 },
        run: action,
      }),
    ),
    options(),
  );
  expect(result.status).toBe('completed');
  expect(result.output).toBe('done');
  expect(action).toHaveBeenCalledTimes(1);
  expect((await readRun({ stateDir, runId: 'run' })).steps['effect']).toMatchObject({
    status: 'completed',
    attempts: 1,
    error: null,
  });
});

it('recovers the ordered queue for a later save, aborts new work, and retains a successful effect', async () => {
  let failures = 0;
  const action = vi.fn(() => 'done');
  const next = vi.fn(() => 'next');
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.steps['effect']?.status === 'completed' && failures++ < 3)
      return Promise.reject(ioError('EIO'));
    return actualStore.writeRun(directory, record);
  });
  const definition = workflow(async (ctx) => {
    await ctx
      .step('effect', { input: null, schema: z.string(), retry: { maxAttempts: 3 }, run: action })
      .catch(() => {
        /* Deliberately try to continue after the checkpoint failure. */
      });
    return ctx.step('next', { input: null, schema: z.string(), run: next });
  });
  await expect(runWorkflow(definition, options())).rejects.toMatchObject({
    name: 'WorkflowRunError',
    cause: { name: 'CheckpointError', operation: 'save' },
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
  const saved = await readRun({ stateDir, runId: 'run' });
  expect(saved.status).toBe('failed');
  expect(saved.steps['effect']).toMatchObject({ status: 'completed', error: null, attempts: 1 });
  expect(saved.steps['next']).toBeUndefined();
  expect(saved.error).toContain('completed but its checkpoint write failed');
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  expect(resumed.output).toBe('next');
  expect(action).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
});

it('keeps the domain error first when failure saves and lock release all fail', async () => {
  const original = new Error('ORIGINAL: deploy rejected (HTTP 409)');
  let unwritable = false;
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    unwritable ? Promise.reject(ioError('ENOSPC')) : actualStore.writeRun(directory, record),
  );
  failRelease(ioError('EACCES'));
  const action = vi.fn(() => {
    unwritable = true;
    throw original;
  });
  const error: unknown = await runWorkflow(
    workflow((ctx) =>
      ctx.step('deploy', {
        input: null,
        schema: z.string(),
        retry: { maxAttempts: 3 },
        run: action,
      }),
    ),
    options(),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregate');
  expect(error.message).toMatch(/^ORIGINAL: deploy rejected \(HTTP 409\)/u);
  expect(error.cause).toBe(original);
  expect(error.errors[0]).toBe(original);
  const problems = error.errors.slice(1) as CheckpointError[];
  expect(problems.map((problem) => problem.operation)).toEqual(['save', 'save', 'release']);
  expect(problems[0]?.cause).toMatchObject({ code: 'ENOSPC' });
  expect(action).toHaveBeenCalledTimes(1);
  const saved = await readRun({ stateDir, runId: 'run' });
  expect(saved).toMatchObject({ status: 'running', error: null });
  expect(saved.steps['deploy']).toMatchObject({ status: 'running', error: null });
});

it('still retries an action failure after its transient failure-save error recovers', async () => {
  let writeFailed = false;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.steps['effect']?.status === 'failed' && !writeFailed) {
      writeFailed = true;
      return Promise.reject(ioError('EBUSY'));
    }
    return actualStore.writeRun(directory, record);
  });
  const action = vi
    .fn()
    .mockRejectedValueOnce(new Error('retryable domain error'))
    .mockResolvedValue('done');
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.step('effect', {
        input: null,
        schema: z.string(),
        retry: { maxAttempts: 2, delayMs: 0 },
        run: action,
      }),
    ),
    options(),
  );
  expect(result.output).toBe('done');
  expect(action).toHaveBeenCalledTimes(2);
  expect(result.steps['effect']?.attempts).toBe(2);
});

it('does not replace a workflow-body error with a failed run save', async () => {
  const original = new Error('body failed');
  let failed = false;
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    failed ? Promise.reject(ioError('EIO')) : actualStore.writeRun(directory, record),
  );
  const error: unknown = await runWorkflow(
    workflow(() => {
      failed = true;
      return Promise.reject(original);
    }),
    options(),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregate');
  expect(error.cause).toBe(original);
  expect(error.message).toMatch(/^body failed/u);
  expect(error.errors[1]).toBeInstanceOf(CheckpointError);
});

it('classifies a lock setup I/O failure as a checkpoint error but keeps contention refusals distinct', async () => {
  vi.mocked(store.lockRun).mockRejectedValueOnce(ioError('ENOSPC'));
  const body = vi.fn(() => Promise.resolve('done'));
  await expect(runWorkflow(workflow(body), options())).rejects.toMatchObject({
    name: 'CheckpointError',
    operation: 'lock',
    message: expect.stringContaining('Could not acquire run run lock') as unknown,
    cause: { code: 'ENOSPC' },
  });
  expect(body).not.toHaveBeenCalled();
  const refusal = new RunRefusedError('run.locked', 'run', 'Run run is locked by PID 1.', {
    pid: 1,
  });
  vi.mocked(store.lockRun).mockRejectedValueOnce(refusal);
  await expect(runWorkflow(workflow(body), options())).rejects.toBe(refusal);
  expect(body).not.toHaveBeenCalled();
});

it('does not start the body when its initial checkpoint cannot be saved', async () => {
  vi.mocked(store.writeRun).mockRejectedValue(ioError('EACCES'));
  const body = vi.fn(() => Promise.resolve('done'));
  await expect(runWorkflow(workflow(body), options())).rejects.toBeInstanceOf(CheckpointError);
  expect(body).not.toHaveBeenCalled();
  expect(store.writeRun).toHaveBeenCalledTimes(3);
});

it('rejects a failed final run checkpoint without reclassifying completed effects or claiming completion', async () => {
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    record.status === 'completed'
      ? Promise.reject(ioError('EIO'))
      : actualStore.writeRun(directory, record),
  );
  const action = vi.fn(() => 'done');
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.step('effect', { input: null, schema: z.string(), run: action })),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'WorkflowRunError',
    cause: expect.any(CheckpointError) as unknown,
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect((await readRun({ stateDir, runId: 'run' })).steps['effect']).toMatchObject({
    status: 'completed',
    error: null,
  });
  const saved = await readRun(options());
  expect(saved.events?.map((event) => event.type)).toEqual(['run.started', 'run.failed']);
  expect(saved.executions?.[0]?.outcome).toBe('failed');
});

it('owns phase/log saves and preserves committed observations after a storage failure', async () => {
  let failures = 0;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.events?.some((event) => event.type === 'log') && failures++ < 3) {
      return Promise.reject(ioError('ENOSPC'));
    }
    return actualStore.writeRun(directory, record);
  });
  await expect(
    runWorkflow(
      workflow((ctx) => {
        ctx.phase('local');
        ctx.log('diagnostic');
        return Promise.resolve('done');
      }),
      options(),
    ),
  ).rejects.toThrow('ENOSPC');
  const saved = await readRun(options());
  expect(saved.status).toBe('failed');
  expect(saved.events?.some((event) => event.type === 'run.completed')).toBe(false);
  expect(saved.events?.some((event) => event.message === 'diagnostic')).toBe(true);
  expect(saved.executions?.[0]?.outcome).toBe('failed');
});

it.each(['EACCES', 'ENOENT'])(
  'returns persisted completion and an invocation warning when release fails with %s',
  async (code) => {
    failRelease(ioError(code));
    const result = await runWorkflow(
      workflow(() => Promise.resolve('done')),
      options(),
    );
    expect(result.output).toBe('done');
    expect(result.status).toBe('completed');
    expect(result.warnings?.[0]).toContain('Could not release run run lock');
    expect(result.warnings?.[0]).toContain(code);
    const saved = await readRun({ stateDir, runId: 'run' });
    expect(saved.status).toBe('completed');
    expect(saved).not.toHaveProperty('warnings');
  },
);

it('keeps ownership loss fatal even after persisting completion', async () => {
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await ctx.step('replace-owner', {
          input: null,
          schema: z.null(),
          async run() {
            const path = join(stateDir, 'run', 'lock', 'owner.json');
            const owner = z
              .object({ pid: z.number(), host: z.string(), token: z.string() })
              .parse(JSON.parse(await readFile(path, 'utf8')));
            await writeFile(path, JSON.stringify({ ...owner, token: 'different-owner' }));
            return null;
          },
        });
        return 'done';
      }),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'CheckpointError',
    operation: 'release',
    message: 'Could not release run run lock: Run run lock ownership was lost.',
  });
  expect((await readRun({ stateDir, runId: 'run' })).status).toBe('completed');
});

it('keeps unknown release failures fatal and retains earlier validation errors', async () => {
  const releaseError = new SyntaxError('corrupt owner metadata');
  failRelease(releaseError);
  await expect(
    runWorkflow(
      workflow(() => Promise.resolve('done')),
      options(),
    ),
  ).rejects.toMatchObject({ operation: 'release', cause: releaseError });
  await rm(join(stateDir, 'run', 'lock'), { recursive: true });
  const error: unknown = await runWorkflow(
    workflow(() => Promise.resolve('done')),
    { ...options(), runId: 'bad-input', input: 'wrong' },
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregate');
  expect(error.errors[0]).toMatchObject({
    name: 'WorkflowInputError',
    cause: expect.any(z.ZodError) as unknown,
  });
  expect(error.errors[1]).toMatchObject({ operation: 'release', cause: releaseError });
});

it('names removal of the state directory instead of a lock owner ENOENT', async () => {
  const error: unknown = await runWorkflow(
    workflow(async (ctx) =>
      ctx.step('remove-state', {
        input: null,
        schema: z.string(),
        async run() {
          await rm(stateDir, { recursive: true });
          return 'done';
        },
      }),
    ),
    options(),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregate');
  expect(error.message).toContain(
    `State directory ${stateDir} was removed while run run was active.`,
  );
  expect(error.message).not.toContain('owner.json');
  expect(error.errors[0]).toBeInstanceOf(CheckpointError);
  await expect(stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('warns about a removed lock while returning the actual persisted completion', async () => {
  const result = await runWorkflow(
    workflow(async (ctx) =>
      ctx.step('remove-lock', {
        input: null,
        schema: z.string(),
        async run() {
          await rm(join(stateDir, 'run', 'lock'), { recursive: true });
          return 'done';
        },
      }),
    ),
    options(),
  );
  expect(result.output).toBe('done');
  expect(result.warnings).toHaveLength(1);
  expect((await readRun({ stateDir, runId: 'run' })).output).toBe('done');
});

const asRoot = process.getuid?.() === 0;
const ownerPath = (): string => join(stateDir, 'run', 'lock', 'owner.json');
function stepThen(effect: () => Promise<void>): WorkflowDefinition<null, string> {
  return workflow(async (ctx) => {
    await ctx.step('tamper', {
      input: null,
      schema: z.null(),
      async run() {
        await effect();
        return null;
      },
    });
    return 'done';
  });
}

it('warns when both locks of a migrated run vanish before release', async () => {
  let fail = true;
  const definition = workflow(async (ctx) => {
    if (fail) throw new Error('tail');
    return ctx.step('remove-locks', {
      input: null,
      schema: z.string(),
      async run() {
        await rm(join(stateDir, 'run', 'lock'), { recursive: true });
        await rm(join(stateDir, 'run.json.lock'), { recursive: true });
        return 'done';
      },
    });
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
  const record = await readRun(options());
  record.formatVersion = 6;
  delete record.seq;
  delete record.engine;
  await rm(join(stateDir, 'run'), { recursive: true });
  await store.writeRun(stateDir, record);
  fail = false;
  const result = await runWorkflow(definition, { ...options(), resume: true });
  expect(result.output).toBe('done');
  expect(result.warnings).toEqual([expect.stringContaining('Could not release run run lock')]);
  expect(result.warnings?.[0]).toContain('ENOENT');
  expect((await readRun(options())).formatVersion).toBe(7);
});

it('keeps release fatal when only the lock ownership metadata disappears', async () => {
  await expect(
    runWorkflow(
      stepThen(() => rm(ownerPath())),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'CheckpointError',
    operation: 'release',
    message: expect.stringContaining('lock ownership could not be verified') as unknown,
  });
  expect((await readRun({ stateDir, runId: 'run' })).status).toBe('completed');
});

it.skipIf(asRoot)('keeps release fatal when lock ownership metadata is unreadable', async () => {
  try {
    await expect(
      runWorkflow(
        stepThen(() => chmod(ownerPath(), 0o000)),
        options(),
      ),
    ).rejects.toMatchObject({
      name: 'CheckpointError',
      operation: 'release',
      message: expect.stringContaining('lock ownership could not be verified') as unknown,
      cause: { cause: { code: 'EACCES' } },
    });
    expect((await readRun({ stateDir, runId: 'run' })).status).toBe('completed');
  } finally {
    await chmod(ownerPath(), 0o600);
  }
});

it.skipIf(asRoot)('warns when lock removal fails after ownership was verified', async () => {
  const lockPath = join(stateDir, 'run', 'lock');
  try {
    const result = await runWorkflow(
      stepThen(() => chmod(lockPath, 0o500)),
      options(),
    );
    expect(result.output).toBe('done');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('EACCES');
    expect((await readRun({ stateDir, runId: 'run' })).status).toBe('completed');
  } finally {
    // Release renamed the verified lock to a tombstone; only its removal failed.
    for (const name of await readdir(join(stateDir, 'run')))
      if (name.startsWith('lock')) await chmod(join(stateDir, 'run', name), 0o700);
  }
});

it('cancels every sibling whose coalesced start batch could not commit', async () => {
  let failures = 0;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.status === 'running' && record.steps['second'] && failures++ < 3)
      return Promise.reject(ioError('EIO'));
    return actualStore.writeRun(directory, record);
  });
  const first = vi.fn(() => 'first');
  const second = vi.fn(() => 'second');
  const third = vi.fn(() => 'third');
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await Promise.all([
          ctx.step('first', { input: null, schema: z.string(), run: first }),
          ctx.step('second', { input: null, schema: z.string(), run: second }),
          ctx.step('third', { input: null, schema: z.string(), run: third }),
        ]);
        return 'done';
      }),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'WorkflowRunError',
    cause: expect.any(CheckpointError) as unknown,
  });
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  expect(third).not.toHaveBeenCalled();
  expect((await readRun(options())).status).toBe('failed');
});

it('preserves a successful sibling result after storage-triggered cancellation', async () => {
  let failures = 0;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.steps['second']?.status === 'completed' && failures++ < 3)
      return Promise.reject(ioError('EIO'));
    return actualStore.writeRun(directory, record);
  });
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await Promise.all([
          ctx.step('first', {
            input: null,
            schema: z.string(),
            run({ signal }) {
              return new Promise<string>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    resolve('external action succeeded');
                  },
                  { once: true },
                );
              });
            },
          }),
          ctx.step('second', { input: null, schema: z.string(), run: () => 'done' }),
        ]);
        return 'done';
      }),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'WorkflowRunError',
    cause: expect.any(CheckpointError) as unknown,
  });
  const saved = await readRun({ stateDir, runId: 'run' });
  expect(saved.steps['first']).toMatchObject({
    status: 'completed',
    output: 'external action succeeded',
    error: null,
    attempts: 1,
  });
  expect(saved.steps['second']).toMatchObject({
    status: 'completed',
    output: 'done',
    error: null,
    attempts: 1,
  });
});

it('labels a sibling cancelled by a checkpoint failure as a workflow cancellation', async () => {
  let failures = 0;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    if (record.steps['second']?.status === 'completed' && failures++ < 3)
      return Promise.reject(ioError('EIO'));
    return actualStore.writeRun(directory, record);
  });
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await Promise.all([
          ctx.step('first', {
            input: null,
            schema: z.string(),
            run({ signal }) {
              return new Promise<string>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    reject(new DOMException('stopped', 'AbortError'));
                  },
                  { once: true },
                );
              });
            },
          }),
          ctx.step('second', { input: null, schema: z.string(), run: () => 'done' }),
        ]);
        return 'done';
      }),
      options(),
    ),
  ).rejects.toMatchObject({
    name: 'WorkflowRunError',
    cause: expect.any(CheckpointError) as unknown,
  });
  const saved = await readRun({ stateDir, runId: 'run' });
  // The run controller, not a map, aborted this scope.
  expect(saved.steps['first']).toMatchObject({
    status: 'cancelled',
    error: 'Workflow cancelled.',
    cancelledBy: null,
  });
  expect(saved.status).toBe('failed');
});

it('does not return a settled outcome when its checkpoint cannot be committed', async () => {
  const original = new Error('domain failure before settlement');
  const action = vi.fn(() => {
    throw original;
  });
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    record.steps['effect']?.status === 'settled-failed'
      ? Promise.reject(ioError('ENOSPC'))
      : actualStore.writeRun(directory, record),
  );
  const error: unknown = await runWorkflow(
    workflow(async (ctx) => {
      await ctx.step('effect', { input: null, schema: z.string(), onError: 'return', run: action });
      return 'must not branch on an uncommitted failure';
    }),
    options(),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).cause).toBe(original);
  expect(String(error)).toContain('ENOSPC');
  expect(action).toHaveBeenCalledTimes(1);
  expect((await readRun(options())).steps['effect']?.status).toBe('running');
});

it('preserves a mapper body failure when saving its settled outcome also fails', async () => {
  const original = new Error('mapper rejected');
  vi.mocked(store.writeRun).mockImplementation((directory, record) =>
    record.maps?.['items']?.items[0]?.status === 'completed'
      ? Promise.reject(ioError('ENOSPC'))
      : actualStore.writeRun(directory, record),
  );
  const error: unknown = await runWorkflow(
    workflow(async (ctx) => {
      await ctx.map([0], 1, () => Promise.reject(original), { onError: 'settle', id: 'items' });
      return 'unreachable';
    }),
    options(),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw error;
  expect(error.cause).toBe(original);
  expect(error.errors[0]).toBe(original);
  expect(error.errors.slice(1)).toEqual([expect.any(CheckpointError), expect.any(CheckpointError)]);
  expect((await readRun(options())).maps?.['items']?.items[0]?.status).toBe('running');
});

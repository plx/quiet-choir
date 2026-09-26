import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CheckpointError, defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
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
    await actualStore.lockRun(...args);
    return () => Promise.reject(error);
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
    name: 'CheckpointError',
    operation: 'save',
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

it('does not start the body when its initial checkpoint cannot be saved', async () => {
  vi.mocked(store.writeRun).mockRejectedValue(ioError('EACCES'));
  const body = vi.fn(() => Promise.resolve('done'));
  await expect(runWorkflow(workflow(body), options())).rejects.toBeInstanceOf(CheckpointError);
  expect(body).not.toHaveBeenCalled();
  expect(store.writeRun).toHaveBeenCalledTimes(3);
});

it('rejects a failed final run checkpoint without reclassifying completed effects', async () => {
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
  ).rejects.toBeInstanceOf(CheckpointError);
  expect(action).toHaveBeenCalledTimes(1);
  expect((await readRun({ stateDir, runId: 'run' })).steps['effect']).toMatchObject({
    status: 'completed',
    error: null,
  });
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
            const path = join(stateDir, 'run.json.lock', 'owner.json');
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
  await rm(join(stateDir, 'run.json.lock'), { recursive: true });
  const error: unknown = await runWorkflow(
    workflow(() => Promise.resolve('done')),
    { ...options(), runId: 'bad-input', input: 'wrong' },
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregate');
  expect(error.errors[0]).toBeInstanceOf(z.ZodError);
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
          await rm(join(stateDir, 'run.json.lock'), { recursive: true });
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

it('checks cancellation after a queued start save recovers, before launching its action', async () => {
  let writes = 0;
  vi.mocked(store.writeRun).mockImplementation((directory, record) => {
    writes++;
    return writes >= 3 && writes <= 5
      ? Promise.reject(ioError('EIO'))
      : actualStore.writeRun(directory, record);
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
  ).rejects.toBeInstanceOf(CheckpointError);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  expect(third).not.toHaveBeenCalled();
  expect(writes).toBeGreaterThan(5);
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
  ).rejects.toBeInstanceOf(CheckpointError);
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

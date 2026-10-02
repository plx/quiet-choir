import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  z,
  type Command,
  type ExecResult,
  type ExecStepError,
  type HarnessInvocation,
  type PollErrorPolicy,
  type PollSource,
  type ProcessRunner,
  type ProcessRunRequest,
  type Settled,
  type StepContext,
  type WorkflowContext,
  type WorktreeHandle,
} from '../src/index.js';
import { FixtureProcessRunner } from '../src/harnesses/fixture-exec.js';
import { RehearsalHarness } from '../src/workflow/loader/rehearsal.js';

let cwd: string;
let stateDir: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-step-exec-')));
  stateDir = join(cwd, 'state');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'step-exec', version: '1', input: z.null(), output: z.unknown(), run });
const setup = (runId = 'test') => ({ cwd, stateDir, runId, input: null });
const reply = (stdout = '', code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  truncated: false,
  durationMs: 1,
});
const node = (code: string): Command => [process.execPath, '-e', code];

/** A runner that records each request and invocation and answers with `answer`. */
function recorder(answer: (request: ProcessRunRequest) => ExecResult = () => reply('{}')) {
  const seen: { request: ProcessRunRequest; invocation: HarnessInvocation }[] = [];
  const runner: ProcessRunner = {
    run: (request, invocation) => {
      seen.push({ request, invocation });
      return Promise.resolve(answer(request));
    },
  };
  return { seen, runner };
}

/** A poll that completes on its first check with whatever `observe` returns. */
function poll<T>(
  ctx: WorkflowContext,
  id: string,
  schema: z.ZodType<T>,
  observe: PollSource<T>['observe'],
  extra: { readonly onError?: PollErrorPolicy } = {},
) {
  return ctx.poll(id, { input: null, schema, every: 1, timeoutMs: 60_000, observe, ...extra });
}

describe('types', () => {
  it('types exec and exec.json in step callbacks and poll observers, with live only for observers', () => {
    const schema = z.object({ number: z.number() });
    interface Pr {
      number: number;
    }
    const check = (ctx: WorkflowContext, handle: WorktreeHandle) => {
      void ctx.step('typed', {
        input: null,
        schema: z.null(),
        run: (context) => {
          expectTypeOf(context.exec.json(['gh', 'pr', 'view'], { schema })).toEqualTypeOf<
            Promise<Pr>
          >();
          expectTypeOf(
            context.exec.json(['gh', 'pr', 'view'], { schema, onError: 'return' }),
          ).toEqualTypeOf<Promise<Settled<Pr, ExecStepError>>>();
          expectTypeOf(context.exec(['gh', 'pr', 'view'])).toEqualTypeOf<Promise<ExecResult>>();
          expectTypeOf(context.exec(['gh'], { onError: 'return' })).toEqualTypeOf<
            Promise<Settled<ExecResult, ExecStepError>>
          >();
          // @ts-expect-error live is accepted only by poll observers.
          void context.exec(['gh'], { live: true });
          // @ts-expect-error live is accepted only by poll observers.
          void context.exec.json(['gh'], { schema, live: true });
          // @ts-expect-error inner commands cannot select a worktree.
          void context.exec(['gh'], { worktree: handle });
          // @ts-expect-error inner commands are never retried by the runtime.
          void context.exec(['gh'], { retry: { maxAttempts: 2 } });
          return null;
        },
      });
      void poll(ctx, 'observed', schema, async (context) => {
        expectTypeOf(context.exec.json(['gh', 'pr', 'view'], { schema })).toEqualTypeOf<
          Promise<Pr>
        >();
        expectTypeOf(
          context.exec.json(['gh', 'pr', 'view'], { schema, onError: 'return' }),
        ).toEqualTypeOf<Promise<Settled<Pr, ExecStepError>>>();
        expectTypeOf(context.exec.json(['gh'], { schema, live: true })).toEqualTypeOf<
          Promise<Pr>
        >();
        expectTypeOf(context.exec(['gh'], { live: true, onError: 'return' })).toEqualTypeOf<
          Promise<Settled<ExecResult, ExecStepError>>
        >();
        // @ts-expect-error inner commands cannot select a worktree.
        void context.exec(['gh'], { worktree: handle });
        // A poll context is still usable where a step context is expected.
        expectTypeOf(context).toExtend<StepContext>();
        return { done: true, value: await context.exec.json(['gh'], { schema }) };
      });
    };
    expect(check).toBeTypeOf('function');
  });
});

describe('step callbacks', () => {
  it('rejects live, worktree and retry at runtime before reaching the runner', async () => {
    const { seen, runner } = recorder();
    for (const [index, options] of [
      { live: true },
      { worktree: { kind: 'worktree', id: 'w' } },
      { retry: { maxAttempts: 2 } },
    ].entries()) {
      const failure = await runWorkflow(
        definition((ctx) =>
          ctx.step('parent', {
            input: null,
            schema: z.unknown(),
            // A JavaScript author can pass anything; the strict schema refuses it.
            run: (context) => context.exec(['gh'], options as unknown as Record<string, never>),
          }),
        ),
        { ...setup(`bad-${String(index)}`), processRunner: runner },
      ).catch((error: unknown) => error);
      expect(String(failure)).toMatch(/Step parent: invalid context\.exec options/u);
      expect(String(failure)).toContain(Object.keys(options)[0]);
    }
    expect(seen).toEqual([]);
  });

  it('runs under the parent step and attempt with exec defaults, overrides and env overlay', async () => {
    const { seen, runner } = recorder((request) => reply(request.schema ? '{"n":1}' : 'plain'));
    await mkdir(join(cwd, 'sub'));
    const run = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: async (context) => {
            const plain = await context.exec(['gh', 'pr', 'list'], { env: { TOKEN_HINT: 'x' } });
            const parsed = await context.exec.json(['gh', 'pr', 'view'], {
              schema: z.object({ n: z.number() }),
              cwd: 'sub',
              timeoutMs: 1234,
              maxOutputBytes: 99,
              input: 'stdin',
            });
            return { plain: plain.stdout, parsed };
          },
        }),
      ),
      { ...setup(), processRunner: runner },
    );
    expect(run.output).toEqual({ plain: 'plain', parsed: { n: 1 } });
    expect(seen.map(({ invocation }) => [invocation.stepId, invocation.attempt])).toEqual([
      ['parent', 1],
      ['parent', 1],
    ]);
    expect(seen[0]?.request).toEqual({
      command: ['gh', 'pr', 'list'],
      cwd,
      env: { TOKEN_HINT: 'x' },
      inheritEnv: true,
      input: '',
      timeoutMs: 300_000,
      maxOutputBytes: 1_048_576,
      capture: 'truncate',
      schema: null,
      nested: true,
    });
    expect(seen[1]?.request).toMatchObject({
      cwd: join(cwd, 'sub'),
      input: 'stdin',
      timeoutMs: 1234,
      maxOutputBytes: 99,
      capture: 'error',
      nested: true,
    });
    expect(seen[1]?.request.schema).toMatchObject({ type: 'object' });
    // Inner commands write no checkpoint and no step record of their own.
    expect(Object.keys(run.steps)).toEqual(['parent']);
    const saved = await readRun({ stateDir, runId: 'test' });
    expect(Object.keys(saved.steps)).toEqual(['parent']);
    expect(saved.steps['parent']?.exec).toBeUndefined();
  });

  it('rejects a reserved environment key and an exec.json call without a schema', async () => {
    const { seen, runner } = recorder();
    const reserved = runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: (context) => context.exec(['gh'], { env: { QUIET_CHOIR_STEP_ID: 'spoof' } }),
        }),
      ),
      { ...setup('reserved'), processRunner: runner },
    );
    await expect(reserved).rejects.toThrow('reserved');
    const schemaless = runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: (context) =>
            context.exec.json(['gh'], {} as { schema: z.ZodType }),
        }),
      ),
      { ...setup('schemaless'), processRunner: runner },
    );
    await expect(schemaless).rejects.toThrow(
      'Step parent: context.exec.json requires a Zod schema.',
    );
    expect(seen).toEqual([]);
  });

  it('gives the child the parent step metadata and idempotency key', async () => {
    const run = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: async (context) => ({
            key: context.idempotencyKey,
            env: await context.exec.json(
              node(
                `const e=process.env;console.log(JSON.stringify({key:e.QUIET_CHOIR_IDEMPOTENCY_KEY,step:e.QUIET_CHOIR_STEP_ID,attempt:e.QUIET_CHOIR_ATTEMPT,run:e.QUIET_CHOIR_RUN_ID}))`,
              ),
              { schema: z.record(z.string(), z.string()) },
            ),
          }),
        }),
      ),
      { ...setup(), processRunner: new NodeProcessRunner() },
    );
    expect(run.output).toEqual({
      key: 'test/parent',
      env: { key: 'test/parent', step: 'parent', attempt: '1', run: 'test' },
    });
  });

  it('prefers execRunner and lets exec fixture rules answer inner commands by the parent ID', async () => {
    const real = recorder(() => reply('real'));
    const fixtures = new FixtureProcessRunner(
      {
        version: 1,
        calls: [],
        exec: [
          { step: 'parent', argvPrefix: ['gh', 'pr', 'view'], json: { state: 'OPEN' } },
          { step: 'parent', argvPrefix: ['gh', 'pr', 'checks'], stdout: 'green' },
        ],
      },
      real.runner,
    );
    const unused = recorder();
    const run = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: async (context) => ({
            view: await context.exec.json(['gh', 'pr', 'view', '1'], {
              schema: z.object({ state: z.string() }),
            }),
            checks: (await context.exec(['gh', 'pr', 'checks', '1'])).stdout,
            other: (await context.exec(['gh', 'api', 'user'])).stdout,
          }),
        }),
      ),
      { ...setup(), processRunner: unused.runner, execRunner: fixtures },
    );
    expect(run.output).toEqual({ view: { state: 'OPEN' }, checks: 'green', other: 'real' });
    expect(real.seen.map(({ request }) => request.command)).toEqual([['gh', 'api', 'user']]);
    expect(unused.seen).toEqual([]);
  });

  it('records an uncaught inner failure as ExecError with bounded tails in the attempt history', async () => {
    const failing = node(
      `process.stdout.write('o'.repeat(3000));process.stderr.write('e'.repeat(3000));process.exit(3)`,
    );
    const failure = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: (context) => context.exec(failing),
        }),
      ),
      { ...setup(), processRunner: new NodeProcessRunner() },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const step = (await readRun({ stateDir, runId: 'test' })).steps['parent'];
    expect(step?.status).toBe('failed');
    const attempt = step?.attemptHistory?.[0];
    expect(attempt?.errorKind).toBe('process');
    expect(attempt?.execError).toMatchObject({ code: 3, signal: null });
    expect(attempt?.execError?.stdoutTail).toBe('o'.repeat(1024));
    expect(attempt?.execError?.stderrTail).toBe('e'.repeat(1024));
    expect(step?.execError).toEqual(attempt?.execError);
  });

  it('throws ExecError kinds to a catching callback and settles onError return without saving it', async () => {
    const { runner } = recorder((request) =>
      Array.isArray(request.command) && request.command[0] === 'fail'
        ? { ...reply('{"partial":true}', 4), stderr: 'x'.repeat(2000) }
        : reply('not json'),
    );
    const run = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          run: async (context) => {
            const process = await context.exec(['fail']).catch((error: unknown) => error);
            const schema = await context.exec
              .json(['bad'], { schema: z.object({ ok: z.boolean() }) })
              .catch((error: unknown) => error);
            const settled = await context.exec.json(['fail'], {
              schema: z.object({ ok: z.boolean() }),
              onError: 'return',
            });
            const succeeded = await context.exec(['ok'], { onError: 'return', okExitCodes: 'any' });
            return {
              process: process instanceof ExecError ? process.kind : 'other',
              schema:
                schema instanceof ExecError ? [schema.kind, schema.parsed === undefined] : 'other',
              settled,
              succeeded: succeeded.ok,
            };
          },
        }),
      ),
      { ...setup(), processRunner: runner },
    );
    expect(run.output).toEqual({
      process: 'process',
      schema: ['schema', true],
      settled: {
        ok: false,
        error: {
          message: 'Command exited with 4.',
          kind: 'process',
          attempts: 1,
          code: 4,
          signal: null,
          stdoutTail: '{"partial":true}',
          stderrTail: 'x'.repeat(1024),
          parsed: { partial: true },
        },
      },
      succeeded: true,
    });
    const saved = await readRun({ stateDir, runId: 'test' });
    expect(Object.keys(saved.steps)).toEqual(['parent']);
    expect(saved.steps['parent']?.status).toBe('completed');
    expect(saved.steps['parent']?.settledError).toBeUndefined();
  });

  it('terminates an un-awaited inner command when its callback returns and refuses later calls', async () => {
    const pidFile = join(cwd, 'pid');
    let late: StepContext['exec'] | undefined;
    let abandoned: Promise<unknown> | undefined;
    await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            abandoned = context.exec(
              node(
                `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`,
              ),
            );
            // Return only once the child is running, so the abort really has to stop it.
            await vi.waitFor(() => readFile(pidFile, 'utf8'), { timeout: 5000, interval: 20 });
            late = context.exec;
            return null;
          },
        }),
      ),
      { ...setup(), processRunner: new NodeProcessRunner() },
    );
    // The run waited for the terminated command before completing its step.
    await expect(abandoned).rejects.toThrow(/cancelled/u);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(late?.(['gh'])).rejects.toThrow(
      'Step parent: context.exec must be called while its callback is active.',
    );
    expect(await readRun({ stateDir, runId: 'test' })).toMatchObject({ status: 'completed' });
  });
});

describe('poll observers', () => {
  it('runs inner commands under the wait ID and lets onError.classify see ExecError', async () => {
    let calls = 0;
    const { seen, runner } = recorder((request) =>
      ++calls === 1 ? reply('', 1) : reply(request.schema ? '{"merged":true}' : ''),
    );
    const classified: unknown[] = [];
    const run = await runWorkflow(
      definition((ctx) =>
        poll(
          ctx,
          'pr-merged',
          z.object({ merged: z.boolean() }),
          async (context) => {
            await context.exec(['gh', 'pr', 'checks']);
            const value = await context.exec.json(['gh', 'pr', 'view'], {
              schema: z.object({ merged: z.boolean() }),
            });
            return { done: true, value };
          },
          {
            onError: {
              tolerate: 2,
              classify: (error) => {
                classified.push(error);
                return 'transient';
              },
              retryAfterMs: () => 0,
            },
          },
        ),
      ),
      { ...setup(), processRunner: runner, waitMode: 'block' },
    );
    expect(run.output).toMatchObject({ by: 'poll', value: { merged: true } });
    expect(classified).toHaveLength(1);
    expect(classified[0]).toBeInstanceOf(ExecError);
    expect((classified[0] as ExecError).diagnostics.code).toBe(1);
    expect(seen.map(({ invocation }) => [invocation.stepId, invocation.attempt])).toEqual([
      ['pr-merged', 1],
      ['pr-merged', 1],
      ['pr-merged', 1],
    ]);
    expect(seen.every(({ request }) => request.nested === true)).toBe(true);
    expect(Object.keys(run.steps)).toEqual(['pr-merged']);
  });

  it('uses execRunner for live outside a rehearsal and never spawns in an accepted-change preflight', async () => {
    const exec = recorder(() => reply('{"open":true}'));
    const process = recorder(() => reply('{"open":false}'));
    const observed = (ctx: WorkflowContext) =>
      poll(ctx, 'live', z.object({ open: z.boolean() }), async (context) => ({
        done: true,
        value: await context.exec.json(['gh', 'pr', 'view'], {
          schema: z.object({ open: z.boolean() }),
          live: true,
        }),
      }));
    const normal = await runWorkflow(definition(observed), {
      ...setup('normal'),
      processRunner: process.runner,
      execRunner: exec.runner,
      waitMode: 'block',
    });
    expect(normal.output).toMatchObject({ value: { open: true } });
    expect(process.seen).toEqual([]);
    // The preflight passes the rehearsal's synthesizing runner as processRunner, so live is
    // synthesized too.
    const rehearsal = new RehearsalHarness({ kind: 'cli', config: {} });
    const preflight = await runWorkflow(definition(observed), {
      ...setup('preflight'),
      harness: rehearsal,
      rehearsal: rehearsal.hooks,
      processRunner: rehearsal.processRunner,
      waitMode: 'block',
    });
    expect(preflight.status).toBe('completed');
    expect(rehearsal.report(preflight).commands).toEqual([
      expect.objectContaining({
        stepId: 'live',
        parentStepId: 'live',
        outputSource: 'synthesized',
      }),
    ]);
  });
});

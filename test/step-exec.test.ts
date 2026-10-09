import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
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
  type CommandPollOptions,
  type CommandPollSource,
  type DeadlineOutcome,
  type ExecResult,
  type ExecStepError,
  type HarnessInvocation,
  type JsonValue,
  type PollCommandExecOptions,
  type PollErrorPolicy,
  type PollOutcome,
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
import { prepareExec } from '../src/workflow/runtime/exec.js';
import {
  MAX_INNER_COMMAND_BYTES,
  MAX_INNER_COMMANDS,
} from '../src/workflow/runtime/inner-commands.js';

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
  extra: { readonly onError?: PollErrorPolicy; readonly observeTimeoutMs?: number } = {},
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
          // @ts-expect-error inner commands write no step record to label.
          void context.exec.json(['gh'], { schema, meta: { integration: 'github' } });
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
        // @ts-expect-error inner commands write no step record to label.
        void context.exec(['gh'], { meta: { integration: 'github' } });
        // A poll context is still usable where a step context is expected.
        expectTypeOf(context).toExtend<StepContext>();
        return { done: true, value: await context.exec.json(['gh'], { schema }) };
      });
    };
    expect(check).toBeTypeOf('function');
  });
});

describe('command poll types', () => {
  it('infers the output, value and note types of a command poll and keeps it apart from observe', () => {
    const checks = z.array(z.object({ name: z.string(), state: z.string() }));
    type Checks = z.infer<typeof checks>;
    const check = async (ctx: WorkflowContext) => {
      const outcome = await ctx.poll('ci', {
        input: { pr: 1 },
        schema: z.enum(['green', 'red']),
        every: 30_000,
        timeoutMs: 600_000,
        command: ['gh', 'pr', 'checks', '1', '--json', 'name,state'],
        output: checks,
        commandOptions: { maxOutputBytes: 65_536, env: { GH_PAGER: '' } },
        live: true,
        done: (output, previous) => {
          expectTypeOf(output).toEqualTypeOf<Checks>();
          expectTypeOf(previous.note).toEqualTypeOf<JsonValue | null>();
          expectTypeOf(previous.checks).toEqualTypeOf<number>();
          return output.every((entry) => entry.state === 'SUCCESS')
            ? // As with an observer, a literal value needs `as const` against an enum schema.
              { done: true, value: 'green' as const }
            : { done: false, note: { pending: output.length } };
        },
      });
      expectTypeOf(outcome).toEqualTypeOf<PollOutcome<'green' | 'red'> | DeadlineOutcome>();
      await ctx.poll<boolean, Checks, { seen: boolean }>('typed-note', {
        input: null,
        schema: z.boolean(),
        every: 1,
        deadline: 1,
        command: { shell: 'gh pr checks 1 --json name,state' },
        output: checks,
        // done may be asynchronous.
        done: async (_output, previous) => {
          expectTypeOf(previous.note).toEqualTypeOf<{ seen: boolean } | null>();
          return Promise.resolve({ done: false, note: { seen: true } });
        },
      });
      // With noteSchema, N is inferred: no type arguments needed.
      await ctx.poll('schema-note', {
        input: null,
        schema: z.boolean(),
        every: 1,
        deadline: 1,
        command: ['gh', 'pr', 'checks', '1'],
        output: checks,
        noteSchema: z.object({ green: z.boolean() }),
        done: (output, previous) => {
          expectTypeOf(output).toEqualTypeOf<Checks>();
          expectTypeOf(previous.note).toEqualTypeOf<{ green: boolean } | null>();
          return { done: false, note: { green: previous.note?.green ?? output.length === 0 } };
        },
      });
      // ctx.wait accepts the command form too; there done's output is unknown, so narrow it.
      const waited = await ctx.wait('either', {
        timeoutMs: 1,
        poll: {
          input: null,
          schema: z.literal('done'),
          every: 1,
          command: ['gh', 'pr', 'view'],
          output: z.object({ state: z.string() }),
          done: (output) => {
            expectTypeOf(output).toEqualTypeOf<unknown>();
            return (output as { state: string }).state === 'MERGED'
              ? { done: true, value: 'done' }
              : { done: false };
          },
        },
      });
      expectTypeOf(waited).toEqualTypeOf<PollOutcome<'done'> | DeadlineOutcome>();
    };
    expect(check).toBeTypeOf('function');
    // The two forms exclude each other, and a command poll's options have no timeoutMs or onError.
    expectTypeOf<CommandPollSource<null>['observe']>().toEqualTypeOf<undefined>();
    expectTypeOf<PollSource<null>['command']>().toEqualTypeOf<undefined>();
    expectTypeOf<PollCommandExecOptions>().not.toHaveProperty('timeoutMs');
    expectTypeOf<PollCommandExecOptions>().not.toHaveProperty('onError');
    expectTypeOf<PollCommandExecOptions>().toHaveProperty('maxOutputBytes');
    expectTypeOf<{
      input: null;
      schema: z.ZodNull;
      every: 1;
      timeoutMs: 1;
      command: ['gh'];
      output: z.ZodNull;
      done: () => { done: false };
      observe: () => Promise<{ done: false }>;
    }>().not.toExtend<CommandPollOptions<null, null>>();
    expectTypeOf<{
      input: null;
      schema: z.ZodNull;
      every: 1;
      timeoutMs: 1;
      command: ['gh'];
      output: z.ZodNull;
      commandOptions: { timeoutMs: 1 };
      done: () => { done: false };
    }>().not.toExtend<CommandPollOptions<null, null>>();
  });
});

describe('step callbacks', () => {
  it('rejects live, worktree, retry and meta at runtime before reaching the runner', async () => {
    const { seen, runner } = recorder();
    for (const [index, options] of [
      { live: true },
      { worktree: true },
      { retry: { maxAttempts: 2 } },
      { meta: { integration: 'github' } },
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
          run: (context) => context.exec.json(['gh'], {} as { schema: z.ZodType }),
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

  it('answers identical inner commands of one step differently by call, and per attempt', async () => {
    const real = recorder(() => reply('real'));
    const fixtures = new FixtureProcessRunner(
      {
        version: 1,
        calls: [],
        exec: [
          { step: 'parent', attempt: 2, call: 1, stdout: 'retry' },
          { step: 'parent', call: 1, stdout: 'a' },
          { step: 'parent', call: 2, stdout: 'b' },
        ],
        commands: 'fixture',
      },
      real.runner,
    );
    let attempts = 0;
    const run = await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.unknown(),
          retry: { maxAttempts: 2, delayMs: 1 },
          run: async (context) => {
            const first = (await context.exec(['gh', 'pr', 'checks'])).stdout;
            const second = (await context.exec(['gh', 'pr', 'checks'])).stdout;
            if (++attempts === 1) throw new Error('retry once');
            return { first, second };
          },
        }),
      ),
      { ...setup(), processRunner: recorder().runner, execRunner: fixtures },
    );
    // The retry reruns the callback, so attempt 2 restarts at call 1.
    expect(attempts).toBe(2);
    expect(run.output).toEqual({ first: 'retry', second: 'b' });
    expect(real.seen).toEqual([]);
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

  it('rejects meta at runtime before reaching the runner', async () => {
    const { seen, runner } = recorder();
    const failure = await runWorkflow(
      definition((ctx) =>
        poll(ctx, 'observed', z.unknown(), async (context) => ({
          done: true,
          // A JavaScript author can pass anything; the strict schema refuses it.
          value: await context.exec(['gh'], {
            meta: { integration: 'github' },
          } as unknown as Record<string, never>),
        })),
      ),
      { ...setup(), processRunner: runner, waitMode: 'block' },
    ).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/Wait observed: invalid context\.exec options/u);
    expect(String(failure)).toContain('meta');
    expect(seen).toEqual([]);
  });

  it('stops an inner command when observeTimeoutMs aborts the observation', async () => {
    const pidFile = join(cwd, 'pid');
    const failure = await runWorkflow(
      definition((ctx) =>
        poll(
          ctx,
          'slow',
          z.null(),
          async (context) => {
            const hanging = context.exec(
              node(
                `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`,
              ),
            );
            await hanging;
            return { done: true, value: null };
          },
          { observeTimeoutMs: 1500 },
        ),
      ),
      { ...setup(), processRunner: new NodeProcessRunner(), waitMode: 'block' },
    ).catch((error: unknown) => error);
    expect(String(failure)).toContain('observeTimeoutMs');
    // The child writes its PID within milliseconds; only a stalled machine could abort it first,
    // and then it never ran long enough to matter.
    const pid = await readFile(pidFile, 'utf8').catch(() => null);
    if (pid !== null) expect(() => process.kill(Number(pid), 0)).toThrow();
  });

  it('answers the repeated identical command of a block-mode poll differently on each check', async () => {
    const State = z.object({ state: z.string() });
    const fixtures = () =>
      new FixtureProcessRunner(
        {
          version: 1,
          calls: [],
          exec: [
            { step: 'ci', call: 1, json: { state: 'pending' } },
            { step: 'ci', call: 2, json: { state: 'success' } },
          ],
          commands: 'fixture',
        },
        recorder().runner,
      );
    let observed = 0;
    const observer = await runWorkflow(
      definition((ctx) =>
        poll(ctx, 'ci', z.object({ state: z.literal('success') }), async (context) => {
          observed++;
          const checks = await context.exec.json(['gh', 'pr', 'checks'], { schema: State });
          return checks.state === 'success'
            ? { done: true, value: { state: 'success' as const } }
            : { done: false };
        }),
      ),
      {
        ...setup('observer'),
        processRunner: recorder().runner,
        execRunner: fixtures(),
        waitMode: 'block',
      },
    );
    expect(observed).toBe(2);
    expect(observer.output).toMatchObject({ by: 'poll', value: { state: 'success' } });

    let done = 0;
    const command = await runWorkflow(
      definition((ctx) =>
        ctx.poll('ci', {
          input: null,
          schema: z.literal('success'),
          every: 1,
          timeoutMs: 60_000,
          command: ['gh', 'pr', 'checks'],
          output: State,
          done: (output) => {
            done++;
            return output.state === 'success'
              ? { done: true, value: 'success' as const }
              : { done: false };
          },
        }),
      ),
      {
        ...setup('command'),
        processRunner: recorder().runner,
        execRunner: fixtures(),
        waitMode: 'block',
      },
    );
    expect(done).toBe(2);
    expect(command.output).toMatchObject({ by: 'poll', value: 'success' });
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

describe('inner command records (#317)', () => {
  /** A deferred answer, so a test can settle commands in any order. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('records commands in the order they reach the runner, whatever order they settle in', async () => {
    const pending: { command: Command; answer: ReturnType<typeof deferred<ExecResult>> }[] = [];
    const runner: ProcessRunner = {
      run: (request) => {
        const answer = deferred<ExecResult>();
        pending.push({ command: request.command, answer });
        // Settle in reverse arrival order once all three have arrived.
        if (pending.length === 3)
          for (const [index, entry] of [...pending].reverse().entries())
            setTimeout(() => {
              entry.answer.resolve(reply(JSON.stringify(`out-${String(index)}`)));
            }, index * 5);
        return answer.promise;
      },
    };
    await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            await Promise.all([
              context.exec(['gh', 'a']),
              context.exec(['gh', 'b']),
              context.exec.json(['gh', 'c'], { schema: z.string() }),
            ]);
            return null;
          },
        }),
      ),
      { ...setup(), processRunner: runner },
    );
    const inner = (await readRun({ stateDir, runId: 'test' })).steps['parent']?.innerCommands;
    expect(inner?.attempt).toBe(1);
    expect(inner?.commands.map((entry) => entry.command)).toEqual(
      pending.map((entry) => entry.command),
    );
    expect(inner?.commands.map((entry) => entry.result?.stdout)).toEqual([
      '"out-2"',
      '"out-1"',
      '"out-0"',
    ]);
    const structured = inner?.commands.find((entry) => entry.structured);
    expect(structured?.command).toEqual(['gh', 'c']);
    expect(inner).not.toHaveProperty('omitted');
  });

  it('keeps a contiguous prefix within the command and byte bounds and counts the rest', async () => {
    const many = recorder(() => reply('x'));
    await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            for (let index = 0; index <= MAX_INNER_COMMANDS; index++)
              await context.exec(['gh', String(index)]);
            return null;
          },
        }),
      ),
      { ...setup('many'), processRunner: many.runner },
    );
    const counted = (await readRun({ stateDir, runId: 'many' })).steps['parent']?.innerCommands;
    expect(counted?.commands).toHaveLength(MAX_INNER_COMMANDS);
    expect(counted?.commands.at(-1)?.command).toEqual(['gh', String(MAX_INNER_COMMANDS - 1)]);
    expect(counted?.omitted).toBe(1);

    // Three 400 KiB outputs pass 1 MiB at the third; a small fourth is still omitted.
    const big = 'b'.repeat(400 * 1024);
    const large = recorder((request) =>
      reply((request.command as readonly string[])[1] === 'small' ? 's' : big),
    );
    await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            for (const name of ['one', 'two', 'three', 'small'])
              await context.exec(['gh', name], { maxOutputBytes: 2 * MAX_INNER_COMMAND_BYTES });
            return null;
          },
        }),
      ),
      { ...setup('large'), processRunner: large.runner },
    );
    const bounded = (await readRun({ stateDir, runId: 'large' })).steps['parent']?.innerCommands;
    expect(bounded?.commands.map((entry) => entry.command)).toEqual([
      ['gh', 'one'],
      ['gh', 'two'],
    ]);
    expect(bounded?.omitted).toBe(2);
  });

  it('records a runner rejection as an error and drops the record on an attempt without commands', async () => {
    let attempts = 0;
    const runner: ProcessRunner = {
      run: () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })),
    };
    const run = (runId: string, onSettled?: (attempt: number) => void) =>
      runWorkflow(
        definition((ctx) =>
          ctx.step('parent', {
            input: null,
            schema: z.null(),
            retry: { maxAttempts: 2, delayMs: 1 },
            run: async (context) => {
              attempts++;
              onSettled?.(attempts);
              if (attempts === 1) await context.exec(['gh', 'missing']);
              return null;
            },
          }),
        ),
        { ...setup(runId), processRunner: runner },
      );
    // Attempt 1 fails on the missing command; attempt 2 runs none.
    let saved: unknown;
    await run('retry', (attempt) => {
      if (attempt === 2)
        saved = readRun({ stateDir, runId: 'retry' }).then(
          (record) => record.steps['parent']?.innerCommands,
        );
    });
    expect(await saved).toEqual({
      attempt: 1,
      commands: [
        expect.objectContaining({
          command: ['gh', 'missing'],
          error: { kind: 'process', message: 'spawn gh ENOENT' },
        }),
      ],
    });
    const step = (await readRun({ stateDir, runId: 'retry' })).steps['parent'];
    expect(step?.status).toBe('completed');
    expect(step).not.toHaveProperty('innerCommands');
  });

  it('stores only the environment and stdin digests', async () => {
    const env = { SECRET_TOKEN: 'env-secret-value' };
    const input = 'stdin-secret-value';
    const runner = recorder(() => reply('done'));
    await runWorkflow(
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.string(),
          run: async (context) => (await context.exec(['gh', 'auth'], { env, input })).stdout,
        }),
      ),
      { ...setup(), processRunner: runner.runner },
    );
    expect(runner.seen[0]?.request.env).toEqual(env);
    const directory = join(stateDir, 'test');
    for (const name of await readdir(directory, { recursive: true })) {
      const text = await readFile(join(directory, name), 'utf8').catch(() => '');
      expect(text, name).not.toContain('env-secret-value');
      expect(text, name).not.toContain('stdin-secret-value');
    }
    const { summary } = await prepareExec(['gh', 'auth'], { env, input }, cwd, false);
    const [entry] =
      (await readRun({ stateDir, runId: 'test' })).steps['parent']?.innerCommands?.commands ?? [];
    expect(entry?.envSha256).toBe(summary.envSha256);
    expect(entry?.inputSha256).toBe(summary.inputSha256);
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'command',
      'envSha256',
      'inputSha256',
      'result',
      'structured',
    ]);
  });

  it('leaves the step fingerprint and identity alone', async () => {
    let issue = true;
    const workflow = definition((ctx) =>
      ctx.step('parent', {
        input: null,
        schema: z.null(),
        run: async (context) => {
          // A closed-over value is not part of the identity, so both runs share one.
          if (issue) await context.exec(['gh', 'status']);
          return null;
        },
      }),
    );
    await runWorkflow(workflow, { ...setup('with'), processRunner: recorder().runner });
    issue = false;
    await runWorkflow(workflow, { ...setup('without'), processRunner: recorder().runner });
    const withInner = (await readRun({ stateDir, runId: 'with' })).steps['parent'];
    const without = (await readRun({ stateDir, runId: 'without' })).steps['parent'];
    expect(withInner?.innerCommands?.commands).toHaveLength(1);
    expect(without).not.toHaveProperty('innerCommands');
    expect(withInner?.fingerprint).toBe(without?.fingerprint);
    expect(withInner?.identity).toEqual(without?.identity);
  });

  it('reruns nothing when a completed run resumes, and replaces the record when an interrupted callback reruns', async () => {
    const workflow = (command: Command, hang: boolean) =>
      definition((ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            await context.exec(command);
            if (hang)
              await new Promise((_, reject) => {
                context.signal.addEventListener('abort', () => {
                  reject(context.signal.reason as Error);
                });
              });
            return null;
          },
        }),
      );
    await runWorkflow(workflow(['gh', 'once'], false), {
      ...setup('done'),
      processRunner: recorder().runner,
    });
    const before = (await readRun({ stateDir, runId: 'done' })).steps['parent'];
    const again = recorder();
    const resumed = await runWorkflow(workflow(['gh', 'once'], false), {
      ...setup('done'),
      resume: true,
      processRunner: again.runner,
    });
    expect(resumed.status).toBe('completed');
    expect(again.seen).toEqual([]);
    expect((await readRun({ stateDir, runId: 'done' })).steps['parent']).toEqual(before);

    const controller = new AbortController();
    const first = recorder();
    const interrupted = runWorkflow(workflow(['gh', 'first'], true), {
      ...setup('cut'),
      processRunner: {
        run: (request, invocation) => {
          setTimeout(() => {
            controller.abort(new Error('interrupted'));
          }, 5);
          return first.runner.run(request, invocation);
        },
      },
      signal: controller.signal,
    });
    await expect(interrupted).rejects.toThrow();
    expect(first.seen).toHaveLength(1);
    const rerun = recorder();
    const completed = await runWorkflow(workflow(['gh', 'second'], false), {
      ...setup('cut'),
      resume: true,
      processRunner: rerun.runner,
    });
    expect(completed.status).toBe('completed');
    expect(rerun.seen.map(({ request }) => request.command)).toEqual([['gh', 'second']]);
    const inner = (await readRun({ stateDir, runId: 'cut' })).steps['parent']?.innerCommands;
    expect(inner?.attempt).toBe(2);
    expect(inner?.commands.map((entry) => entry.command)).toEqual([['gh', 'second']]);
  });

  it('keeps only a wait terminal observation, and nothing for a wait that ends by deadline', async () => {
    let checks = 0;
    const polled = await runWorkflow(
      definition((ctx) =>
        poll(ctx, 'ci', z.literal('green'), async (context) => {
          checks++;
          const out = await context.exec(['gh', 'check', String(checks)]);
          return checks === 3 ? { done: true, value: out.stdout as 'green' } : { done: false };
        }),
      ),
      {
        ...setup('poll'),
        processRunner: recorder(() => reply('green')).runner,
        waitMode: 'block',
      },
    );
    expect(polled.output).toMatchObject({ by: 'poll', value: 'green', checks: 3 });
    const inner = (await readRun({ stateDir, runId: 'poll' })).steps['ci']?.innerCommands;
    expect(inner).toEqual({
      attempt: 1,
      commands: [expect.objectContaining({ command: ['gh', 'check', '3'] })],
    });

    const expired = await runWorkflow(
      definition((ctx) =>
        ctx.poll('late', {
          input: null,
          schema: z.null(),
          every: 1,
          timeoutMs: 30,
          observe: async (context) => {
            await context.exec(['gh', 'never']);
            return { done: false };
          },
        }),
      ),
      { ...setup('late'), processRunner: recorder().runner, waitMode: 'block' },
    );
    expect(expired.output).toMatchObject({ by: 'deadline' });
    expect((await readRun({ stateDir, runId: 'late' })).steps['late']).not.toHaveProperty(
      'innerCommands',
    );
  });
});

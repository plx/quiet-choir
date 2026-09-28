import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  runWorkflow,
  readRun,
  z,
  NodeProcessRunner,
  ExecError,
  ConfigurationError,
  WorkflowRunError,
  guardFile,
  type WorkflowContext,
  type ProcessRunner,
  type ExecOptions,
  type Command,
} from '../src/index.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { RehearsalHarness } from '../src/workflow/loader/rehearsal.js';
import { OutputCapture } from '../src/processes/capture.js';
import { fileDigest } from '../src/workflow/runtime/files.js';

let cwd: string;
let stateDir: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-exec-files-')));
  stateDir = join(cwd, 'state');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'exec-files', version: '1', input: z.null(), output: z.unknown(), run });
const setup = () => ({ cwd, stateDir, runId: 'test', input: null });
const native = new NodeProcessRunner();
const reply = {
  code: 0,
  signal: null,
  stdout: 'hello',
  stderr: '',
  truncated: false,
  durationMs: 1,
};
const node = (code: string): Command => [process.execPath, '-e', code];

it('runs argv with literal metacharacters and supplies cwd, stdin, attempt, and engine environment', async () => {
  const command = node(
    `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),env:process.env,input:data,args:process.argv.slice(1)})));`,
  );
  const run = await runWorkflow(
    definition(async (ctx) => {
      expect(ctx.cwd).toBe(cwd);
      await ctx.step('context', {
        input: null,
        schema: z.null(),
        run: (context) => {
          expect(context.cwd).toBe(cwd);
          return null;
        },
      });
      return ctx
        .within('scope')
        .exec.json('argv', [...(command as readonly [string, ...string[]]), '$(echo unsafe); *'], {
          schema: z.object({
            cwd: z.string(),
            env: z.record(z.string(), z.string()),
            input: z.string(),
            args: z.array(z.string()),
          }),
          env: { ONLY: 'present' },
          inheritEnv: false,
          input: 'private stdin',
        });
    }),
    { ...setup(), processRunner: native },
  );
  expect(run.output).toMatchObject({
    cwd,
    input: 'private stdin',
    args: ['$(echo unsafe); *'],
    env: {
      ONLY: 'present',
      QUIET_CHOIR_IDEMPOTENCY_KEY: 'test/scope/argv',
      QUIET_CHOIR_RUN_ID: 'test',
      QUIET_CHOIR_STEP_ID: 'scope/argv',
      QUIET_CHOIR_ATTEMPT: '1',
    },
  });
  expect((run.output as { env: Record<string, string> }).env['HOME']).toBeUndefined();
  expect(run.steps['scope/argv']?.identity).not.toHaveProperty('timeoutMs');
});

it('keeps explicit env and stdin out of records when command output does not echo them', async () => {
  const run = await runWorkflow(
    definition((ctx) =>
      ctx.exec('quiet', node(''), {
        env: { SECRET: 'env-secret-value' },
        input: 'stdin-secret-value',
      }),
    ),
    { ...setup(), processRunner: native },
  );
  const record = JSON.stringify(run);
  expect(record).not.toContain('env-secret-value');
  expect(record).not.toContain('stdin-secret-value');
  expect(run.steps['quiet']?.exec).toMatchObject({ structured: false, inheritEnv: true });
});

it('saves failed exits and stderr tails, then resumes with raised execution policy', async () => {
  let limits: ExecOptions = { timeoutMs: 3000, maxOutputBytes: 2048 };
  const workflow = definition((ctx) =>
    ctx.exec(
      'red',
      node(
        `process.stderr.write('x'.repeat(3000)+'TAIL');process.exitCode=process.env.QUIET_CHOIR_ATTEMPT==='1'?7:0;`,
      ),
      limits,
    ),
  );
  await expect(runWorkflow(workflow, { ...setup(), processRunner: native })).rejects.toThrow(
    'Command exited with 7',
  );
  const before = await readRun(setup());
  expect(before.steps['red']).toMatchObject({
    status: 'failed',
    execError: { code: 7, truncated: true, stderrTail: 'x'.repeat(1020) + 'TAIL' },
  });
  expect(before.steps['red']?.attemptHistory?.[0]).toMatchObject({
    errorKind: 'process',
    execError: { code: 7 },
  });
  limits = { timeoutMs: 6000, maxOutputBytes: 8192, retry: { maxAttempts: 2 } };
  const after = await runWorkflow(workflow, { ...setup(), processRunner: native, resume: true });
  expect(after.steps['red']?.fingerprint).toBe(before.steps['red']?.fingerprint);
  expect(after.steps['red']?.attemptHistory?.[1]?.policy).toMatchObject(limits);
  expect(after.steps['red']?.execError).toBeUndefined();
});

it('replays red-as-data and plain/json scoped results without a process adapter', async () => {
  let fail = true;
  const invoke = vi.fn<ProcessRunner['run']>((request) =>
    Promise.resolve({
      ...reply,
      code: 9,
      stdout: request.schema ? '{"answer":42}' : 'red',
    }),
  );
  const workflow = definition(async (ctx) => {
    const red = await ctx.within('s').exec('red', ['fake'], { okExitCodes: 'any' });
    const json = await ctx.within('s').exec.json('json', ['fake'], {
      okExitCodes: 'any',
      schema: z.object({ answer: z.number() }),
    });
    if (fail) throw new Error('later');
    return { red, json };
  });
  await expect(
    runWorkflow(workflow, { ...setup(), processRunner: { run: invoke } }),
  ).rejects.toThrow('later');
  fail = false;
  const run = await runWorkflow(workflow, { ...setup(), resume: true });
  expect(run.output).toMatchObject({ red: { code: 9 }, json: { answer: 42 } });
  expect(run.steps['s/json']?.output).toEqual({ answer: 42 });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(['command', 'cwd', 'env', 'input', 'inheritEnv', 'okExitCodes'] as const)(
  'rejects completed %s drift before executing',
  async (field) => {
    let command: Command = ['fake'];
    let settings: ExecOptions = {};
    const invoke = vi.fn<ProcessRunner['run']>(() => Promise.resolve(reply));
    const workflow = definition(async (ctx) => {
      await ctx.exec('one', command, settings);
      throw new Error('later');
    });
    await expect(
      runWorkflow(workflow, { ...setup(), processRunner: { run: invoke } }),
    ).rejects.toThrow('later');
    if (field === 'command') command = ['other'];
    else if (field === 'cwd') settings = { cwd: '..' };
    else if (field === 'env') settings = { env: { CHANGED: 'yes' } };
    else if (field === 'input') settings = { input: 'changed' };
    else if (field === 'inheritEnv') settings = { inheritEnv: false };
    else settings = { okExitCodes: 'any' };
    await expect(
      runWorkflow(workflow, { ...setup(), resume: true, processRunner: { run: invoke } }),
    ).rejects.toThrow('changed on a completed step');
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it('replays a completed command under larger policy and retries unfinished schema failures selectively', async () => {
  let fail = true;
  let limits: ExecOptions = { timeoutMs: 1000, maxOutputBytes: 100 };
  const invoke = vi.fn<ProcessRunner['run']>((_request, call) =>
    Promise.resolve({
      ...reply,
      stdout: call.attempt === 1 ? 'invalid' : '{"ok":true}',
    }),
  );
  const workflow = definition(async (ctx) => {
    const result = await ctx.exec.json('json', ['fake'], {
      ...limits,
      retry: { maxAttempts: 2, on: ['schema'], delayMs: 0 },
      schema: z.object({ ok: z.boolean() }),
    });
    if (fail) throw new Error('later');
    return result;
  });
  await expect(
    runWorkflow(workflow, { ...setup(), processRunner: { run: invoke } }),
  ).rejects.toThrow('later');
  const before = await readRun(setup());
  expect(before.steps['json']?.attemptHistory?.[0]).toMatchObject({
    errorKind: 'schema',
    execError: { stdoutTail: 'invalid' },
  });
  limits = { timeoutMs: 9000, maxOutputBytes: 1000 };
  fail = false;
  expect((await runWorkflow(workflow, { ...setup(), resume: true })).output).toEqual({ ok: true });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('retains each stream head and tail without killing the command on overflow', async () => {
  const run = await runWorkflow(
    definition((ctx) =>
      ctx.exec(
        'large',
        node(
          `process.stdout.write('HEAD'+'.'.repeat(20000)+'TAIL');process.stderr.write('head'+'.'.repeat(20000)+'tail');`,
        ),
        { maxOutputBytes: 8 },
      ),
    ),
    { ...setup(), processRunner: native },
  );
  expect(run.output).toMatchObject({
    code: 0,
    stdout: 'HEADTAIL',
    stderr: 'headtail',
    truncated: true,
  });
});

it('rejects json output overflow and truncated fixture output with output-limit diagnostics', async () => {
  const workflow = definition((ctx) =>
    ctx.exec.json('large', node(`console.log(JSON.stringify({large:'x'.repeat(20000)}));`), {
      maxOutputBytes: 80,
      schema: z.object({ large: z.string() }),
    }),
  );
  await expect(runWorkflow(workflow, { ...setup(), processRunner: native })).rejects.toThrow(
    'output limit',
  );
  expect((await readRun(setup())).steps['large']?.attemptHistory?.[0]?.errorKind).toBe(
    'output-limit',
  );
  await expect(
    runWorkflow(workflow, {
      ...setup(),
      runId: 'fixture',
      processRunner: {
        run: () => Promise.resolve({ ...reply, truncated: true, stdout: '{"large":"valid"}' }),
      },
    }),
  ).rejects.toThrow('truncated');
});

it('flags an explicit shell and its diagnostics in inspect without counting it as agent usage', async () => {
  await expect(
    runWorkflow(
      definition((ctx) => ctx.exec('shell', { shell: 'echo diagnostic >&2; exit 3' })),
      { ...setup(), processRunner: native },
    ),
  ).rejects.toThrow('Command exited');
  const inspected = await inspectRun(setup());
  expect(formatRunSummary(inspected.summary)).toContain('[SHELL]');
  expect(formatRunSummary(inspected.summary)).toContain('diagnostic');
  expect(inspected.summary.usage.attempts).toBe(0);
  expect(inspected.summary.steps[0]?.exec?.command).toEqual({
    shell: 'echo diagnostic >&2; exit 3',
  });
});

it('requires an adapter only for live work and does not hide ignored structured failures', async () => {
  const missingAdapter: unknown = await runWorkflow(
    definition((ctx) => ctx.exec('one', ['fake'])),
    setup(),
  ).catch((error: unknown) => error);
  expect(missingAdapter).toBeInstanceOf(WorkflowRunError);
  if (!(missingAdapter instanceof WorkflowRunError)) throw missingAdapter;
  expect(missingAdapter.cause).toBeInstanceOf(ConfigurationError);
  expect((missingAdapter.cause as Error).message).toContain('No process adapter');
  const run = vi.fn<ProcessRunner['run']>(() => Promise.resolve({ ...reply, stdout: 'not json' }));
  await expect(
    runWorkflow(
      definition((ctx) => {
        void ctx.exec.json('ignored', ['fake'], { schema: z.number() });
        return Promise.resolve(1);
      }),
      { ...setup(), runId: 'ignored', processRunner: { run } },
    ),
  ).rejects.toThrow();
  expect((await readRun({ ...setup(), runId: 'ignored' })).steps['ignored']?.status).toBe('failed');
});

it('treats a missing process adapter as fatal inside a settled map instead of settling fallback data', async () => {
  // Mirrors the settled-map hazard from the review thread: ctx.exec must reject the whole run
  // instead of letting the map journal a fallback item and complete.
  const mapError: unknown = await runWorkflow(
    definition((ctx) =>
      ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, () => ctx.exec('cmd', ['fake'])),
    ),
    { ...setup(), runId: 'settled-map' },
  ).catch((error: unknown) => error);
  expect(mapError).toBeInstanceOf(WorkflowRunError);
  if (!(mapError instanceof WorkflowRunError)) throw mapError;
  expect(mapError.cause).toBeInstanceOf(ConfigurationError);
  expect(
    (await readRun({ ...setup(), runId: 'settled-map' })).maps?.['items']?.items[0]?.status,
  ).toBe('running');
});

it('rejects nested commands and reserved environment keys before spawning', async () => {
  const run = vi.fn<ProcessRunner['run']>(() => Promise.resolve(reply));
  await expect(
    runWorkflow(
      definition((ctx) =>
        ctx.step('outer', {
          input: null,
          schema: z.unknown(),
          run: () => ctx.exec('nested', ['fake']),
        }),
      ),
      { ...setup(), processRunner: { run } },
    ),
  ).rejects.toThrow('Nested durable');
  await expect(
    runWorkflow(
      definition((ctx) => ctx.exec('invalid', ['fake'], { env: { QUIET_CHOIR_ATTEMPT: 'spoof' } })),
      { ...setup(), runId: 'reserved', processRunner: { run } },
    ),
  ).rejects.toThrow('reserved');
  expect(run).not.toHaveBeenCalled();
});

it('dry-run synthesizes commands and reports them without creating command output files', async () => {
  const rehearsal = new RehearsalHarness({ kind: 'cli', config: {} });
  const run = await runWorkflow(
    definition(async (ctx) => {
      await ctx.exec('plain', node(`require('node:fs').writeFileSync('unsafe','x')`));
      return ctx.exec.json('json', ['fake'], { schema: z.object({ ok: z.literal(true) }) });
    }),
    {
      ...setup(),
      harness: rehearsal,
      rehearsal: rehearsal.hooks,
      processRunner: rehearsal.processRunner,
    },
  );
  expect(run.output).toEqual({ ok: true });
  expect(rehearsal.report(run).commands).toHaveLength(2);
  await expect(readFile(join(cwd, 'unsafe'))).rejects.toThrow();
});

it('dry-run synthesizes a guardFile baseline without spawning a child process', async () => {
  const rehearsal = new RehearsalHarness({ kind: 'cli', config: {} });
  const run = await runWorkflow(
    definition((ctx) =>
      guardFile(ctx, 'guard', 'guarded.txt', () => Promise.resolve('body result')),
    ),
    {
      ...setup(),
      harness: rehearsal,
      rehearsal: rehearsal.hooks,
      processRunner: rehearsal.processRunner,
    },
  );
  expect(run.output).toBe('body result');
  const stepIds = rehearsal.report(run).commands.map((command) => command.stepId);
  expect(stepIds).toEqual(expect.arrayContaining(['guard/baseline', 'guard/restore']));
  // A real guardProgram run would need `guarded.txt` to exist for baseline and would create it on
  // restore; neither happened, so the commands above were synthesized rather than spawned.
  await expect(readFile(join(cwd, 'guarded.txt'))).rejects.toThrow();
});

it('atomically writes private files and replays read snapshots and hash-only receipts', async () => {
  let fail = true;
  const workflow = definition(async (ctx) => {
    const created = await ctx
      .within('f')
      .writeFile('write', 'nested/out.txt', 'private content', { ifMatch: null });
    const snapshot = await ctx.within('f').readFile('read', 'nested/out.txt');
    if (fail) throw new Error('later');
    return { created, snapshot };
  });
  await expect(runWorkflow(workflow, setup())).rejects.toThrow('later');
  const before = await readRun(setup());
  expect(JSON.stringify(before.steps['f/write'])).not.toContain('private content');
  expect(before.steps['f/write']?.output).toEqual({
    path: join(cwd, 'nested/out.txt'),
    sha256: fileDigest('private content'),
    bytes: 15,
    previousSha256: null,
  });
  expect((await stat(join(cwd, 'nested/out.txt'))).mode & 0o777).toBe(0o600);
  await writeFile(join(cwd, 'nested/out.txt'), 'external change');
  fail = false;
  const after = await runWorkflow(workflow, { ...setup(), resume: true });
  expect(after.output).toMatchObject({ snapshot: { content: 'private content' } });
  expect(await readFile(join(cwd, 'nested/out.txt'), 'utf8')).toBe('external change');
  expect(await readdir(join(cwd, 'nested'))).toEqual(['out.txt']);
});

it('supports expected hashes, create-only conflicts, and desired-content idempotency', async () => {
  const file = join(cwd, 'file');
  await writeFile(file, 'old');
  const run = await runWorkflow(
    definition(async (ctx) => {
      const old = await ctx.readFile('old', 'file');
      const replaced = await ctx.writeFile('replace', 'file', 'new', { ifMatch: old.sha256 });
      const noop = await ctx.writeFile('noop', 'file', 'new', { ifMatch: old.sha256 });
      const createNoop = await ctx.writeFile('create-noop', 'file', 'new', { ifMatch: null });
      return { replaced, noop, createNoop };
    }),
    setup(),
  );
  expect(run.output).toMatchObject({
    replaced: { previousSha256: fileDigest('old') },
    noop: { previousSha256: fileDigest('new') },
    createNoop: { previousSha256: fileDigest('new') },
  });
  await expect(
    runWorkflow(
      definition((ctx) => ctx.writeFile('conflict', 'file', 'bad', { ifMatch: null })),
      { ...setup(), runId: 'conflict' },
    ),
  ).rejects.toThrow('ifMatch');
  expect(await readFile(file, 'utf8')).toBe('new');
});

it.each(['read', 'write'] as const)(
  'requires explicit outside-cwd permission for %s and symlink targets',
  async (operation) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'choir-outside-')));
    try {
      await writeFile(join(outside, 'file'), 'outside');
      await symlink(outside, join(cwd, 'link'));
      const workflow = definition((ctx) =>
        operation === 'read'
          ? ctx.readFile('file', 'link/file')
          : ctx.writeFile('file', 'link/file', 'changed'),
      );
      await expect(runWorkflow(workflow, setup())).rejects.toThrow('escapes cwd');
      await expect(
        runWorkflow(
          definition((ctx) => ctx.readFile('direct', join(outside, 'file'))),
          { ...setup(), runId: 'absolute' },
        ),
      ).rejects.toThrow('escapes cwd');
      const allowed = await runWorkflow(
        definition((ctx) =>
          operation === 'read'
            ? ctx.readFile('file', 'link/file', { allowOutsideCwd: true })
            : ctx.writeFile('file', 'link/file', 'changed', { allowOutsideCwd: true }),
        ),
        { ...setup(), runId: 'allowed' },
      );
      expect(allowed.status).toBe('completed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);

it('rejects oversized snapshots, directories, and dangling links; size increases permit resume', async () => {
  await writeFile(join(cwd, 'file'), '12345');
  let maxBytes = 4;
  const workflow = definition((ctx) => ctx.readFile('read', 'file', { maxBytes }));
  await expect(runWorkflow(workflow, setup())).rejects.toThrow('snapshot limit');
  maxBytes = 5;
  expect((await runWorkflow(workflow, { ...setup(), resume: true })).output).toEqual({
    content: '12345',
    sha256: fileDigest('12345'),
  });
  await expect(
    runWorkflow(
      definition((ctx) => ctx.readFile('dir', '.')),
      { ...setup(), runId: 'dir' },
    ),
  ).rejects.toThrow('regular file');
  await symlink('missing', join(cwd, 'dangling'));
  await expect(
    runWorkflow(
      definition((ctx) => ctx.writeFile('dangling', 'dangling', 'bad')),
      { ...setup(), runId: 'dangling' },
    ),
  ).rejects.toThrow('Dangling');
});

it('rejects invalid UTF-8 instead of saving a lossy snapshot', async () => {
  await writeFile(join(cwd, 'binary'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const workflow = definition((ctx) => ctx.readFile('read', 'binary'));
  await expect(runWorkflow(workflow, setup())).rejects.toThrow(
    'File is not valid UTF-8; use a local callback for binary content.',
  );
  expect((await readRun(setup())).steps['read']?.status).toBe('failed');
});

it('round-trips a BOM-prefixed file with the BOM intact and a matching sha256', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
  await writeFile(join(cwd, 'bom.txt'), bytes);
  const run = await runWorkflow(
    definition((ctx) => ctx.readFile('read', 'bom.txt')),
    setup(),
  );
  expect(run.output).toEqual({ content: '﻿hello', sha256: fileDigest(bytes) });
  const written = await runWorkflow(
    definition((ctx) => ctx.writeFile('write', 'bom-out.txt', '﻿hello', { ifMatch: null })),
    { ...setup(), runId: 'write' },
  );
  expect(written.output).toMatchObject({ sha256: fileDigest(bytes) });
  expect(await readFile(join(cwd, 'bom-out.txt'))).toEqual(bytes);
});

it('refuses write content drift and permits retry after an ifMatch conflict', async () => {
  await writeFile(join(cwd, 'file'), 'external');
  const workflow = definition((ctx) =>
    ctx.writeFile('replace', 'file', 'desired', { ifMatch: fileDigest('expected') }),
  );
  await expect(runWorkflow(workflow, setup())).rejects.toThrow('ifMatch');
  await writeFile(join(cwd, 'file'), 'expected');
  expect((await runWorkflow(workflow, { ...setup(), resume: true })).status).toBe('completed');
  let content = 'one';
  const failed = definition(async (ctx) => {
    await ctx.writeFile('write', 'other', content);
    throw new Error('later');
  });
  await expect(runWorkflow(failed, { ...setup(), runId: 'drift' })).rejects.toThrow('later');
  content = 'two';
  await expect(runWorkflow(failed, { ...setup(), runId: 'drift', resume: true })).rejects.toThrow(
    'changed on a completed',
  );
});

it.each(['restore', 'error'] as const)(
  'guardFile restores uncommitted CRLF through raw Git blobs (%s)',
  async (onChange) => {
    await native.run(
      {
        command: ['git', 'init', '-q'],
        cwd,
        env: {},
        inheritEnv: true,
        input: '',
        timeoutMs: 3000,
        maxOutputBytes: 1024,
        capture: 'error',
        schema: null,
      },
      {
        signal: new AbortController().signal,
        runId: 'init',
        stepId: 'init',
        attempt: 1,
        trackProcess: () => Promise.resolve({ release: () => Promise.resolve() }),
      },
    );
    const original = 'uncommitted\r\nfix\r\n';
    await writeFile(join(cwd, 'file'), original);
    let calls = 0;
    const workflow = definition((ctx) =>
      guardFile(
        ctx,
        'guard',
        'file',
        async () => {
          calls++;
          await ctx.writeFile('mutate', 'file', 'broken\n');
          return { done: true };
        },
        { onChange },
      ),
    );
    if (onChange === 'error')
      await expect(runWorkflow(workflow, { ...setup(), processRunner: native })).rejects.toThrow(
        'changed and was restored',
      );
    else
      expect((await runWorkflow(workflow, { ...setup(), processRunner: native })).output).toEqual({
        done: true,
      });
    expect(await readFile(join(cwd, 'file'), 'utf8')).toBe(original);
    expect(JSON.stringify(await readRun(setup()))).not.toContain(original);
    if (onChange === 'error')
      await expect(
        runWorkflow(workflow, { ...setup(), resume: true, processRunner: native }),
      ).rejects.toThrow('changed and was restored');
    expect(calls).toBe(1);
  },
);

it.each(['restore', 'error'] as const)(
  'guardFile restores a chmod-only permission change (%s)',
  async (onChange) => {
    const workflow = definition(async (ctx) => {
      await ctx.exec('init', ['git', 'init', '-q']);
      await ctx.writeFile('original', 'file', 'same bytes');
      await chmod(join(cwd, 'file'), 0o644);
      return guardFile(
        ctx,
        'guard',
        'file',
        async () => {
          await chmod(join(cwd, 'file'), 0o755);
          return 'done';
        },
        { onChange },
      );
    });
    if (onChange === 'error')
      await expect(runWorkflow(workflow, { ...setup(), processRunner: native })).rejects.toThrow(
        'Guarded file changed and was restored',
      );
    else
      expect((await runWorkflow(workflow, { ...setup(), processRunner: native })).output).toBe(
        'done',
      );
    expect((await stat(join(cwd, 'file'))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('same bytes');
  },
);

// Root bypasses file permission checks, so it never sees the EACCES this case exercises.
it.skipIf(process.getuid?.() === 0)(
  'guardFile restores a file whose read permission the body removed',
  async () => {
    const workflow = definition(async (ctx) => {
      await ctx.exec('init', ['git', 'init', '-q']);
      await ctx.writeFile('original', 'file', 'readable baseline');
      await chmod(join(cwd, 'file'), 0o644);
      return guardFile(ctx, 'guard', 'file', async () => {
        await ctx.writeFile('mutate', 'file', 'broken');
        await chmod(join(cwd, 'file'), 0o000);
        return 'done';
      });
    });
    expect((await runWorkflow(workflow, { ...setup(), processRunner: native })).output).toBe(
      'done',
    );
    expect((await stat(join(cwd, 'file'))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('readable baseline');
  },
);

it('guardFile pins its baseline blob so git gc cannot prune it before restore', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const workflow = definition(async (ctx) => {
    await ctx.exec('init', ['git', 'init', '-q']);
    await ctx.writeFile('original', 'file', 'uncommitted baseline');
    return guardFile(ctx, 'guard', 'file', async () => {
      await ctx.writeFile('mutate', 'file', 'broken');
      expect(git('for-each-ref', '--format=%(objecttype)', 'refs/quiet-choir/guards/')).toBe(
        'blob\n',
      );
      git('reflog', 'expire', '--expire=now', '--all');
      git('gc', '--quiet', '--prune=now');
      return 'done';
    });
  });
  expect((await runWorkflow(workflow, { ...setup(), processRunner: native })).output).toBe('done');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('uncommitted baseline');
  expect(git('for-each-ref', 'refs/quiet-choir/')).toBe('');
});

it('guardFile restores after an ordinary body failure and replays that terminal failure', async () => {
  const workflow = definition(async (ctx) => {
    await ctx.exec('init', ['git', 'init', '-q']);
    await ctx.writeFile('original', 'file', 'preserved');
    return guardFile(ctx, 'guard', 'file', async () => {
      await ctx.writeFile('mutate', 'file', 'broken');
      throw new Error('body failed');
    });
  });
  await expect(runWorkflow(workflow, { ...setup(), processRunner: native })).rejects.toThrow(
    'Guarded body failed',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('preserved');
  await expect(runWorkflow(workflow, { ...setup(), resume: true })).rejects.toThrow(
    'Guarded body failed',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('preserved');
});

describe('head/tail byte capture', () => {
  it.each([1, 2, 7, 16])('bounds arbitrary chunk boundaries at %i bytes', (limit) => {
    const capture = new OutputCapture(limit);
    const content = 'abcdefghijklmnopqrstuvwxyz';
    for (const chunk of ['abc', 'defgh', 'ijklmnop', 'qrstuvwxyz'])
      capture.append(Buffer.from(chunk));
    expect(capture.text()).toBe(
      content.slice(0, Math.ceil(limit / 2)) +
        (Math.floor(limit / 2) ? content.slice(-Math.floor(limit / 2)) : ''),
    );
    expect(capture.truncated).toBe(true);
  });
  it.each([
    [64, [1]],
    [65, [3, 7, 1]],
    [1000, [5, 64, 1, 700, 2, 1500]],
  ])('keeps head and tail across many chunks past a %i-byte cap', (limit, sizes) => {
    const capture = new OutputCapture(limit);
    let reference = '';
    for (let index = 0; reference.length < limit * 20; index++) {
      const size = sizes[index % sizes.length] ?? 1;
      const chunk = Array.from({ length: size }, (_, offset) =>
        String.fromCharCode(97 + ((reference.length + offset) % 26)),
      ).join('');
      reference += chunk;
      capture.append(Buffer.from(chunk));
      const head = reference.slice(0, Math.ceil(limit / 2));
      const tail = reference.length > limit ? reference.slice(-Math.floor(limit / 2)) : '';
      expect(capture.text()).toBe(reference.length > limit ? head + tail : reference);
    }
    expect(capture.truncated).toBe(true);
  });
  it('preserves intact utf8 and omits partial codepoints at truncation boundaries', () => {
    const intact = new OutputCapture(9);
    intact.append(Buffer.from('a😀b'));
    expect(intact.text()).toBe('a😀b');
    const truncated = new OutputCapture(7);
    truncated.append(Buffer.from('a😀middle😀z'));
    expect(truncated.text()).toBe('az');
  });
});

it('classifies ExecError while preserving only bounded diagnostic tails', () => {
  const error = new ExecError('failure', 'process', { ...reply, stderr: 'x'.repeat(2000) });
  expect(error.diagnostics.stderrTail).toHaveLength(1024);
});

it.each(['timeout', 'cancel'] as const)(
  'reaps shell descendants on %s',
  async (mode) => {
    const { processIdentity, groupState } = await import('../src/processes/identity.js');
    const { setTimeout: delay } = await import('node:timers/promises');
    const controller = new AbortController();
    let leader = 0;
    const runner: ProcessRunner = {
      run: (request, invocation) =>
        native.run(request, {
          ...invocation,
          trackProcess: (child) => {
            leader = child.pid;
            return invocation.trackProcess(child);
          },
        }),
    };
    const command: Command = [
      'sh',
      '-c',
      '(sleep 30) & child=$!; printf "%s" "$child" > "$CHILD_FILE"; wait',
    ];
    const work = runWorkflow(
      definition((ctx) =>
        ctx.exec('children', command, {
          env: { CHILD_FILE: join(cwd, 'child') },
          timeoutMs: mode === 'timeout' ? 1500 : 5000,
        }),
      ),
      { ...setup(), processRunner: runner, signal: controller.signal },
    );
    const assertion = expect(work).rejects.toThrow();
    let child = 0;
    for (let i = 0; i < 100; i++) {
      child = Number(await readFile(join(cwd, 'child'), 'utf8').catch(() => '0'));
      if (child > 1) break;
      await delay(10);
    }
    if (mode === 'cancel') controller.abort(new Error('interrupt'));
    await assertion;
    expect(child).toBeGreaterThan(1);
    expect(leader).toBeGreaterThan(1);
    expect(groupState({ pid: leader, pgid: leader })).toBe('dead');
    expect(
      processIdentity(child)?.zombie ?? groupState({ pid: child, pgid: null }) === 'dead',
    ).toBe(true);
    expect((await readRun(setup())).steps['children']?.attemptHistory?.[0]?.errorKind).toBe(
      mode === 'cancel' ? 'cancelled' : 'timeout',
    );
  },
  10000,
);

it('does not retry failed process registration or deliver stdin before its durable ownership', async () => {
  const { FileRunStore } = await import('../src/index.js');
  const { groupState } = await import('../src/processes/identity.js');
  const fileStore = new FileRunStore(stateDir);
  let pid = 0;
  let attempts = 0;
  const store = {
    stateDir,
    read: fileStore.read.bind(fileStore),
    list: fileStore.list.bind(fileStore),
    open: async (...args: Parameters<typeof fileStore.open>) => {
      const owned = await fileStore.open(...args);
      return {
        read: owned.read.bind(owned),
        append: owned.append.bind(owned),
        compact: owned.compact.bind(owned),
        artifacts: owned.artifacts.bind(owned),
        release: owned.release.bind(owned),
        trackProcess: (_call: unknown, child: { pid: number }) => {
          attempts++;
          pid = child.pid;
          return Promise.reject(new Error('registry unavailable'));
        },
      };
    },
  };
  await expect(
    runWorkflow(
      definition((ctx) =>
        ctx.exec(
          'registration',
          node(
            `process.stdin.on('data',()=>require('node:fs').writeFileSync('received','bad'));setInterval(()=>{},1000);`,
          ),
          { input: 'task', retry: { maxAttempts: 3, delayMs: 0 } },
        ),
      ),
      { ...setup(), processRunner: native, store },
    ),
  ).rejects.toThrow('Could not record process');
  expect(attempts).toBe(1);
  expect(groupState({ pid, pgid: pid })).toBe('dead');
  await expect(readFile(join(cwd, 'received'))).rejects.toThrow();
});

it('applies sticky exec output/timeout policy and keeps agent-only controls out of commands', async () => {
  const calls: unknown[] = [];
  const run = await runWorkflow(
    definition((ctx) => ctx.exec('one', ['fake'])),
    {
      ...setup(),
      policy: [{ kind: 'exec', timeoutMs: 2000, maxOutputBytes: 4000 }],
      processRunner: {
        run: (request) => {
          calls.push(request);
          return Promise.resolve(reply);
        },
      },
    },
  );
  expect(calls).toMatchObject([{ timeoutMs: 2000, maxOutputBytes: 4000 }]);
  expect(run.steps['one']?.attemptHistory?.[0]?.sources).toMatchObject({
    timeoutMs: 'override:0',
    maxOutputBytes: 'override:0',
  });
  await expect(
    runWorkflow(
      definition((ctx) => ctx.exec('one', ['fake'])),
      { ...setup(), runId: 'invalid-policy', policy: [{ kind: 'exec', maxTurns: 5 }] },
    ),
  ).rejects.toThrow('Does not apply');
});

it.each(['fsync', 'conflict'] as const)(
  'preserves the target and removes temporary files after publication %s failure',
  async (failure) => {
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const { replaceFile } = await import('../src/workflow/runtime/files.js');
    const path = join(cwd, 'file');
    await writeFile(path, 'original');
    const originalOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('/.quiet-choir-')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (failure === 'fsync') throw new Error('injected sync failure');
          await fs.writeFile(path, 'concurrent writer');
          await sync();
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(
        replaceFile(
          path,
          'replacement',
          { ifMatch: fileDigest('original') },
          new AbortController().signal,
        ),
      ).rejects.toThrow(failure === 'fsync' ? 'injected sync failure' : 'baseline changed');
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    expect(await readFile(path, 'utf8')).toBe(
      failure === 'fsync' ? 'original' : 'concurrent writer',
    );
    expect(await readdir(cwd)).toEqual(['file']);
  },
);

it('resumes a failed guard restore without rerunning its journaled body', async () => {
  let bodies = 0;
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
      bodies++;
      await ctx.writeFile('mutate', 'file', 'changed');
      return 'done';
    });
  });
  await expect(runWorkflow(workflow, { ...setup(), processRunner })).rejects.toThrow(
    'restore unavailable',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('changed');
  expect((await runWorkflow(workflow, { ...setup(), processRunner, resume: true })).output).toBe(
    'done',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('baseline');
  expect(bodies).toBe(1);
});

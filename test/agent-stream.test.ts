import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CliHarness,
  CheckpointError,
  HarnessError,
  WorkflowRunError,
  FileRunStore,
  defineWorkflow,
  deriveAgentSessionId,
  readRun,
  runWorkflow,
  z,
  type Harness,
  type WorkflowEvent,
  type PolicyOverride,
  type RunStore,
  type RunRecord,
  type AgentTranscriptWriter,
} from '../src/index.js';
import { testInvocation } from './harness-invocation.js';
import { AttemptTranscript } from '../src/workflow/runtime/agent-transcript.js';
import * as storageIo from '../src/workflow/runtime/storage-io.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-stream-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('treats transcript write failure as infrastructure even with retry and settled fallback', async () => {
  let calls = 0;
  vi.spyOn(AttemptTranscript.prototype, 'write').mockRejectedValue(
    new Error('transcript write failed'),
  );
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.text('write-failure', {
        prompt: 'answer',
        retry: { maxAttempts: 3, delayMs: 0 },
        onError: 'return',
      });
      return 'must not reach fallback';
    },
  });
  const error: unknown = await runWorkflow(definition, {
    ...setup(),
    harness: {
      async invoke(_request, invocation) {
        calls++;
        await invocation.onSession?.('before-write-failure');
        await invocation.onOutput?.('stdout', Buffer.from('bytes'));
        return { text: 'ok', sessionId: 'before-write-failure', usage };
      },
    },
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  if (!(error instanceof WorkflowRunError)) throw error;
  expect(error.cause).toBeInstanceOf(CheckpointError);
  expect(calls).toBe(1);
  const attempt = (await readRun(setup())).steps['write-failure']?.attemptHistory?.[0];
  expect(attempt?.sessionId).toBe('before-write-failure');
  expect(attempt?.status).toBe('failed');
});

it('keeps a committed success when on-failure transcript cleanup fails', async () => {
  vi.spyOn(AttemptTranscript.prototype, 'discard').mockRejectedValue(new Error('cleanup refused'));
  let calls = 0;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.codex.value('cleanup', { prompt: 'answer' });
    },
  });
  const harness: Harness = {
    invoke: () => {
      calls++;
      return Promise.resolve({ text: 'ok', sessionId: 'cleanup', usage });
    },
  };
  const run = await runWorkflow(definition, {
    ...setup(),
    harness,
    policy: [{ transcripts: 'on-failure' }],
  });
  expect(run.status).toBe('completed');
  expect(run.steps['cleanup']?.warnings).toEqual([
    'Could not remove successful transcript: cleanup refused',
  ]);
  expect(run.steps['cleanup']?.attemptHistory?.[0]?.transcript?.retained).toBe(true);
  await runWorkflow(definition, { ...setup(), harness, resume: true });
  expect(calls).toBe(1);
});

it('delegates transcript ownership to the injected store and preserves an early-only session', async () => {
  const fileStore = new FileRunStore(directory);
  const written: string[] = [];
  let closeCount = 0;
  const transcript: AgentTranscriptWriter = {
    snapshot: () => ({
      path: 'memory:owned-transcript',
      bytes: Buffer.byteLength(written.join('')),
      truncated: false,
      retained: true,
    }),
    write: (stream, chunk) => {
      written.push(`${stream}:${Buffer.from(chunk).toString('utf8')}`);
      return Promise.resolve();
    },
    close: () => {
      closeCount++;
      return Promise.resolve();
    },
    discard: () => Promise.reject(new Error('This test retains transcripts.')),
  };
  const allocate = vi.fn(() => Promise.resolve(transcript));
  const store: RunStore = {
    stateDir: directory,
    read: fileStore.read.bind(fileStore),
    list: fileStore.list.bind(fileStore),
    async open(id, options) {
      const owned = await fileStore.open(id, options);
      return {
        read: owned.read.bind(owned),
        append: owned.append.bind(owned),
        compact: owned.compact.bind(owned),
        artifacts: owned.artifacts.bind(owned),
        trackProcess: owned.trackProcess.bind(owned),
        release: owned.release.bind(owned),
        transcript: allocate,
      };
    },
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('owned', { prompt: 'answer' })).sessionId ?? 'missing';
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    store,
    policy: [{ maxTranscriptBytes: 512 }],
    harness: {
      async invoke(_request, invocation) {
        expect(invocation.transcriptPath).toBe('memory:owned-transcript');
        await invocation.onSession?.('early-only');
        await invocation.onOutput?.('stdout', Buffer.from('raw'));
        return { text: 'ok', sessionId: null, usage };
      },
    },
  });
  expect(run.output).toBe('early-only');
  expect(allocate).toHaveBeenCalledWith('owned', 1, 'claude', 512);
  expect(written).toEqual(['stdout:raw']);
  expect(closeCount).toBe(1);
  await expect(readdir(join(directory, 'stream', 'attempts'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

/** A store whose transcript write never settles and whose close/discard wait behind it. */
function stalledTranscriptStore(stall: 'close' | 'discard'): RunStore {
  const fileStore = new FileRunStore(directory);
  let pending: Promise<void> = Promise.resolve();
  const transcript: AgentTranscriptWriter = {
    snapshot: () => ({ path: 'memory:stalled', bytes: 0, truncated: false, retained: true }),
    write: () => (pending = new Promise<void>(() => undefined)),
    close: () => (stall === 'close' ? pending : Promise.resolve()),
    discard: () => new Promise<void>(() => undefined),
  };
  return {
    stateDir: directory,
    read: fileStore.read.bind(fileStore),
    list: fileStore.list.bind(fileStore),
    async open(id, options) {
      const owned = await fileStore.open(id, options);
      return {
        read: owned.read.bind(owned),
        append: owned.append.bind(owned),
        compact: owned.compact.bind(owned),
        artifacts: owned.artifacts.bind(owned),
        trackProcess: owned.trackProcess.bind(owned),
        release: owned.release.bind(owned),
        transcript: () => Promise.resolve(transcript),
      };
    },
  };
}

it.each(['rejected', 'resolved'] as const)(
  'bounds transcript close behind a stalled write after the invocation %s',
  async (settled) => {
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.codex.value('stalled', {
          prompt: 'answer',
          retry: { maxAttempts: 3, delayMs: 0 },
          onError: 'return',
        });
        return 'must not reach fallback';
      },
    });
    let calls = 0;
    const started = performance.now();
    const error: unknown = await runWorkflow(definition, {
      ...setup(),
      store: stalledTranscriptStore('close'),
      harness: {
        invoke(_request, invocation) {
          calls++;
          // The process runner's backstop abandons a stalled consumer; model that here.
          void invocation.onOutput?.('stdout', Buffer.from('stuck'));
          return settled === 'resolved'
            ? Promise.resolve({ text: 'ok', sessionId: 'stalled', usage })
            : Promise.reject(
                Object.assign(new Error('output consumer did not settle'), {
                  code: 'QUIET_CHOIR_CONSUMER_STALLED',
                }),
              );
        },
      },
    }).catch((cause: unknown) => cause);
    expect(performance.now() - started).toBeLessThan(4500);
    expect(error).toBeInstanceOf(WorkflowRunError);
    if (!(error instanceof WorkflowRunError)) throw error;
    expect(error.cause).toBeInstanceOf(CheckpointError);
    expect(calls).toBe(1);
    const run = await readRun(setup());
    expect(run.status).toBe('failed');
    const attempt = required(run.steps['stalled']?.attemptHistory?.[0]);
    expect(attempt.status).toBe('failed');
    expect(attempt.error).toContain('Could not write transcript for step stalled');
    expect(attempt.error).toContain('Transcript close did not settle within 2000ms');
    expect(attempt.transcript).toMatchObject({ path: 'memory:stalled', retained: true });
  },
  10_000,
);

it('bounds a stalled on-failure discard after the committed success', async () => {
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.codex.value('discard', { prompt: 'answer' });
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    store: stalledTranscriptStore('discard'),
    policy: [{ transcripts: 'on-failure' }],
    harness: { invoke: () => Promise.resolve({ text: 'ok', sessionId: 'discard', usage }) },
  });
  expect(run.status).toBe('completed');
  expect(run.steps['discard']?.warnings).toEqual([
    'Could not remove successful transcript: Transcript discard did not settle within 2000ms of the invocation ending.',
  ]);
  expect(run.steps['discard']?.attemptHistory?.[0]?.transcript?.retained).toBe(true);
}, 10_000);

it('supports memory-only agent runs with transcripts off and refuses unsupported default capture', async () => {
  const records = new Map<string, RunRecord>();
  const store: RunStore = {
    read: (id) => Promise.resolve(required(records.get(id))),
    list: () => Promise.resolve([...records.keys()]),
    open: (id) =>
      Promise.resolve({
        read: () => Promise.resolve(records.get(id)),
        append: (record) => {
          records.set(id, structuredClone(record));
          return Promise.resolve();
        },
        compact: () => Promise.resolve(),
        release: () => Promise.resolve(),
        artifacts: () => Promise.reject(new Error('memory only')),
        trackProcess: () => Promise.reject(new Error('memory only')),
      }),
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.codex.value('memory', { prompt: 'answer' });
    },
  });
  const harness: Harness = {
    invoke: () => Promise.resolve({ text: 'ok', sessionId: null, usage }),
  };
  const run = await runWorkflow(definition, {
    ...setup(),
    store,
    harness,
    policy: [{ transcripts: 'off' }],
  });
  expect(run.output).toBe('ok');
  await expect(
    runWorkflow(definition, { ...setup('requires-port'), store, harness }),
  ).rejects.toThrow('RunStore must implement transcript storage');
  expect(await readdir(directory)).toEqual([]);
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing expected attempt evidence.');
  return value;
}

const usage = { inputTokens: 8, outputTokens: 2, costUsd: 0.01 };
const setup = (runId = 'stream') => ({ stateDir: directory, runId, cwd: directory, input: null });
const base = { name: 'stream', version: '1', input: z.null(), output: z.string() };

async function binary(script: string): Promise<string> {
  const path = join(directory, 'agent');
  await writeFile(
    path,
    `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('fake 1.2.3'); process.exit(); }\n${script}\n`,
  );
  await chmod(path, 0o700);
  return path;
}

it.each(['claude', 'codex'] as const)(
  'saves the first %s session while the native child is still running',
  async (provider) => {
    const agent = await binary(
      provider === 'claude'
        ? `const id = process.argv[process.argv.indexOf('--session-id') + 1]; console.log(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'observed-model',claude_code_version:'1.2.3'})); setInterval(() => {}, 1000);`
        : `console.log(JSON.stringify({type:'thread.started',thread_id:'early-codex'})); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const events: WorkflowEvent[] = [];
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx[provider].text('scope/../task', { prompt: 'hang' })).output;
      },
    });
    const pending = runWorkflow(definition, {
      ...setup(),
      signal: controller.signal,
      harness: new CliHarness({ claudeBinary: agent, codexBinary: agent, killGraceMs: 20 }),
      onEvent: (event) => {
        events.push(event);
      },
    }).catch((error: unknown) => error);
    try {
      await expect
        .poll(
          async () =>
            (await readRun(setup()).catch(() => undefined))?.steps['scope/../task']
              ?.attemptHistory?.[0]?.sessionId,
        )
        .toBeTruthy();
      const running = await readRun(setup());
      const attempt = required(running.steps['scope/../task']?.attemptHistory?.[0]);
      expect(attempt.status).toBe('running');
      expect(attempt.finishedAt).toBeNull();
      expect(running.sessionSalt).toMatch(/^[\da-f-]{36}$/u);
      if (provider === 'claude') {
        expect(attempt.sessionId).toBe(
          deriveAgentSessionId(required(running.sessionSalt), 'scope/../task', 1),
        );
        expect(attempt.requestedSessionId).toBe(attempt.sessionId);
      } else expect(attempt.sessionId).toBe('early-codex');
      expect(attempt.transcript?.path).toBeTruthy();
      expect(relative(join(directory, 'stream'), required(attempt.transcript).path)).not.toMatch(
        /^\.\./u,
      );
      expect((await stat(required(attempt.transcript).path)).mode & 0o777).toBe(0o600);
      expect(events.some((event) => event.type === 'agent.started')).toBe(true);
      await expect.poll(() => events.some((event) => event.type === 'agent.progress')).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
    const saved = await readRun(setup());
    expect(saved.steps['scope/../task']?.attemptHistory?.[0]?.sessionId).toBeTruthy();
    expect(events.filter((event) => event.type === 'agent.finished')).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(saved.events?.some((event) => event.type.startsWith('agent.'))).toBe(false);
  },
);

it('keeps the first observed session ID when a successful response reports a later one', async () => {
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('session-drift', { prompt: 'answer' })).sessionId ?? 'missing';
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: {
      async invoke(_request, invocation) {
        await invocation.onSession?.('first');
        return { text: 'ok', sessionId: 'second', usage };
      },
    },
  });
  expect(run.output).toBe('first');
  const attempt = required(run.steps['session-drift']?.attemptHistory?.[0]);
  expect(attempt.sessionId).toBe('first');
  expect(attempt.diagnostics).toMatchObject({ finalSessionId: 'second' });
});

it('keeps the first observed session ID when a failing attempt reports a later one', async () => {
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const result = await ctx.codex.text('session-drift-failure', {
        prompt: 'answer',
        onError: 'return',
      });
      return result.ok ? 'unexpected success' : result.error.message;
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: {
      async invoke(_request, invocation) {
        await invocation.onSession?.('first');
        throw new HarnessError({
          harness: 'codex',
          kind: 'protocol',
          exit: { code: 1, signal: null },
          failure: null,
          reason: 'boom',
          stderr: '',
          stdout: '',
          sessionId: 'second',
          diagnostics: {},
          rawText: null,
        });
      },
    },
  });
  const step = run.steps['session-drift-failure'];
  const attempt = required(step?.attemptHistory?.[0]);
  expect(attempt.status).toBe('failed');
  expect(attempt.sessionId).toBe('first');
  expect(attempt.diagnostics).toMatchObject({ finalSessionId: 'second' });
  expect(step?.failedAttempts?.[0]).toMatchObject({ sessionId: 'first' });
});

it('streams a 9 MiB Codex command line through a 1 KiB parser budget and preserves the answer', async () => {
  const agent = await binary(`
    console.log(JSON.stringify({type:'thread.started',thread_id:'large-command'}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'command',type:'command_execution',aggregated_output:'x'.repeat(9*1024*1024)}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
  `);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.codex.value('command', { prompt: 'run' });
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: new CliHarness({ codexBinary: agent }),
    policy: [{ maxRetainedBytes: 1024, maxTranscriptBytes: 4096 }],
  });
  expect(run.output).toBe('done');
  const attempt = required(run.steps['command']?.attemptHistory?.[0]);
  expect(attempt.diagnostics).toMatchObject({ skippedLines: 1 });
  expect(attempt.transcript).toMatchObject({ truncated: true, retained: true });
  const text = await readFile(required(attempt.transcript).path, 'utf8');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  expect(text.trim().split('\n').at(-1)).toBe('{"type":"truncated","reason":"maxTranscriptBytes"}');
  expect(required(attempt.transcript).bytes).toBe(Buffer.byteLength(text));
});

it.each(['on', 'on-failure', 'off'] as const)(
  'applies transcript mode %s after local validation',
  async (transcripts) => {
    let calls = 0;
    const harness: Harness = {
      async invoke(_request, context) {
        calls++;
        await context.onSession?.(`session-${String(calls)}`);
        await context.onOutput?.('stdout', Buffer.from(`raw attempt ${String(calls)}`));
        return {
          text: calls === 1 ? '{"answer":42}' : '{"answer":"ok"}',
          sessionId: `session-${String(calls)}`,
          usage,
          diagnostics: { futureKey: { nested: ['accepted'] } },
        };
      },
    };
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (
          await ctx.codex.value('a/../../x', {
            prompt: 'respond',
            schema: z.object({ answer: z.string() }),
            retry: { maxAttempts: 2, delayMs: 0 },
          })
        ).answer;
      },
    });
    const run = await runWorkflow(definition, { ...setup(), harness, policy: [{ transcripts }] });
    const history = required(run.steps['a/../../x']?.attemptHistory);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      status: 'failed',
      sessionId: 'session-1',
      usage,
      response: '{"answer":42}',
      responseTruncated: false,
      validationIssues: [{ path: ['answer'] }],
      diagnostics: { futureKey: { nested: ['accepted'] } },
    });
    expect(history[1]).toMatchObject({ status: 'completed', sessionId: 'session-2', usage });
    expect(history[1]?.response).toBeUndefined();
    if (transcripts === 'off') {
      expect(history.every((attempt) => attempt.transcript === undefined)).toBe(true);
      await expect(readdir(join(directory, 'stream', 'attempts'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } else {
      expect(await readFile(required(history[0]?.transcript).path, 'utf8')).toContain(
        Buffer.from('raw attempt 1').toString('base64'),
      );
      expect(required(history[1]?.transcript).retained).toBe(transcripts === 'on');
      if (transcripts === 'on-failure')
        await expect(stat(required(history[1]?.transcript).path)).rejects.toMatchObject({
          code: 'ENOENT',
        });
    }
    const saved = await readRun(setup());
    expect(saved.steps['a/../../x']?.attemptHistory).toEqual(history);
  },
);

it('retains bounded raw response and usage when local JSON parsing fails', async () => {
  const text = `bad ${'🙂'.repeat(100_000)}`;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.object('bad-json', {
        prompt: 'respond',
        schema: z.object({ answer: z.string() }),
        onError: 'return',
      });
      return 'handled';
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: { invoke: () => Promise.resolve({ text, sessionId: 'bad-json-session', usage }) },
  });
  const attempt = required(run.steps['bad-json']?.attemptHistory?.[0]);
  expect(attempt).toMatchObject({
    sessionId: 'bad-json-session',
    usage,
    responseTruncated: true,
    status: 'failed',
    errorKind: 'schema',
  });
  expect(Buffer.byteLength(required(attempt.response))).toBeLessThanOrEqual(262_144);
  expect(attempt.response).not.toContain('\ufffd');
  expect(attempt.response).toBe(text.slice(0, required(attempt.response).length));
});

it('fails permission-denied calls with tool names and preserves their evidence', async () => {
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const result = await ctx.claude.text('permission', {
        prompt: 'respond',
        onPermissionDenied: 'fail',
        onError: 'return',
      });
      return result.ok ? 'unexpected success' : result.error.message;
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: {
      invoke: () =>
        Promise.resolve({
          text: 'partial answer',
          sessionId: 'denied',
          usage,
          permissionDenials: 1,
          diagnostics: { deniedTools: ['Read'], permissionDenials: 1 },
        }),
    },
  });
  expect(run.output).toContain('Read');
  expect(run.steps['permission']?.attemptHistory?.[0]).toMatchObject({
    errorKind: 'permission',
    sessionId: 'denied',
    usage,
    response: 'partial answer',
    diagnostics: { deniedTools: ['Read'] },
  });
});

it('allows Claude-specific profile policy and an explicit per-call warning override', async () => {
  const definition = defineWorkflow({
    ...base,
    defaults: { claude: { onPermissionDenied: 'fail' } },
    async run(ctx) {
      const denied = await ctx.claude.text('default-fail', { prompt: 'answer', onError: 'return' });
      expect(denied.ok).toBe(false);
      return ctx.claude.value('explicit-warn', { prompt: 'answer', onPermissionDenied: 'warn' });
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: {
      invoke: () =>
        Promise.resolve({
          text: 'ok',
          sessionId: 'permission',
          usage,
          permissionDenials: 1,
          diagnostics: { deniedTools: ['Read'] },
        }),
    },
  });
  expect(run.output).toBe('ok');
  expect(run.steps['default-fail']?.status).toBe('settled-failed');
  expect(run.steps['explicit-warn']?.warnings?.[0]).toContain('Read');
});

it('keeps diagnostic keys and cap policy out of completed agent identity', async () => {
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return ctx.codex.value('answer', { prompt: 'answer' });
    },
  });
  const first = await runWorkflow(definition, {
    ...setup('first'),
    harness: {
      invoke: () =>
        Promise.resolve({ text: 'ok', sessionId: 'first', usage, diagnostics: { old: true } }),
    },
  });
  const second = await runWorkflow(definition, {
    ...setup('second'),
    policy: [{ transcripts: 'off', maxRetainedBytes: 2048 }],
    harness: {
      invoke: () =>
        Promise.resolve({
          text: 'ok',
          sessionId: 'second',
          usage,
          diagnostics: { future: { field: 1 } },
        }),
    },
  });
  expect(first.steps['answer']?.fingerprint).toBe(second.steps['answer']?.fingerprint);
  expect(first.sessionSalt).not.toBe(second.sessionSalt);
});

it('serializes transcript streams, caps every file, and refuses a symlinked output directory', async () => {
  const transcript = await AttemptTranscript.create(directory, '../outside', 1, 'codex', 128);
  await Promise.all([
    transcript.write('stdout', Buffer.alloc(100, 65)),
    transcript.write('stderr', Buffer.alloc(100, 66)),
  ]);
  await transcript.close();
  const saved = transcript.snapshot();
  expect(saved.bytes).toBeLessThanOrEqual(128);
  expect(saved.truncated).toBe(true);
  expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  const sibling = join(directory, 'outside');
  await rm(join(directory, 'attempts'), { recursive: true });
  await symlink(sibling, join(directory, 'attempts'));
  await expect(AttemptTranscript.create(directory, 'step', 2, 'claude')).rejects.toThrow(
    'real directory',
  );
});

it('flushes the transcript directory before marking a discarded receipt unretained', async () => {
  const transcript = await AttemptTranscript.create(directory, 'discard-step', 1, 'codex');
  await transcript.write('stdout', Buffer.from('hello'));
  const path = transcript.snapshot().path;
  await transcript.discard();
  expect(transcript.snapshot().retained).toBe(false);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a discarded receipt retained when the directory sync fails', async () => {
  const transcript = await AttemptTranscript.create(directory, 'discard-sync-fail', 1, 'codex');
  vi.spyOn(storageIo, 'syncDirectory').mockRejectedValueOnce(new Error('sync failed'));
  await expect(transcript.discard()).rejects.toThrow('sync failed');
  expect(transcript.snapshot().retained).toBe(true);
});

it.each([{ maxRetainedBytes: 64 }, { maxStreamBytes: 64 }] satisfies PolicyOverride[])(
  'enforces a live adapter cap from invocation policy: %j',
  async (policy) => {
    const agent = await binary(
      `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(1024)}})); setInterval(() => {}, 1000);`,
    );
    await expect(
      new CliHarness({ codexBinary: agent, killGraceMs: 20 }).invoke(
        { harness: 'codex', options: { prompt: 'respond' }, cwd: directory, outputSchema: null },
        { ...testInvocation(), policy },
      ),
    ).rejects.toMatchObject({ code: 'QUIET_CHOIR_OUTPUT_LIMIT' });
  },
);

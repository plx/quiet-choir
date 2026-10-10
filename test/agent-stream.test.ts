import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CliHarness,
  CheckpointError,
  HarnessError,
  WorkflowRunError,
  FileRunStore,
  defineWorkflow,
  deriveAgentSessionId,
  inspectRunOwnership,
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
import { formatAgentEventDetail } from '../src/workflow/loader/executor.js';
import { maxRateLimitWindows } from '../src/workflow/runtime/rate-limit.js';
import { recordEventLines } from '../src/workflow/loader/event-follow.js';
import { EventLineMemory, formatEventLine, type EventLine } from '../src/workflow/loader/events.js';

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
  // measured: 2.0 s alone and in the full coverage run (it waits out the 2 s transcript deadline)
  10_000,
);

// measured: 2.0 s alone and in the full coverage run (it waits out the 2 s transcript deadline)
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

it('reports the monotonic attempt duration on agent.finished for failed and completed attempts', async () => {
  let calls = 0;
  const events: WorkflowEvent[] = [];
  const harness: Harness = {
    invoke() {
      calls++;
      return Promise.resolve({
        text: calls === 1 ? '{"answer":42}' : '{"answer":"ok"}',
        sessionId: `timed-${String(calls)}`,
        usage,
      });
    },
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (
        await ctx.codex.value('timed', {
          prompt: 'respond',
          schema: z.object({ answer: z.string() }),
          retry: { maxAttempts: 2, delayMs: 0 },
        })
      ).answer;
    },
  });
  const run = await runWorkflow(definition, {
    ...setup('timed'),
    harness,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const history = required(run.steps['timed']?.attemptHistory);
  const finished = events.filter((event) => event.type === 'agent.finished');
  expect(finished.map((event) => event.outcome)).toEqual(['failed', 'completed']);
  finished.forEach((event, index) => {
    expect(Number.isInteger(event.durationMs)).toBe(true);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.durationMs).toBe(history[index]?.durationMs);
    expect(formatAgentEventDetail(event)).toMatch(
      new RegExp(
        ` ${String(event.outcome)} durationMs=${String(event.durationMs)} session=timed-`,
        'u',
      ),
    );
  });
});

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
    policy: [{ transcripts: 'off', maxRetainedBytes: 8192 }],
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

function fixtureStdout(name: string): string[] {
  const fixture = JSON.parse(
    readFileSync(new URL(`./fixtures/harness/${name}.json`, import.meta.url), 'utf8'),
  ) as { readonly stdout: string };
  return fixture.stdout.split('\n').filter((line) => line.trim() !== '');
}
const claudeInit = { type: 'system', subtype: 'init', model: 'fake', claude_code_version: '9.9.9' };
const claudeText = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
const claudeTool = (id: string, name = 'Read') => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input: {} }] },
});
const codexItem = (event: string, id: string, type: string) => ({
  type: event,
  item: { id, type, ...(type === 'agent_message' ? { text: 'hello' } : { command: 'ls' }) },
});
const codexLines = (...items: unknown[]) => {
  const [started, turn, message, completed] = fixtureStdout('codex-text-success');
  return [started, turn, ...items, message, completed];
};

/** A fake CLI that prints these protocol lines, then runs `after` (for example, to hang). */
async function protocolBinary(lines: readonly unknown[], after = ''): Promise<string> {
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
  return binary(`for (const line of ${JSON.stringify(text)}) console.log(line);\n${after}`);
}

async function toolUseRun(
  harness: 'claude' | 'codex',
  lines: readonly unknown[],
  profile: 'text' | 'readonly' = 'readonly',
  structured = false,
  runId = 'stream',
  policy: PolicyOverride[] = [],
) {
  const agent = await protocolBinary(lines);
  const events: WorkflowEvent[] = [];
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      if (structured)
        return JSON.stringify(
          await ctx.claude.value('task', {
            prompt: 'answer',
            profile,
            schema: z.object({ answer: z.string() }),
          }),
        );
      return (await ctx[harness].text('task', { prompt: 'answer', profile })).output;
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(runId),
    harness: new CliHarness({ claudeBinary: agent, codexBinary: agent, killGraceMs: 20 }),
    ...(policy.length > 0 ? { policy } : {}),
    onEvent: (event) => {
      events.push(event);
    },
  });
  const step = required(run.steps['task']);
  return {
    run,
    events,
    step,
    toolUses: step.attemptHistory?.[0]?.diagnostics?.['toolUses'],
    finished: events.filter((event) => event.type === 'agent.finished'),
  };
}

/** The step.completed line for `task`, as --events writes it live and as the record follower derives it. */
function taskCompletedLines(result: Awaited<ReturnType<typeof toolUseRun>>) {
  const memory = new EventLineMemory();
  const live = result.events
    .map((event) => formatEventLine(event, memory))
    .filter((text): text is string => text !== null)
    .map((text) => JSON.parse(text) as EventLine)
    .filter((line) => line.step === 'task' && line.ev === 'step.completed');
  const recorded = recordEventLines(result.run, null, 'all')
    .lines.map((text) => JSON.parse(text) as EventLine)
    .filter((line) => line.step === 'task' && line.ev === 'step.completed');
  return { live, recorded };
}

const noToolUse = (harness: string, profile = 'readonly') =>
  `no-tool-use: Profile ${profile} expects tool use, but the ${harness} attempt completed without a tool call.`;

it('warns when a Claude attempt that expects tools completes without one', async () => {
  const { step, toolUses, finished } = await toolUseRun('claude', [
    claudeInit,
    claudeText,
    ...fixtureStdout('claude-text-success'),
  ]);
  expect(toolUses).toBe(0);
  expect(step.warnings).toEqual([noToolUse('claude')]);
  expect(finished).toMatchObject([{ outcome: 'completed', warnings: [noToolUse('claude')] }]);
});

it.each(['claude', 'codex'] as const)(
  'shows a %s attempt without a tool call as a no-tool-use step.completed line in --events',
  async (harness) => {
    const result = await toolUseRun(
      harness,
      harness === 'claude'
        ? [claudeInit, claudeText, ...fixtureStdout('claude-text-success')]
        : codexLines(),
      'readonly',
      false,
      `events-${harness}`,
    );
    const { live, recorded } = taskCompletedLines(result);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ harness, toolUses: 0 });
    expect(live[0]?.msg?.startsWith('no-tool-use:')).toBe(true);
    expect(live[0]?.msg).toBe(noToolUse(harness));
    // The record yields the same line apart from process-observed time and duration.
    expect(recorded).toHaveLength(1);
    const stable = (line: EventLine) => ({ ...line, t: undefined, ms: undefined });
    expect(recorded.map(stable)).toEqual(live.map(stable));
  },
);

it('leaves toolUses on and warnings off the step.completed line of an attempt that used a tool', async () => {
  const result = await toolUseRun(
    'claude',
    [claudeInit, claudeTool('toolu_1'), claudeText, ...fixtureStdout('claude-text-success')],
    'readonly',
    false,
    'events-tool',
  );
  const { live, recorded } = taskCompletedLines(result);
  expect(live[0]).toMatchObject({ toolUses: 1 });
  expect(live[0]).not.toHaveProperty('msg');
  expect(recorded[0]).toMatchObject({ toolUses: 1 });
  expect(recorded[0]).not.toHaveProperty('msg');
});

it('counts a Claude tool_use block once, even when its ID repeats, and does not warn', async () => {
  const { step, toolUses, finished } = await toolUseRun('claude', [
    claudeInit,
    claudeTool('toolu_1'),
    claudeTool('toolu_1'),
    claudeText,
    ...fixtureStdout('claude-text-success'),
  ]);
  expect(toolUses).toBe(1);
  expect(step.warnings).toBeUndefined();
  expect(finished[0]).not.toHaveProperty('warnings');
});

it('does not count the synthetic StructuredOutput tool of a structured Claude call', async () => {
  const { step, toolUses } = await toolUseRun(
    'claude',
    [
      claudeInit,
      claudeTool('toolu_s', 'StructuredOutput'),
      ...fixtureStdout('claude-structured-success'),
    ],
    'readonly',
    true,
  );
  expect(toolUses).toBe(0);
  expect(step.warnings).toEqual([noToolUse('claude')]);
});

it('warns for a Codex attempt with only a message, and counts a started+completed item once', async () => {
  const silent = await toolUseRun('codex', codexLines());
  expect(silent.toolUses).toBe(0);
  expect(silent.step.warnings).toEqual([noToolUse('codex')]);
  const tool = await toolUseRun(
    'codex',
    codexLines(
      codexItem('item.started', 'item_1', 'command_execution'),
      codexItem('item.completed', 'item_1', 'command_execution'),
    ),
    'readonly',
    false,
    'stream-tool',
  );
  expect(tool.toolUses).toBe(1);
  expect(tool.step.warnings).toBeUndefined();
});

describe('oversized skipped lines', () => {
  const cap: PolicyOverride[] = [{ maxRetainedBytes: 8192 }];
  const huge = 'x'.repeat(20_000);
  const bigCodex = (event: string, id: string | undefined, type: string, extra = {}) => ({
    type: event,
    item: { ...(id === undefined ? {} : { id }), type, aggregated_output: huge, ...extra },
  });

  it('counts a skipped oversized Codex tool item from its header, so no warning', async () => {
    const run = await toolUseRun(
      'codex',
      codexLines(bigCodex('item.completed', 'command', 'command_execution')),
      'readonly',
      false,
      'stream-big',
      cap,
    );
    expect(run.step.attemptHistory?.[0]?.diagnostics).toMatchObject({ skippedLines: 1 });
    expect(run.toolUses).toBe(1);
    expect(run.step.warnings).toBeUndefined();
  });

  it('counts a started item and its oversized completion once, with or without an ID', async () => {
    const paired = await toolUseRun(
      'codex',
      codexLines(
        codexItem('item.started', 'item_1', 'command_execution'),
        bigCodex('item.completed', 'item_1', 'command_execution'),
        bigCodex('item.updated', 'item_2', 'file_change'),
        bigCodex('item.completed', 'item_2', 'file_change'),
        bigCodex('item.completed', undefined, 'mcp_tool_call'),
      ),
      'readonly',
      false,
      'stream-big-pair',
      cap,
    );
    expect(paired.toolUses).toBe(3);
    expect(paired.step.warnings).toBeUndefined();
  });

  it('does not count skipped Codex items that are not tool calls', async () => {
    const { step, toolUses } = await toolUseRun(
      'codex',
      codexLines(bigCodex('item.completed', 'think', 'reasoning')),
      'readonly',
      false,
      'stream-big-reasoning',
      cap,
    );
    expect(toolUses).toBe(0);
    expect(step.warnings).toEqual([noToolUse('codex')]);
  });

  it('reports an unknown count when an oversized Claude assistant line is skipped', async () => {
    const oversized = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: huge },
          { type: 'tool_use', id: 'toolu_big', name: 'Read', input: {} },
        ],
      },
    };
    const { step, toolUses } = await toolUseRun(
      'claude',
      [claudeInit, oversized, claudeText, ...fixtureStdout('claude-text-success')],
      'readonly',
      false,
      'stream-big-claude',
      cap,
    );
    expect(step.attemptHistory?.[0]?.diagnostics).toMatchObject({ skippedLines: 1 });
    expect(toolUses).toBeNull();
    expect(step.warnings).toBeUndefined();
  });

  it('keeps a positive Claude count when a later assistant line is skipped', async () => {
    const { step, toolUses } = await toolUseRun(
      'claude',
      [
        claudeInit,
        claudeTool('toolu_1'),
        { type: 'assistant', message: { content: [{ type: 'text', text: huge }] } },
        ...fixtureStdout('claude-text-success'),
      ],
      'readonly',
      false,
      'stream-big-claude-count',
      cap,
    );
    expect(toolUses).toBe(1);
    expect(step.warnings).toBeUndefined();
  });
});

it.each(['claude', 'codex'] as const)(
  'does not warn under the text profile, which no longer expects tools (%s)',
  async (harness) => {
    const { step, toolUses } = await toolUseRun(
      harness,
      harness === 'claude'
        ? [claudeInit, claudeText, ...fixtureStdout('claude-text-success')]
        : codexLines(),
      'text',
    );
    expect(toolUses).toBe(0);
    expect(step.warnings).toBeUndefined();
  },
);

it('keeps the discovered Codex CLI version when the stream reports none', async () => {
  const { step } = await toolUseRun('codex', codexLines(), 'text');
  expect(step.attemptHistory?.[0]?.diagnostics).toMatchObject({ cliVersion: '1.2.3' });
});

describe('idle deadline', () => {
  const hang = 'setInterval(() => {}, 1000);';
  const stalled = (
    retry?: { maxAttempts: number; delayMs: number; on: ('timeout' | 'idle-timeout')[] },
    idle = 200,
  ) =>
    defineWorkflow({
      ...base,
      defaults: { idleTimeoutMs: idle },
      async run(ctx) {
        return (await ctx.claude.text('stall', { prompt: 'x', ...(retry ? { retry } : {}) }))
          .output;
      },
    });

  it('ends a silent Claude CLI with kind idle-timeout and a resume hint, and reaps it', async () => {
    const agent = await protocolBinary([claudeInit], hang);
    const harness = new CliHarness({ claudeBinary: agent, killGraceMs: 20 });
    await expect(runWorkflow(stalled(), { ...setup(), harness })).rejects.toThrow(
      'produced no output for 200ms (idleTimeoutMs)',
    );
    const step = required((await readRun(setup())).steps['stall']);
    expect(step.attemptHistory?.map((attempt) => attempt.errorKind)).toEqual(['idle-timeout']);
    expect(step.attemptHistory?.[0]?.diagnostics).toMatchObject({ toolUses: 0 });
    expect(step.error).toContain('Retry: --resume --profile text.idleTimeoutMs=400');
    expect((await inspectRunOwnership({ stateDir: directory, runId: 'stream' })).processes).toEqual(
      [],
    );
  });

  it.each([
    [['idle-timeout'] as const, 2],
    [['timeout'] as const, 1],
  ])('lets retry.on %j target idle-timeout', async (on, attempts) => {
    const agent = await protocolBinary([claudeInit], hang);
    const harness = new CliHarness({ claudeBinary: agent, killGraceMs: 20 });
    await expect(
      runWorkflow(stalled({ maxAttempts: 2, delayMs: 0, on: [...on] }), { ...setup(), harness }),
    ).rejects.toThrow('idleTimeoutMs');
    expect((await readRun(setup())).steps['stall']?.attemptHistory).toHaveLength(attempts);
  });

  it('never ends a Claude CLI that keeps streaming past several idle windows', async () => {
    const [result] = fixtureStdout('claude-text-success');
    const agent = await binary(`
console.log(${JSON.stringify(JSON.stringify(claudeInit))});
let n = 0;
const timer = setInterval(() => {
  console.log(JSON.stringify({ type: 'system', subtype: 'status' }));
  if (++n === 30) { clearInterval(timer); console.log(${JSON.stringify(result)}); }
}, 40);`);
    const harness = new CliHarness({ claudeBinary: agent, killGraceMs: 20 });
    // About 1.2 s of status lines every 40 ms against a 400 ms idle window (three windows). Child
    // startup counts as idleness, so the window leaves room for a loaded machine.
    const run = await runWorkflow(stalled(undefined, 400), { ...setup(), harness });
    expect(run.output).toBe('hello from captured claude');
  });

  it('raises the deadline on resume with --profile and reuses completed steps', async () => {
    const log = join(directory, 'calls.log');
    const agent = await binary(`
const { appendFileSync } = require('node:fs');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(log)}, prompt + '\\n');
  console.log(${JSON.stringify(JSON.stringify(claudeInit))});
  // The slow step is silent for 1000 ms: longer than 400 ms, shorter than 5000 ms.
  setTimeout(() => console.log(${JSON.stringify(fixtureStdout('claude-text-success')[0])}), prompt === 'slow' ? 1000 : 0);
});`);
    const definition = defineWorkflow({
      ...base,
      profiles: { scout: { idleTimeoutMs: 400 } },
      async run(ctx) {
        await ctx.claude.text('first', { prompt: 'fast', profile: 'scout' });
        return (await ctx.claude.text('second', { prompt: 'slow', profile: 'scout' })).output;
      },
    });
    const harness = new CliHarness({ claudeBinary: agent, killGraceMs: 20 });
    await expect(runWorkflow(definition, { ...setup(), harness })).rejects.toThrow(
      '--profile scout.idleTimeoutMs=800',
    );
    const run = await runWorkflow(definition, {
      ...setup(),
      harness,
      resume: true,
      profileOverrides: [{ profile: 'scout', idleTimeoutMs: 5000 }],
    });
    expect(run.status).toBe('completed');
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['fast', 'slow', 'slow']);
    expect(run.steps['second']?.redefinitions).toBeUndefined();
    expect(
      run.steps['second']?.attemptHistory?.map((attempt) => attempt.errorKind ?? null),
    ).toEqual(['idle-timeout', null]);
    expect(run.steps['second']?.attemptHistory?.[1]).toMatchObject({
      policy: { idleTimeoutMs: 5000 },
      sources: { idleTimeoutMs: 'profile-override:0' },
    });
  });
});

describe('subscription rate-limit windows', () => {
  const rateEvent = (info: unknown) => ({ type: 'rate_limit_event', rate_limit_info: info });
  const first = rateEvent({
    status: 'allowed',
    resetsAt: 100,
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: 0.22 }, seven_day: { utilization: 0.67 } },
  });
  const second = rateEvent({
    status: 'allowed_warning',
    resetsAt: 200,
    rateLimitType: 'seven_day',
    unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 150 } },
  });
  const tail = fixtureStdout('claude-text-success');
  const textOf = (step: { output: unknown }) => (step.output as { output?: unknown }).output;
  const rateLimitOf = (step: { attemptHistory?: { diagnostics?: Record<string, unknown> }[] }) =>
    step.attemptHistory?.[0]?.diagnostics?.['rateLimit'];

  it('records the live capture on the attempt and on agent.finished, and shows it in the log line', async () => {
    vi.stubEnv('QUIET_CHOIR_FAKE_SCENARIO', 'claude-rate-limit-success');
    const events: WorkflowEvent[] = [];
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx.claude.text('task', { prompt: 'answer' })).output;
      },
    });
    const run = await runWorkflow(definition, {
      ...setup('rate-limit-fixture'),
      harness: new CliHarness({
        claudeBinary: fileURLToPath(new URL('./bin/fake-claude.mjs', import.meta.url)),
        killGraceMs: 20,
      }),
      onEvent: (event) => {
        events.push(event);
      },
    });
    vi.unstubAllEnvs();
    expect(run.status).toBe('completed');
    expect(run.output).toBe('ok');
    const expected = {
      status: 'allowed_warning',
      type: 'seven_day',
      resetsAt: 1791360000,
      windows: {
        five_hour: { utilization: 0.01, resetsAt: 1791014400 },
        seven_day: { utilization: 0.84, resetsAt: 1791360000 },
      },
    };
    expect(run.steps['task']?.attemptHistory?.[0]?.diagnostics?.['rateLimit']).toEqual(expected);
    const finished = events.filter((event) => event.type === 'agent.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.diagnostics?.['rateLimit']).toEqual(expected);
    expect(formatAgentEventDetail(required(finished[0]))).toMatch(
      / completed durationMs=\d+ session=\S+ rate-limit: 5h window 1%, 7d 84%$/u,
    );
  });

  it('reports a lossy status progress line for a rate-limit event, valid or not', async () => {
    const lines = [claudeInit, first, rateEvent('garbage'), ...tail].map((line) =>
      typeof line === 'string' ? line : JSON.stringify(line),
    );
    // Progress is throttled to one line per 100 ms, so each line waits past the window.
    const agent = await binary(`
      const lines = ${JSON.stringify(lines)};
      for (const line of lines) {
        console.log(line);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    `);
    const summaries: string[] = [];
    await new CliHarness({ claudeBinary: agent, killGraceMs: 20 }).invoke(
      { harness: 'claude', options: { prompt: 'respond' }, cwd: directory, outputSchema: null },
      {
        ...testInvocation(),
        onProgress: (progress) => {
          summaries.push(progress.summary);
        },
      },
    );
    expect(summaries).toContain('Claude: rate limit allowed');
    expect(summaries).toContain('Claude: rate limit event');
  });

  it('renders agent events without a report exactly as before', () => {
    const event = {
      type: 'agent.finished',
      runId: 'run',
      stepId: 'task',
      attempt: 2,
      harness: 'claude',
      outcome: 'completed',
      sessionId: 'abc',
      at: '2026-10-01T00:00:00.000Z',
      execution: 1,
      diagnostics: { toolUses: 0 },
    } as unknown as WorkflowEvent;
    expect(formatAgentEventDetail(event)).toBe(
      'task (attempt 2) harness=claude completed session=abc',
    );
    // A report on any other event type is not shown.
    const limit = { status: 'allowed', windows: { five_hour: { utilization: 0.5 } } };
    expect(formatAgentEventDetail({ ...event, diagnostics: { rateLimit: limit } })).toBe(
      'task (attempt 2) harness=claude completed session=abc rate-limit: 5h window 50%',
    );
    expect(
      formatAgentEventDetail({
        ...event,
        type: 'agent.progress',
        diagnostics: { rateLimit: limit },
      } as unknown as WorkflowEvent),
    ).toBe('task (attempt 2) harness=claude completed session=abc');
    // The attempt duration follows the outcome on agent.finished only.
    expect(formatAgentEventDetail({ ...event, durationMs: 1234 })).toBe(
      'task (attempt 2) harness=claude completed durationMs=1234 session=abc',
    );
    expect(formatAgentEventDetail({ ...event, durationMs: null })).toBe(
      'task (attempt 2) harness=claude completed session=abc',
    );
    expect(
      formatAgentEventDetail({
        ...event,
        type: 'agent.started',
        durationMs: 5,
      } as unknown as WorkflowEvent),
    ).toBe('task (attempt 2) harness=claude completed session=abc');
    // A custom adapter's invalid report is ignored rather than printed.
    expect(
      formatAgentEventDetail({
        ...event,
        diagnostics: { rateLimit: { windows: { five_hour: { utilization: 'x' } } } },
      }),
    ).toBe('task (attempt 2) harness=claude completed session=abc');
  });

  it('keeps the latest of several events in one call', async () => {
    const { step } = await toolUseRun(
      'claude',
      [claudeInit, first, claudeText, second, ...tail],
      'text',
      false,
      'rate-limit-latest',
    );
    expect(rateLimitOf(step)).toEqual({
      status: 'allowed_warning',
      type: 'seven_day',
      resetsAt: 200,
      windows: { five_hour: { utilization: 0.3, resetsAt: 150 } },
    });
  });

  it('keeps an earlier valid report when a later event is malformed', async () => {
    const { step } = await toolUseRun(
      'claude',
      [claudeInit, first, rateEvent('garbage'), { type: 'rate_limit_event' }, ...tail],
      'text',
      false,
      'rate-limit-kept',
    );
    expect(rateLimitOf(step)).toMatchObject({ status: 'allowed', type: 'five_hour' });
  });

  it('ignores malformed events without changing the attempt output, usage or diagnostics keys', async () => {
    const huge = 'x'.repeat(5000);
    const malformed = [
      { type: 'rate_limit_event' },
      rateEvent(null),
      rateEvent('allowed'),
      rateEvent([first]),
      rateEvent({}),
      rateEvent({ unifiedWindows: [{ utilization: 0.5 }] }),
      rateEvent({ unifiedWindows: { five_hour: { utilization: '0.5' } } }),
      rateEvent({
        unifiedWindows: { five_hour: { utilization: -1 }, seven_day: { utilization: null } },
      }),
      rateEvent({ status: 7, rateLimitType: [], resetsAt: 'tomorrow' }),
      { type: 'rate_limit_event', rate_limit_info: 5 },
    ];
    const plain = await toolUseRun(
      'claude',
      [claudeInit, claudeText, ...tail],
      'text',
      false,
      'rate-limit-plain',
    );
    const noisy = await toolUseRun(
      'claude',
      [claudeInit, ...malformed, claudeText, ...tail],
      'text',
      false,
      'rate-limit-noisy',
    );
    expect(noisy.step.status).toBe('completed');
    expect(textOf(noisy.step)).toBe('hello from captured claude');
    expect(textOf(noisy.step)).toEqual(textOf(plain.step));
    expect(noisy.step.attemptHistory?.[0]?.usage).toEqual(plain.step.attemptHistory?.[0]?.usage);
    expect(rateLimitOf(noisy.step)).toBeUndefined();
    expect(Object.keys(noisy.step.attemptHistory?.[0]?.diagnostics ?? {}).sort()).toEqual(
      Object.keys(plain.step.attemptHistory?.[0]?.diagnostics ?? {}).sort(),
    );
    // Oversized strings and window lists are bounded, not rejected.
    const bounded = await toolUseRun(
      'claude',
      [
        claudeInit,
        rateEvent({
          status: huge,
          rateLimitType: huge,
          unifiedWindows: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `${String(index)}${huge}`,
              { utilization: 0.5 },
            ]),
          ),
        }),
        claudeText,
        ...tail,
      ],
      'text',
      false,
      'rate-limit-bounded',
    );
    const stored = rateLimitOf(bounded.step) as {
      status: string;
      type: string;
      windows: Record<string, unknown>;
    };
    expect(stored.status).toHaveLength(64);
    expect(stored.type).toHaveLength(64);
    expect(Object.keys(stored.windows)).toHaveLength(maxRateLimitWindows);
  });

  it('leaves Codex attempts without a rateLimit even when a stray event arrives', async () => {
    const plain = await toolUseRun('codex', codexLines(), 'text', false, 'rate-codex-plain');
    const stray = await toolUseRun('codex', codexLines(first), 'text', false, 'rate-codex-stray');
    expect(rateLimitOf(stray.step)).toBeUndefined();
    expect(stray.step.attemptHistory?.[0]?.diagnostics).not.toHaveProperty('rateLimit');
    expect(Object.keys(stray.step.attemptHistory?.[0]?.diagnostics ?? {}).sort()).toEqual(
      Object.keys(plain.step.attemptHistory?.[0]?.diagnostics ?? {}).sort(),
    );
    expect(textOf(stray.step)).toEqual(textOf(plain.step));
  });
});

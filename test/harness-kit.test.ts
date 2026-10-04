import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWorkflow, readRun, runWorkflow } from '../src/index.js';
import { ClaudeAdapter, CodexAdapter } from '../src/harnesses/builtins/adapters.js';
import {
  assertHarnessConformance,
  childEnvironment,
  createFakeBinary,
  createInvocationStream,
  JsonLines,
  promptedStructuredOutput,
  runProcess,
  standaloneInvocation,
  defineHarness,
  z,
  type AgentRequest,
  type HarnessAdapter,
  type HarnessConformanceCase,
  type HarnessInvocation,
} from '../src/harness-kit.js';

type Builtin = 'claude' | 'codex';
type ConformanceOptions = Parameters<typeof assertHarnessConformance>[0];
const conformance = {
  text: 'hello',
  failureReason: 'fake native failure',
  structured: { ok: true },
} as const;

/** Native events a built-in fake answers with in one scenario. */
function builtinEvents(harness: Builtin, scenario: HarnessConformanceCase): unknown[] {
  const text = scenario === 'structured' ? '{"ok":true}' : 'hello';
  const failure = scenario === 'protocol-error' || scenario === 'nonzero-stdout';
  if (harness === 'claude')
    return [
      scenario === 'rate-limit'
        ? {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            api_error_status: 429,
            result: 'rate limited',
            session_id: 'fake-session',
          }
        : {
            type: 'result',
            subtype: failure ? 'error_during_execution' : 'success',
            is_error: failure,
            result: failure ? 'fake native failure' : text,
            ...(scenario === 'structured' ? { structured_output: { ok: true } } : {}),
            session_id: 'fake-session',
          },
    ];
  return [
    { type: 'thread.started', thread_id: 'fake-thread' },
    ...(scenario === 'rate-limit'
      ? [
          {
            type: 'turn.failed',
            error: {
              message: JSON.stringify({ status: 429, error: { message: 'quota exceeded' } }),
            },
          },
        ]
      : failure
        ? [{ type: 'turn.failed', error: { message: 'fake native failure' } }]
        : [
            { type: 'item.completed', item: { type: 'agent_message', text } },
            { type: 'turn.completed' },
          ]),
  ];
}

/**
 * The built-in conformance fixture: a fake CLI that marks its start and first input, reports its
 * environment names, then answers with the scenario's native events or hangs until stopped.
 */
function builtinFixture(
  harness: Builtin,
  makeAdapter: (binary: string) => HarnessAdapter = (binary) =>
    harness === 'claude'
      ? new ClaudeAdapter({ binary, killGraceMs: 25 })
      : new CodexAdapter({ binary, killGraceMs: 25 }),
): ConformanceOptions['fixture'] {
  return async (scenario, probe) => {
    const hang = scenario === 'abort' || scenario === 'timeout';
    const stdout = builtinEvents(harness, scenario)
      .map((value) => JSON.stringify(value) + '\n')
      .join('');
    const exitCode = ['nonzero-stdout', 'rate-limit'].includes(scenario) ? 1 : 0;
    const binary = await createFakeBinary(
      `fake-${harness}`,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(probe.started)}, '');
      let marked = false;
      const mark = () => {
        if (!marked) writeFileSync(${JSON.stringify(probe.input)}, '');
        marked = true;
      };
      for await (const _ of process.stdin) mark();
      mark();
      writeFileSync(${JSON.stringify(probe.environment)}, JSON.stringify(Object.keys(process.env)));
      ${hang ? 'setInterval(() => {}, 1000);' : `process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${String(exitCode)};`}
    `,
    );
    const call = {
      runId: 'conformance',
      stepId: scenario,
      attempt: 1,
      idempotencyKey: `conformance/${scenario}`,
    };
    return {
      adapter: makeAdapter(binary.path),
      request: {
        harness,
        revision: 1,
        ...call,
        call,
        options: { prompt: 'hello' },
        cwd: binary.directory,
        outputSchema:
          scenario === 'structured'
            ? {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              }
            : null,
      },
      ...(hang ? {} : { expectedStdout: stdout }),
      dispose: () => binary.dispose(),
    };
  };
}

// measured: 2.4-2.6 s alone, 2.3 s in the full coverage run (twelve fake-CLI launches plus the
// 250 ms registration hold and the 250 ms timeout)
const builtinSuiteTimeoutMs = 7_000;
// measured: 'ignores the timeout' 4.1 s alone, 3.9 s in the full coverage run (it waits out the
// 250 ms timeout plus the 2 s abort deadline); the other three take 1.1-2.4 s
const negativeSuiteTimeoutMs = 12_000;

for (const harness of ['claude', 'codex'] as const)
  it(
    `${harness} passes the public adapter conformance suite with fake binaries`,
    async () => {
      await assertHarnessConformance({ ...conformance, fixture: builtinFixture(harness) });
    },
    builtinSuiteTimeoutMs,
  );

/** Wrap a built-in Claude adapter so it changes only how it treats the invocation. */
function wrapped(
  change: (
    request: AgentRequest,
    invocation: HarnessInvocation,
  ) => readonly [AgentRequest, HarnessInvocation],
): (binary: string) => HarnessAdapter {
  return (binary) => {
    const inner = new ClaudeAdapter({ binary, killGraceMs: 25 }) as unknown as HarnessAdapter;
    return {
      invoke(request, signal, invocation) {
        if (!invocation) throw new Error('The conformance suite must pass an invocation.');
        const [changed, forwarded] = change(request, invocation);
        return inner.invoke(changed, signal, forwarded);
      },
    };
  };
}
const unregistered = () => Promise.resolve({ release: () => Promise.resolve() });

it.each([
  {
    failure: 'never calls trackProcess',
    adapter: wrapped((request, invocation) => [
      request,
      { ...invocation, trackProcess: unregistered },
    ]),
    message: /^Conformance scenario registration-before-input: .*trackProcess/u,
  },
  {
    failure: 'sends input before registration resolves',
    adapter: wrapped((request, invocation) => [
      request,
      {
        ...invocation,
        trackProcess: (child) => {
          // Starts the durable registration but writes input without waiting for it.
          void invocation.trackProcess(child);
          return unregistered();
        },
      },
    ]),
    message: /^Conformance scenario registration-before-input: .*input/u,
  },
  {
    failure: 'ignores the timeout',
    adapter: wrapped((request, invocation) => {
      const options = { ...request.options };
      const policy = { ...invocation.policy };
      delete options.timeoutMs;
      delete policy.timeoutMs;
      return [
        { ...request, options },
        { ...invocation, policy },
      ];
    }),
    message: /^Conformance scenario timeout: .*timeout/u,
  },
  {
    failure: 'leaks CLAUDECODE',
    adapter: (binary: string) =>
      new ClaudeAdapter({ binary, scrubEnv: false, killGraceMs: 25 }) as unknown as HarnessAdapter,
    message: /^Conformance scenario env: .*CLAUDECODE/u,
  },
])(
  'fails an adapter that $failure, naming the scenario',
  async ({ adapter, message }) => {
    const before = process.env['CLAUDECODE'];
    await expect(
      assertHarnessConformance({ ...conformance, fixture: builtinFixture('claude', adapter) }),
    ).rejects.toThrow(message);
    // The env scenario restores the host's variables even when the adapter fails it.
    expect(process.env['CLAUDECODE']).toBe(before);
  },
  negativeSuiteTimeoutMs,
);

type Defect =
  | 'live-release'
  | 'double-session'
  | 'no-expected-stdout'
  | 'wrong-transcript'
  | 'unclassified-429';

/**
 * An in-process adapter that honors every scenario before the one its defect breaks, so each
 * contract check is shown to fail without a native process.
 */
function scripted(defect: Defect): ConformanceOptions['fixture'] {
  return (scenario, probe) => {
    const call = {
      runId: 'conformance',
      stepId: scenario,
      attempt: 1,
      idempotencyKey: `conformance/${scenario}`,
    };
    const adapter: HarnessAdapter = {
      async invoke(_request, signal, invocation) {
        if (!invocation) throw new Error('The conformance suite must pass an invocation.');
        if (scenario === 'protocol-error' || scenario === 'nonzero-stdout')
          throw new Error('fake native failure');
        if (scenario === 'abort' || scenario === 'timeout')
          return new Promise((_resolve, reject) => {
            const timer = setTimeout(() => {
              reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
            }, invocation.policy?.timeoutMs ?? 60_000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
        if (scenario === 'rate-limit') throw new Error('HTTP 429 without a classified kind');
        if (scenario === 'registration-before-input') {
          writeFileSync(probe.started, '');
          // A reaped child's PID stands in for a finished process; the test runner's is still alive.
          const pid =
            defect === 'live-release' ? process.pid : spawnSync(process.execPath, ['-e', '']).pid;
          const lease = await invocation.trackProcess({
            pid,
            pgid: null,
            binary: 'scripted',
            cwd: tmpdir(),
            startedAt: new Date().toISOString(),
            osStartTime: null,
          });
          writeFileSync(probe.input, '');
          await lease.release();
        }
        if (scenario === 'session') {
          await invocation.onSession?.('scripted-session');
          if (defect === 'double-session') await invocation.onSession?.('scripted-session');
          return { text: 'hello', sessionId: 'scripted-session' };
        }
        if (scenario === 'transcript')
          await invocation.onOutput?.(
            'stdout',
            Buffer.from(defect === 'wrong-transcript' ? 'other' : 'hello'),
          );
        return { text: scenario === 'structured' ? '{"ok":true}' : 'hello', sessionId: null };
      },
    };
    return Promise.resolve({
      adapter,
      request: {
        harness: 'scripted',
        revision: 1,
        ...call,
        call,
        options: { prompt: 'hello' },
        cwd: tmpdir(),
        outputSchema: null,
      },
      ...(defect === 'no-expected-stdout' ? {} : { expectedStdout: 'hello' }),
    });
  };
}

it.each([
  ['live-release', /^Conformance scenario registration-before-input: .*reaped/u],
  ['double-session', /^Conformance scenario session: .*exactly once/u],
  ['no-expected-stdout', /^Conformance scenario transcript: .*expectedStdout/u],
  ['wrong-transcript', /^Conformance scenario transcript: .*stdout bytes/u],
  ['unclassified-429', /^Conformance scenario rate-limit: .*'rate-limit'/u],
] as const)('fails an in-process adapter with defect %s', async (defect, message) => {
  await expect(
    assertHarnessConformance({ ...conformance, fixture: scripted(defect) }),
  ).rejects.toThrow(message);
});

it('rejects an adapter whose abort scenario fails before cancellation', async () => {
  const request = {
    harness: 'eager',
    revision: 1,
    runId: 'conformance',
    stepId: 'abort',
    attempt: 1,
    idempotencyKey: 'conformance/abort',
    call: {
      runId: 'conformance',
      stepId: 'abort',
      attempt: 1,
      idempotencyKey: 'conformance/abort',
    },
    options: { prompt: 'hello' },
    cwd: tmpdir(),
    outputSchema: null,
  };
  let aborted: boolean | undefined;
  await expect(
    assertHarnessConformance({
      text: 'hello',
      failureReason: 'fake native failure',
      structured: { ok: true },
      fixture: (scenario) =>
        Promise.resolve({
          request,
          adapter: {
            invoke(_request, signal) {
              if (scenario === 'protocol-error' || scenario === 'nonzero-stdout')
                return Promise.reject(new Error('fake native failure'));
              if (scenario === 'abort') {
                aborted = signal.aborted;
                // Correct in every other scenario; only this one rejects without observing abort.
                return Promise.reject(new Error('missing executable'));
              }
              return Promise.resolve({
                text: scenario === 'structured' ? '{"ok":true}' : 'hello',
                sessionId: null,
              });
            },
          },
        }),
    }),
  ).rejects.toThrow('Adapter rejected before cancellation');
  expect(aborted).toBe(false);
});

it('adds a third harness entirely through the public package contracts and fake CLI on PATH', async () => {
  // A JSONL CLI that cannot enforce a schema: it answers with fenced JSON inside prose.
  const binary = await createFakeBinary(
    'third-agent',
    `
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    if (!request.prompt.includes('JSON Schema')) throw new Error('missing prompted instructions');
    const answer = [request.prompt.split('\\n')[0], request.provider, request.thinking,
      process.env.CLAUDECODE ?? 'scrubbed'].join(':');
    const lines = [
      { type: 'session', id: 'third-session-1' },
      { type: 'progress', summary: 'thinking' },
      { type: 'answer', text: 'Sure.\\n\`\`\`json\\n' + JSON.stringify({ answer }) + '\\n\`\`\`' },
    ];
    process.stdout.write(lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n');
  `,
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-kit-run-'));
  const seen: AgentRequest[] = [];
  vi.stubEnv('CLAUDECODE', 'host-session-marker');
  try {
    const third = defineHarness({
      name: 'third-agent',
      revision: 7,
      options: z.object({
        prompt: z.string(),
        provider: z.string(),
        thinking: z.enum(['low', 'high']),
      }),
      capabilities: { structuredOutput: 'prompted' },
      access: () => 'none',
      createAdapter(config) {
        const parsed = z.object({ binary: z.string(), path: z.string() }).parse(config);
        return {
          async invoke(request, signal, supplied) {
            seen.push(request);
            const invocation = supplied ?? standaloneInvocation(request, signal);
            const prompted =
              request.outputSchema === null
                ? undefined
                : promptedStructuredOutput(request.outputSchema);
            let answer: string | undefined;
            const lines = new JsonLines(64 * 1024, async (line) => {
              const event = z
                .object({ type: z.string(), id: z.string(), summary: z.string(), text: z.string() })
                .partial()
                .parse(JSON.parse(line));
              if (event.type === 'session' && event.id) await stream.session(event.id);
              if (event.type === 'progress')
                stream.progress({ kind: 'status', summary: event.summary ?? '' });
              if (event.type === 'answer') answer = event.text;
            });
            const stream = createInvocationStream({
              invocation,
              stdout: (chunk) => lines.feed(chunk),
            });
            const environment = childEnvironment({ set: { PATH: parsed.path } });
            const result = await runProcess({
              binary: parsed.binary,
              env: environment.env,
              inheritEnv: false,
              args: [],
              cwd: request.cwd,
              input: JSON.stringify({
                ...request.options,
                prompt: request.options.prompt + (prompted?.instructions ?? ''),
              }),
              signal,
              timeoutMs: invocation.policy?.timeoutMs ?? 5000,
              maxOutputBytes: 64 * 1024,
              stream: { maxBytes: 1024 * 1024, stdout: stream.stdout, stderr: stream.stderr },
              killGraceMs: 25,
              trackProcess: invocation.trackProcess.bind(invocation),
            });
            await lines.finish();
            if (result.code !== 0 || answer === undefined)
              throw new Error(`third-agent failed: ${result.stderr}`);
            // The session reached the runtime only through createInvocationStream.
            return { text: prompted ? prompted.extract(answer) : answer, sessionId: null };
          },
        };
      },
    });
    const workflow = defineWorkflow({
      name: 'third-package',
      version: '1',
      harnesses: [third],
      input: z.null(),
      output: z.object({ answer: z.string() }),
      async run(ctx) {
        return ctx.agent('third-agent').value('answer', {
          prompt: 'question',
          provider: 'openai',
          thinking: 'high',
          schema: z.object({ answer: z.string() }),
        });
      },
    });
    const options = {
      stateDir,
      runId: 'kit',
      cwd: binary.directory,
      input: null,
      harnessConfigurations: {
        'third-agent': { binary: 'third-agent', path: binary.env['PATH'] ?? '' },
      },
    };
    const first = await runWorkflow(workflow, options);
    expect(first.output).toEqual({ answer: 'question:openai:high:scrubbed' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      harness: 'third-agent',
      revision: 7,
      runId: 'kit',
      stepId: 'answer',
      attempt: 1,
    });
    expect((await readRun(options)).steps['answer']).toMatchObject({
      kind: 'agent',
      harness: 'third-agent',
      revision: 7,
      attemptHistory: [{ status: 'completed', sessionId: 'third-session-1' }],
    });
    await runWorkflow(workflow, { ...options, resume: true, acceptCodeChange: true });
    expect(seen).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    await binary.dispose();
    await rm(stateDir, { recursive: true, force: true });
  }
});

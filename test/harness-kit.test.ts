import { expect, it, vi } from 'vitest';
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
} from '../src/harness-kit.js';

for (const harness of ['claude', 'codex'] as const)
  it(`${harness} passes the public adapter conformance suite with fake binaries`, async () => {
    await assertHarnessConformance({
      text: 'hello',
      failureReason: 'fake native failure',
      structured: { ok: true },
      async fixture(scenario) {
        const text = scenario === 'structured' ? '{"ok":true}' : 'hello';
        const failure = scenario === 'protocol-error' || scenario === 'nonzero-stdout';
        const events =
          harness === 'claude'
            ? [
                {
                  type: 'result',
                  subtype: failure ? 'error_during_execution' : 'success',
                  is_error: failure,
                  result: failure ? 'fake native failure' : text,
                  ...(scenario === 'structured' ? { structured_output: { ok: true } } : {}),
                  session_id: 'fake-session',
                },
              ]
            : [
                { type: 'thread.started', thread_id: 'fake-thread' },
                ...(failure
                  ? [{ type: 'turn.failed', error: { message: 'fake native failure' } }]
                  : [
                      { type: 'item.completed', item: { type: 'agent_message', text } },
                      { type: 'turn.completed' },
                    ]),
              ];
        const binary = await createFakeBinary(
          `fake-${harness}`,
          `
        for await (const _ of process.stdin) {}
        ${scenario === 'abort' ? 'setInterval(() => {}, 1000);' : `process.stdout.write(${JSON.stringify(events.map((value) => JSON.stringify(value)).join('\n') + '\n')}); process.exitCode = ${String(scenario === 'nonzero-stdout' ? 1 : 0)};`}
      `,
        );
        const call = {
          runId: 'conformance',
          stepId: scenario,
          attempt: 1,
          idempotencyKey: `conformance/${scenario}`,
        };
        return {
          adapter:
            harness === 'claude'
              ? new ClaudeAdapter({ binary: binary.path, killGraceMs: 25 })
              : new CodexAdapter({ binary: binary.path, killGraceMs: 25 }),
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
          dispose: () => binary.dispose(),
        };
      },
    });
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

import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWorkflow, readRun, runWorkflow } from '../src/index.js';
import { ClaudeAdapter, CodexAdapter } from '../src/harnesses/builtins/adapters.js';
import {
  assertHarnessConformance,
  createFakeBinary,
  runProcess,
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
  const binary = await createFakeBinary(
    'third-agent',
    `
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({answer: request.prompt + ':' + request.provider + ':' + request.thinking}));
  `,
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-kit-run-'));
  const seen: AgentRequest[] = [];
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
        const parsed = z.object({ binary: z.string() }).parse(config);
        return {
          async invoke(request, signal, invocation) {
            seen.push(request);
            const result = await runProcess({
              binary: parsed.binary,
              env: binary.env,
              args: [],
              cwd: request.cwd,
              input: JSON.stringify(request.options),
              signal,
              timeoutMs: invocation?.policy?.timeoutMs ?? 1000,
              maxOutputBytes: 10000,
              killGraceMs: 25,
              ...(invocation === undefined
                ? {}
                : { trackProcess: invocation.trackProcess.bind(invocation) }),
            });
            if (result.code !== 0)
              throw new Error(`third-agent failed: ${result.stdout} ${result.stderr}`);
            return { text: result.stdout, sessionId: null };
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
      harnessConfigurations: { 'third-agent': { binary: 'third-agent' } },
    };
    const first = await runWorkflow(workflow, options);
    expect(first.output).toEqual({ answer: 'question:openai:high' });
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
      attemptHistory: [{ status: 'completed' }],
    });
    await runWorkflow(workflow, { ...options, resume: true, acceptCodeChange: true });
    expect(seen).toHaveLength(1);
  } finally {
    await binary.dispose();
    await rm(stateDir, { recursive: true, force: true });
  }
});

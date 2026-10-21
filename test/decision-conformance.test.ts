// Conformance of jevCompatible against a loopback protocol host (ADR 0066 section 5), run through
// runWorkflow. The bearer token is a dummy variable this file sets; no test needs credentials.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWorkflow, readRun, runWorkflow, z, type RunOptions } from '../src/index.js';
import {
  choice,
  jevCompatible,
  noul,
  score,
  type JevCompatibleOptions,
} from '../src/integrations/decision.js';
import { startFakeDecisionServer, type FakeDecisionServer } from './decision-fake-server.js';

const TOKEN = 'dummy-decision-token-0123456789';
const TOKEN_ENV = 'QC_TEST_DECISION_TOKEN';

let server: FakeDecisionServer;
let stateDir: string;
beforeEach(async () => {
  vi.stubEnv(TOKEN_ENV, TOKEN);
  server = await startFakeDecisionServer(TOKEN);
  stateDir = await mkdtemp(join(tmpdir(), 'choir-decision-conformance-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
  await rm(stateDir, { recursive: true, force: true });
});

const questions = {
  team: choice({
    instructions: 'Which team owns this?',
    options: { billing: 'Payments and invoices', infra: null },
  }),
  urgency: score({ instructions: 'How urgent?', levels: ['none', 'this week', 'now'] }),
  refund: noul({ instructions: 'Does the customer ask for a refund?' }),
};
const answers = {
  team: {
    type: 'choice',
    choice: 'billing',
    confidence: 0.8,
    probabilities: { billing: 0.9, infra: 0.1 },
  },
  urgency: {
    type: 'score',
    score: 1.2,
    confidence: 0.55,
    legend: { '0': 'none', '1': 'this week', '2': 'now' },
    probabilities: { '0': 0.2, '1': 0.4, '2': 0.4 },
  },
  refund: { type: 'noul', noul: 0.25 },
};
const success = {
  status: 200,
  body: {
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 120, output_tokens: 12 },
  },
};

function workflow(
  provider: Partial<JevCompatibleOptions> = {},
  call: { readonly retry?: { maxAttempts: number; on?: ['transient'] }; timeoutMs?: number } = {},
) {
  return defineWorkflow({
    name: 'conformance',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    decisions: [
      jevCompatible({
        name: 'jev',
        baseUrl: server.url,
        apiKeyEnv: TOKEN_ENV,
        defaultModel: 'jev-latest',
        ...provider,
      }),
    ],
    run: (ctx) => ctx.decide('triage', { state: { ticket: 'charged twice' }, questions, ...call }),
  });
}
const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'conformance',
  stateDir,
  input: null,
  ...overrides,
});
async function failedAttempts() {
  const run = await readRun({ stateDir, runId: 'conformance' });
  return run.steps['triage']?.attemptHistory ?? [];
}

describe('jevCompatible', () => {
  it('sends the protocol request and records validated answers', async () => {
    server.script(success);
    const result = await runWorkflow(workflow(), options());
    expect(result.output).toEqual({
      team: { choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, infra: 0.1 } },
      urgency: {
        score: 1.2,
        confidence: 0.55,
        legend: ['none', 'this week', 'now'],
        probabilities: [0.2, 0.4, 0.4],
      },
      refund: { noul: 0.25 },
    });
    expect(server.count).toBe(1);
    const [request] = server.requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/systemone');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers['idempotency-key']).toBeUndefined();
    expect(request?.body).toEqual({
      model: 'jev-latest',
      state: { ticket: 'charged twice' },
      questions: {
        team: {
          type: 'choice',
          instructions: 'Which team owns this?',
          criteria: { billing: 'Payments and invoices', infra: null },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent?',
          criteria: ['none', 'this week', 'now'],
        },
        refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' },
      },
    });
    expect(result.steps['triage']).toMatchObject({
      kind: 'step',
      meta: { integration: 'decision', op: 'decide', provider: 'jev', model: 'jev-latest' },
      output: { model: 'jev-1.13.0' },
      attemptHistory: [
        {
          integration: 'decision',
          usage: {
            inputTokens: 120,
            outputTokens: 12,
            costUsd: null,
            provider: 'jev',
            model: { requested: 'jev-latest', effective: ['jev-1.13.0'] },
            reported: { input_tokens: 120, output_tokens: 12 },
          },
        },
      ],
    });
  });

  it('sends the idempotency key only when the provider declares it', async () => {
    server.script(success);
    await runWorkflow(workflow({ capabilities: { idempotencyKey: true } }), options());
    expect(server.requests[0]?.headers['idempotency-key']).toBe('conformance/triage');
  });

  it('accepts a base URL with a trailing slash and a custom path', async () => {
    server.script(success);
    await runWorkflow(workflow({ baseUrl: `${server.url}/`, path: '/v2/decide' }), options());
    expect(server.requests[0]?.path).toBe('/v2/decide');
  });

  const invalid: [string, (body: typeof answers) => unknown][] = [
    [
      'a choice outside the options',
      (body) => ({ ...body, team: { ...body.team, choice: 'legal' } }),
    ],
    [
      'probabilities off by more than 1e-6',
      (body) => ({
        ...body,
        team: { ...body.team, probabilities: { billing: 0.9, infra: 0.1001 } },
      }),
    ],
    [
      'a legend that differs from the levels',
      (body) => ({
        ...body,
        urgency: { ...body.urgency, legend: { '0': 'none', '1': 'soon', '2': 'now' } },
      }),
    ],
    ['a missing answer', ({ team, urgency }) => ({ team, urgency })],
    ['an extra answer', (body) => ({ ...body, extra: { type: 'noul', noul: 0.5 } })],
    ['an answer of another kind', (body) => ({ ...body, refund: { type: 'choice', noul: 0.5 } })],
  ];
  it.each(invalid)('fails %s as schema and keeps the raw body', async (_name, change) => {
    const body = { model: 'jev-1.13.0', answers: change(answers) };
    server.script({ status: 200, body });
    await expect(runWorkflow(workflow(), options())).rejects.toThrow(/failed validation/u);
    const [attempt] = await failedAttempts();
    expect(attempt).toMatchObject({ status: 'failed', errorKind: 'schema' });
    expect(JSON.parse(attempt?.response ?? 'null')).toEqual(body);
    expect(attempt?.responseTruncated).toBe(false);
    expect(attempt?.validationIssues?.length).toBeGreaterThan(0);
  });

  it('fails a non-JSON success body as schema', async () => {
    server.script({ status: 200, text: 'not json' });
    await expect(runWorkflow(workflow(), options())).rejects.toThrow(/not JSON/u);
    const [attempt] = await failedAttempts();
    expect(attempt).toMatchObject({ errorKind: 'schema', response: 'not json' });
  });

  it('classifies 429 as rate-limit and succeeds under a transient retry', async () => {
    server.script({ status: 429, body: { detail: 'slow down' } }, success);
    const result = await runWorkflow(
      workflow({}, { retry: { maxAttempts: 2, on: ['transient'] } }),
      options(),
    );
    expect(server.count).toBe(2);
    expect(result.steps['triage']?.attemptHistory?.map((attempt) => attempt.errorKind)).toEqual([
      'rate-limit',
      undefined,
    ]);
    expect(result.steps['triage']?.attemptHistory?.[0]?.response).toBe('{"detail":"slow down"}');
  });

  it.each([
    [500, 'overloaded'],
    [503, 'overloaded'],
    [401, 'authentication'],
    [403, 'permission'],
    [422, 'invalid-request'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    server.script({ status, body: { detail: 'no' } });
    await expect(runWorkflow(workflow(), options())).rejects.toThrow(
      new RegExp(`HTTP ${String(status)}`, 'u'),
    );
    const [attempt] = await failedAttempts();
    expect(attempt?.errorKind).toBe(kind);
  });

  it('sends the token the server checks and fails a wrong one as authentication', async () => {
    vi.stubEnv(TOKEN_ENV, 'wrong-token');
    await expect(runWorkflow(workflow(), options())).rejects.toThrow(/HTTP 401/u);
    expect((await failedAttempts())[0]?.errorKind).toBe('authentication');
  });

  it('fails a request that outlives timeoutMs with kind timeout', async () => {
    server.script({ hold: true });
    await expect(runWorkflow(workflow({}, { timeoutMs: 100 }), options())).rejects.toThrow(
      /timed out after 100ms/u,
    );
    expect((await failedAttempts())[0]).toMatchObject({ status: 'failed', errorKind: 'timeout' });
    await server.disconnected;
  });

  it('cancels a held request when the run signal aborts and closes the connection', async () => {
    server.script({ hold: true });
    const controller = new AbortController();
    const running = runWorkflow(workflow(), options({ signal: controller.signal }));
    await server.held;
    controller.abort();
    await expect(running).rejects.toThrow();
    await server.disconnected;
    const run = await readRun({ stateDir, runId: 'conformance' });
    expect(run.steps['triage']?.status).toBe('cancelled');
    expect(run.steps['triage']?.attemptHistory?.[0]?.status).toBe('cancelled');
  });
});

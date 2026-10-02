import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliHarness,
  FixtureHarness,
  parseHarnessFixtures,
  synthesizeOutput,
  defineWorkflow,
  readRun,
  runWorkflow,
  WorkflowRunError,
  z,
  type Harness,
  type HarnessRequest,
  type BuiltinHarnessRequestInput as HarnessRequestInput,
  type WorkflowContext,
  type CodexOptions,
} from '../src/index.js';
import { RehearsalHarness, rehearsalState } from '../src/workflow/loader/rehearsal.js';
import { fixturesFromRun } from '../src/workflow/loader/fixtures.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import { materializeInvocation } from '../src/harnesses/invocation.js';
import { testInvocation } from './harness-invocation.js';

const roots: string[] = [];
async function setup() {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'choir-rehearsal-')));
  roots.push(stateDir);
  return { stateDir, runId: 'rehearsal', input: null };
}
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function workflow(run: (ctx: WorkflowContext) => Promise<string>) {
  return defineWorkflow({
    name: 'rehearsal',
    version: '1',
    input: z.null(),
    output: z.string(),
    run,
  });
}
function request(stepId = 'one', provider: 'claude' | 'codex' = 'claude'): HarnessRequest {
  return {
    harness: provider,
    revision: 1,
    runId: 'fixture',
    stepId,
    attempt: 1,
    idempotencyKey: `fixture/${stepId}`,
    cwd: process.cwd(),
    options: { prompt: 'prompt' },
    outputSchema: null,
    call: { runId: 'fixture', stepId, attempt: 1, idempotencyKey: `fixture/${stepId}` },
  };
}
const response = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
const json = (schema: z.ZodType) =>
  JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))) as Parameters<
    typeof synthesizeOutput
  >[0];

describe('durable harness call identity', () => {
  it('attaches full identity to metadata and live attempts, keeping keys stable on resume', async () => {
    const options = await setup();
    const requests: HarnessRequest[] = [];
    const harness: Harness = {
      metadata: vi.fn((input: HarnessRequest) => {
        requests.push(input);
        return Promise.resolve({ binary: 'fake', version: '1' });
      }),
      invoke: vi.fn((input: HarnessRequest) => {
        requests.push(input);
        return input.call.attempt === 1
          ? Promise.reject(new Error('retry later'))
          : Promise.resolve(response);
      }),
    };
    const definition = workflow(
      async (ctx) =>
        (await ctx.within('scope').codex.text('call', { prompt: 'same prompt' })).output,
    );
    await expect(runWorkflow(definition, { ...options, harness })).rejects.toThrow('retry later');
    const before = await readRun(options);
    const after = await runWorkflow(definition, { ...options, harness, resume: true });
    expect(requests.map((entry) => entry.call)).toEqual(
      [1, 1, 2, 2].map((attempt) => ({
        runId: 'rehearsal',
        stepId: 'scope/call',
        attempt,
        idempotencyKey: 'rehearsal/scope/call',
      })),
    );
    expect(after.steps['scope/call']?.fingerprint).toBe(before.steps['scope/call']?.fingerprint);
    expect(after.steps['scope/call']?.identity).not.toHaveProperty('call');
  });

  it.each([false, true])(
    'refuses unpinned isolation in a captured pre-metadata format-6 checkpoint (value=%s)',
    async (direct) => {
      const options = {
        ...(await setup()),
        runId: 'legacy',
        cwd: '/',
        fingerprint: 'rehearsal-compatibility',
        resume: true,
      };
      await writeFile(
        join(options.stateDir, 'legacy.json'),
        await readFile(
          new URL('./fixtures/harness/pre-rehearsal-checkpoint.json', import.meta.url),
        ),
      );
      const invoke = vi.fn((input: HarnessRequest) => {
        expect(input.call).toEqual({
          runId: 'legacy',
          stepId: 'second',
          attempt: 2,
          idempotencyKey: 'legacy/second',
        });
        return Promise.resolve(response);
      });
      const definition = defineWorkflow({
        name: 'pre-rehearsal',
        version: '1',
        input: z.null(),
        output: z.string(),
        async run(ctx) {
          const first = direct
            ? await ctx.claude.value('first', { prompt: 'first' })
            : (await ctx.claude.text('first', { prompt: 'first' })).output;
          const second = direct
            ? await ctx.codex.value('second', { prompt: 'second' })
            : (await ctx.codex.text('second', { prompt: 'second' })).output;
          return first + second;
        },
      });
      const before = await readRun(options);
      await expect(runWorkflow(definition, { ...options, harness: { invoke } })).rejects.toThrow(
        'option.isolation changed',
      );
      expect(invoke).not.toHaveBeenCalled();
      const after = await readRun(options);
      expect(after.steps['first']?.fingerprint).toBe(before.steps['first']?.fingerprint);
      expect(after.steps['second']?.fingerprint).toBe(before.steps['second']?.fingerprint);
    },
  );
});

describe('fixture routing and export', () => {
  it('uses ordered glob/provider/attempt routing and keeps normal validation', async () => {
    const harness = new FixtureHarness({
      version: 1,
      calls: [
        { step: 'review/*', harness: 'codex', attempt: 1, error: 'simulated' },
        { step: 'review/**', harness: 'codex', output: { answer: 2 }, usage: { costUsd: 0.01 } },
        { step: '**', text: 'fallback' },
      ],
    });
    await expect(harness.invoke(request('review/a', 'codex'), testInvocation())).rejects.toThrow(
      'Step review/a: simulated',
    );
    const second = {
      ...request('review/a', 'codex'),
      call: { ...request().call, stepId: 'review/a', attempt: 2 },
    };
    await expect(harness.invoke(second, testInvocation())).resolves.toMatchObject({
      text: '{"answer":2}',
      usage: { costUsd: 0.01 },
    });
    await expect(
      harness.invoke(request('review/a/b', 'codex'), testInvocation()),
    ).resolves.toMatchObject({ text: '{"answer":2}' });
    await expect(
      harness.invoke(request('review/a', 'claude'), testInvocation()),
    ).resolves.toMatchObject({ text: 'fallback' });
    const options = await setup();
    await expect(
      runWorkflow(
        workflow(
          async (ctx) =>
            (
              await ctx.codex.object('review/a/b', {
                prompt: 'x',
                schema: z.object({ answer: z.string() }),
              })
            ).output.answer,
        ),
        { ...options, harness },
      ),
    ).rejects.toMatchObject({ stepId: 'review/a/b' });
    expect((await readRun(options)).steps['review/a/b']?.status).toBe('failed');
  });
  it('names unmatched calls, rejects ambiguous rules, honors null outputs, and cancels without matching', async () => {
    expect(() =>
      parseHarnessFixtures({ version: 1, calls: [{ step: 'x', output: {}, text: 'oops' }] }),
    ).toThrow('Exactly one');
    expect(() =>
      parseHarnessFixtures({ version: 1, calls: [{ step: 'x[', output: {} }] }),
    ).toThrow();
    expect(() =>
      parseHarnessFixtures({ version: 1, calls: [{ step: 'x', output: undefined }] }),
    ).toThrow('Exactly one');
    const harness = new FixtureHarness({ version: 1, calls: [{ step: 'nil', output: null }] });
    await expect(harness.invoke(request('unknown'), testInvocation())).rejects.toThrow(
      'step unknown (claude, attempt 1)',
    );
    await expect(harness.invoke(request('nil'), testInvocation())).resolves.toMatchObject({
      text: 'null',
    });
    expect(() =>
      harness.invoke(request('unknown'), testInvocation(AbortSignal.abort(new Error('stop')))),
    ).toThrow('stop');
  });
  it('exports all successful agent outputs, preserving text and structured strings on replay', async () => {
    const options = await setup();
    const definition = workflow(async (ctx) => {
      const text = await ctx.claude.text('text', { prompt: 'x' });
      const value = await ctx.codex.object('value', { prompt: 'x', schema: z.string() });
      await ctx.step('local', { input: null, schema: z.number(), run: () => 3 });
      return text.output + value.output;
    });
    const harness = new FixtureHarness({
      version: 1,
      calls: [
        { step: 'text', text: 'plain' },
        { step: 'value', output: 'structured' },
      ],
    });
    const first = await runWorkflow(definition, { ...options, harness });
    const fixtures = fixturesFromRun(first);
    expect(fixtures.calls.map((entry) => entry.step)).toEqual(['text', 'value']);
    const second = await runWorkflow(definition, {
      ...options,
      runId: 'export',
      harness: new FixtureHarness(fixtures),
    });
    expect(second.output).toBe('plainstructured');
    expect(() => fixturesFromRun({ ...first, status: 'failed' })).toThrow('completed run');
  });
  it('exports settled agent failures as error rules in execution order and replays them as settled failures', async () => {
    const options = await setup();
    const definition = workflow(async (ctx) => {
      const first = await ctx.claude.text('first', { prompt: 'x' });
      const broken = await ctx.codex.text('broken', { prompt: 'x', onError: 'return' });
      const last = await ctx.claude.text('last', { prompt: 'x' });
      return `${first.output}|${broken.ok ? broken.value.output : broken.error.message}|${last.output}`;
    });
    const source = await runWorkflow(definition, {
      ...options,
      harness: new FixtureHarness({
        version: 1,
        calls: [
          { step: 'first', text: 'one' },
          { step: 'broken', error: 'boom' },
          { step: 'last', text: 'three' },
        ],
      }),
    });
    expect(source.status).toBe('completed');
    expect(source.steps['broken']?.status).toBe('settled-failed');
    const fixtures = fixturesFromRun(source);
    expect(fixtures.calls).toEqual([
      expect.objectContaining({ step: 'first', harness: 'claude', output: 'one' }),
      { step: 'broken', harness: 'codex', error: 'boom' },
      expect.objectContaining({ step: 'last', harness: 'claude', output: 'three' }),
    ]);
    const replay = await runWorkflow(definition, {
      ...options,
      runId: 'replay',
      harness: new FixtureHarness(fixtures),
    });
    expect(replay.status).toBe('completed');
    expect(replay.steps['broken']?.status).toBe('settled-failed');
    expect(replay.steps['broken']?.settledError?.message).toBe(
      source.steps['broken']?.settledError?.message,
    );
    expect(replay.output).toBe(source.output);
    expect(fixturesFromRun(replay)).toEqual(fixtures);
  });
  it('exports an unprefixed settled message verbatim and never an empty error', async () => {
    const options = await setup();
    const definition = workflow(async (ctx) => {
      const broken = await ctx.claude.text('broken', { prompt: 'x', onError: 'return' });
      return broken.ok ? broken.value.output : broken.error.message;
    });
    const source = await runWorkflow(definition, {
      ...options,
      harness: new FixtureHarness({ version: 1, calls: [{ step: 'broken', error: 'boom' }] }),
    });
    const settled = source.steps['broken'];
    if (settled?.settledError === undefined) throw new Error('expected a settled failure');
    const withMessage = (message: string | undefined, kind = settled.settledError?.kind) =>
      fixturesFromRun({
        ...source,
        steps: {
          broken: {
            ...settled,
            settledError:
              message === undefined ? undefined : { ...settled.settledError, kind, message },
          },
        },
      } as typeof source);
    expect(withMessage('rate limited').calls).toEqual([
      { step: 'broken', harness: 'claude', error: 'rate limited' },
    ]);
    expect(withMessage('Step other: x').calls[0]).toMatchObject({ error: 'Step other: x' });
    expect(withMessage('', 'schema').calls[0]).toMatchObject({ error: 'Settled schema failure' });
    expect(withMessage('Step broken: ', 'schema').calls[0]).toMatchObject({
      error: 'Settled schema failure',
    });
    expect(withMessage(undefined).calls[0]).toMatchObject({ error: 'Settled unknown failure' });
    expect(() => parseHarnessFixtures(withMessage(''))).not.toThrow();
  });
  it('validates inline and @file config, resolves relative executables, and defers module loading', async () => {
    const { stateDir } = await setup();
    const config = { claudeBinary: './fake/claude', maxOutputBytes: 33554432 };
    await writeFile(join(stateDir, 'config.json'), JSON.stringify(config));
    const a = await readHarnessSelection('cli', JSON.stringify(config), stateDir);
    expect(await readHarnessSelection('cli', '@config.json', stateDir)).toEqual(a);
    expect(a.config).toEqual({ ...config, claudeBinary: join(stateDir, 'fake/claude') });
    expect(
      (await readHarnessSelection('cli', '{"killGraceMs":42}', stateDir, 10)).config.killGraceMs,
    ).toBe(10);
    await writeFile(join(stateDir, 'fixture.json'), '{"version":1,"calls":[]}');
    expect((await readHarnessSelection('fixture:fixture.json', undefined, stateDir)).kind).toBe(
      'fixture',
    );
    await expect(readHarnessSelection('cli', '{"unknown":1}', stateDir)).rejects.toThrow();
    await expect(readHarnessSelection('cli', '{"killGraceMs":0}', stateDir)).rejects.toThrow();
    await expect(
      readHarnessSelection('module:./never-import.ts', undefined, stateDir),
    ).rejects.toThrow('defineWorkflow({ harnesses })');
    await expect(readHarnessSelection('fixture:', undefined, stateDir)).rejects.toThrow(
      '--harness',
    );
  });
});

describe('rehearsal configuration failures', () => {
  const answer = z.object({ answer: z.string() });
  const settling = workflow(async (ctx) => {
    const result = await ctx.claude.object('ask', {
      prompt: 'x',
      schema: answer,
      onError: 'return',
    });
    return result.ok ? result.value.output.answer : `settled: ${result.error.message}`;
  });

  it('rejects an unmatched fixture without settling it, so a corrected resume completes', async () => {
    const options = await setup();
    const missing = new FixtureHarness({ version: 1, calls: [] });
    await expect(runWorkflow(settling, { ...options, harness: missing })).rejects.toThrow(
      'No fixture matches step ask (claude, attempt 1).',
    );
    const step = (await readRun(options)).steps['ask'];
    expect(step?.status).toBe('failed');
    expect(step?.settledError).toBeUndefined();
    const fixed = new FixtureHarness({
      version: 1,
      calls: [{ step: 'ask', output: { answer: 'ok' } }],
    });
    const result = await runWorkflow(settling, { ...options, harness: fixed, resume: true });
    expect(result.output).toBe('ok');
    expect(result.steps['ask']?.status).toBe('completed');
  });

  it('rejects an unsatisfiable dry-run synthesis with its step and pointer instead of settling', async () => {
    const options = await setup();
    const harness = new RehearsalHarness({ kind: 'cli', config: {} });
    const definition = workflow(async (ctx) => {
      const result = await ctx.claude.object('code', {
        prompt: 'x',
        schema: z.object({ code: z.string().regex(/^[0-9]+$/u) }),
        onError: 'return',
      });
      return result.ok ? result.value.output.code : 'settled';
    });
    await expect(
      runWorkflow(definition, { ...options, harness, rehearsal: harness.hooks }),
    ).rejects.toThrow('Step code at JSON pointer "/code"');
    const step = (await readRun(options)).steps['code'];
    expect(step?.status).toBe('failed');
    expect(step?.settledError).toBeUndefined();
  });

  it('still settles a declared error fixture as an invocation failure', async () => {
    const options = await setup();
    const harness = new FixtureHarness({
      version: 1,
      calls: [{ step: 'ask', error: 'simulated' }],
    });
    const result = await runWorkflow(settling, { ...options, harness });
    expect(result.output).toContain('settled: ');
    expect(result.output).toContain('Step ask: simulated');
    expect(result.steps['ask']?.status).toBe('settled-failed');
  });
});

describe('typed fixture error kinds', () => {
  const retried = (on: readonly ('timeout' | 'rate-limit')[]) =>
    workflow(
      async (ctx) =>
        (await ctx.claude.text('x', { prompt: 'p', retry: { maxAttempts: 2, delayMs: 1, on } }))
          .output,
    );

  it('retries a timeout error rule under retry.on timeout and records its kind', async () => {
    const options = await setup();
    const harness = new FixtureHarness({
      version: 1,
      calls: [
        { step: 'x', attempt: 1, error: 'slow', kind: 'timeout' },
        { step: 'x', text: 'ok' },
      ],
    });
    const result = await runWorkflow(retried(['timeout']), { ...options, harness });
    expect(result.output).toBe('ok');
    expect(result.steps['x']?.attemptHistory?.[0]).toMatchObject({
      errorKind: 'timeout',
      error: 'Step x: slow',
    });
  });

  it('settles a kinded error rule with its kind and the unchanged message', async () => {
    const options = await setup();
    const harness = new FixtureHarness({
      version: 1,
      calls: [{ step: 'x', error: 'slow', kind: 'timeout' }],
    });
    const result = await runWorkflow(
      workflow(async (ctx) => {
        const settled = await ctx.claude.text('x', { prompt: 'p', onError: 'return' });
        return settled.ok ? settled.value.output : `${settled.error.kind}|${settled.error.message}`;
      }),
      { ...options, harness },
    );
    expect(result.output).toBe('timeout|Step x: slow');
    expect(result.steps['x']?.settledError).toMatchObject({
      kind: 'timeout',
      message: 'Step x: slow',
    });
    expect(fixturesFromRun(result).calls).toEqual([
      { step: 'x', harness: 'claude', error: 'slow' },
    ]);
  });

  it('does not retry a kind that retry.on leaves out', async () => {
    const options = await setup();
    const harness = new FixtureHarness({
      version: 1,
      calls: [
        { step: 'x', attempt: 1, error: 'slow', kind: 'timeout' },
        { step: 'x', text: 'ok' },
      ],
    });
    await expect(runWorkflow(retried(['rate-limit']), { ...options, harness })).rejects.toThrow(
      'Step x: slow',
    );
    const step = (await readRun(options)).steps['x'];
    expect(step?.attempts).toBe(1);
    expect(step?.attemptHistory?.[0]?.errorKind).toBe('timeout');
  });

  it('rejects a kind without an error and an unknown kind', () => {
    expect(() =>
      parseHarnessFixtures({ version: 1, calls: [{ step: 'x', text: 'ok', kind: 'timeout' }] }),
    ).toThrow('kind requires error');
    expect(() =>
      parseHarnessFixtures({ version: 1, calls: [{ step: 'x', error: 'e', kind: 'slow' }] }),
    ).toThrow();
  });
});

describe('deterministic synthesis', () => {
  it('fills enums, minimums, nullable values, escaped pointers, bounded arrays, and tuples', () => {
    const schema = z.object({
      flag: z.boolean(),
      number: z.number().min(-3),
      integer: z.number().int().gt(2),
      values: z.array(z.enum(['first', 'second'])).min(2),
      nullable: z.string().nullable(),
      'a/b~c': z.string(),
      tuple: z.tuple([z.string(), z.number()]),
    });
    const result = synthesizeOutput(json(schema), 'sample');
    expect(result).toEqual({
      flag: false,
      number: -3,
      integer: 3,
      values: ['first', 'first'],
      nullable: 'dry-run:sample/nullable',
      'a/b~c': 'dry-run:sample/a~1b~0c',
      tuple: ['dry-run:sample/tuple/0', 0],
    });
    expect(schema.parse(result)).toEqual(result);
    expect(synthesizeOutput({ type: 'number', maximum: -10 }, 'x')).toBe(-10);
    expect(synthesizeOutput({ type: 'integer', exclusiveMinimum: 2.5 }, 'x')).toBe(3);
    expect(synthesizeOutput({ type: 'number', exclusiveMaximum: -1 }, 'x')).toBeLessThan(-1);
    expect(synthesizeOutput({ type: 'number', minimum: 2, multipleOf: 3 }, 'x')).toBe(3);
    expect(synthesizeOutput({ type: 'string', minLength: 30 }, 'x')).toHaveLength(30);
    expect(synthesizeOutput({ type: 'string', maxLength: 2 }, 'x')).toBe('dr');
    expect(
      synthesizeOutput(
        { type: 'object', minProperties: 1, additionalProperties: { type: 'number' } },
        'x',
      ),
    ).toEqual({ 'dry-run-key-0': 0 });
    expect(synthesizeOutput({ type: ['null', 'string'] }, 'x')).toBe('dry-run:x');
  });
  it('resolves references and intersections and safely creates unusual property names', () => {
    expect(
      synthesizeOutput(
        {
          type: 'object',
          properties: { ref: { $ref: '#/definitions/item' } },
          definitions: { item: { const: 'fixed' } },
        },
        'x',
      ),
    ).toEqual({ ref: 'fixed' });
    expect(
      synthesizeOutput(
        {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'number' } } },
          ],
        },
        'x',
      ),
    ).toEqual({ a: 'dry-run:x/a', b: 0 });
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Parameters<typeof synthesizeOutput>[0];
    expect(Object.hasOwn(synthesizeOutput(schema, 'x') as object, '__proto__')).toBe(true);
    expect(synthesizeOutput(true, 'x')).toBe('dry-run:x');
  });
  it.each([z.string().regex(/^ok$/u), z.email(), z.string().regex(/^ok$/u).nullable()])(
    'requires a fixture for unsatisfied pattern/format at its exact pointer',
    (value) => {
      expect(() => synthesizeOutput(json(z.object({ nested: z.array(value) })), 'call')).toThrow(
        /Step call at JSON pointer "\/nested\/0".*fixture/su,
      );
    },
  );
  it.each([
    false,
    { enum: [] },
    { $ref: 'https://invalid.example/schema' },
    { $ref: '#/missing' },
    { $ref: '#' },
    { type: 'array', minItems: 1001 },
    { type: 'object', minProperties: 1001 },
    { type: 'string', minLength: 100001 },
    { type: 'array', maxItems: 0 },
  ])('fails boundedly with fixture guidance for %j', (schema) => {
    expect(() => synthesizeOutput(schema, 'bounded')).toThrow(/Step bounded.*fixture/su);
  });
});

describe('rehearsal execution and isolation', () => {
  it('rehearses mixed mapped providers and sleeps without metadata/invoke spawns, and stubs selected locals', async () => {
    const options = await setup();
    const invoke = vi
      .spyOn(CliHarness.prototype, 'invoke')
      .mockRejectedValue(new Error('must not invoke'));
    const metadata = vi
      .spyOn(CliHarness.prototype, 'metadata')
      .mockRejectedValue(new Error('must not probe'));
    const spawn = vi.spyOn(childProcess, 'spawn');
    const exec = vi.spyOn(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    const local = vi.fn(() => 'read local');
    const publish = vi.fn(() => 'must not publish');
    const harness = new RehearsalHarness(
      { kind: 'cli', config: { claudeBinary: '/does-not-exist', codexBinary: '/does-not-exist' } },
      ['publish/**'],
    );
    const definition = workflow(async (ctx) => {
      await ctx.step('read', { input: null, schema: z.string(), run: local });
      const items = (
        await ctx.claude.object('items', {
          prompt: 'list',
          schema: z.object({ values: z.array(z.string()) }),
        })
      ).output.values;
      await ctx.map('review', items, { concurrency: 2 }, (value) =>
        ctx.codex.text('ask', { prompt: value }),
      );
      await ctx.sleep('pause', 3_600_000);
      return ctx.step('publish/report', { input: null, schema: z.string(), run: publish });
    });
    const run = await runWorkflow(definition, {
      ...options,
      harness,
      rehearsal: harness.hooks,
      onEvent: (event) => {
        harness.observe(event);
      },
    });
    expect(run.output).toBe('dry-run:publish/report');
    expect(local).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    const report = harness.report(run);
    expect(report).toMatchObject({
      providerCounts: { claude: 1, codex: 1 },
      nominalClaudeCeilingUsd: 0.5,
      stubbedSteps: ['publish/report'],
      skippedSleeps: ['pause'],
    });
    expect(report.calls[1]?.prompt).toBe('dry-run:items/values/0');
    expect(report.calls[1]?.stepId).toBe('review/0/ask');
    expect(report.warnings.join(' ')).toContain('default/profile limits');
  });

  it.each([
    {
      name: 'date',
      id: 'late',
      run: (ctx: WorkflowContext) =>
        ctx.claude.object('late', { prompt: 'x', schema: z.object({ date: z.date() }) }),
      message: 'Date cannot',
    },
    {
      name: 'transform',
      id: 'late',
      run: (ctx: WorkflowContext) =>
        ctx.codex.object('late', {
          prompt: 'x',
          schema: z.string().transform((value) => value.length),
        }),
      message: 'Transforms cannot',
    },
    {
      name: 'id',
      id: 'bad id',
      run: (ctx: WorkflowContext) => ctx.claude.text('bad id', { prompt: 'x' }),
      message: 'Invalid step ID',
    },
    {
      name: 'duplicate',
      id: 's/a',
      run: (ctx: WorkflowContext) => ctx.claude.text('s/a', { prompt: 'first' }),
      message: 'Duplicate step ID',
    },
    {
      name: 'undefined',
      id: 'late',
      run: (ctx: WorkflowContext) =>
        ctx.step('late', {
          input: { value: [undefined] } as unknown as null,
          schema: z.null(),
          run: () => null,
        }),
      message: 'undefined array element',
    },
    {
      name: 'class',
      id: 'late',
      run: (ctx: WorkflowContext) =>
        ctx.step('late', {
          input: new Date() as unknown as null,
          schema: z.null(),
          run: () => null,
        }),
      message: 'plain JSON objects',
    },
  ])(
    'attributes late $name errors after exactly five calls, including stack',
    async ({ run: late, id, message }) => {
      const options = await setup();
      const harness = new RehearsalHarness({ kind: 'cli', config: {} });
      const definition = workflow(async (ctx) => {
        for (const name of ['s/a', 'two', 'three', 'four', 'five'])
          await ctx.claude.text(name, { prompt: 'first' });
        await late(ctx);
        return 'unreachable';
      });
      const error: unknown = await runWorkflow(definition, {
        ...options,
        harness,
        rehearsal: harness.hooks,
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(WorkflowRunError);
      if (!(error instanceof WorkflowRunError)) throw new Error('Expected saved failure');
      expect(error.stepId).toBe(id);
      expect(error.message).toContain(message);
      expect(error.run.errorStack).toMatch(/\n\s+at /u);
      expect(harness.report(error.run).calls).toHaveLength(5);
    },
  );

  it('warns about refinements and still applies original Zod validation', async () => {
    const options = await setup();
    const harness = new RehearsalHarness({ kind: 'cli', config: {} });
    await expect(
      runWorkflow(
        workflow(
          async (ctx) =>
            (
              await ctx.claude.object('refined', {
                prompt: 'x',
                schema: z.object({
                  value: z.string().refine((value) => value === 'fixture', 'needs fixture'),
                }),
              })
            ).output.value,
        ),
        { ...options, harness, rehearsal: harness.hooks },
      ),
    ).rejects.toThrow('needs fixture');
    expect(harness.report(await readRun(options)).warnings.join(' ')).toContain(
      'custom Zod refinements',
    );
  });

  it('guards changes before the completed fast path and fork reuse, with explicit opt-in', async () => {
    const options = await setup();
    const definition = workflow(
      async (ctx) => (await ctx.claude.text('one', { prompt: 'x' })).output,
    );
    const fixture = new FixtureHarness({ version: 1, calls: [{ step: 'one', text: 'saved' }] });
    await runWorkflow(definition, { ...options, harness: fixture });
    const cli = new CliHarness({ claudeBinary: '/never-spawn' });
    const before = await readFile(join(options.stateDir, options.runId, 'run.json'), 'utf8');
    await expect(
      runWorkflow(definition, { ...options, harness: cli, resume: true }),
    ).rejects.toThrow('--allow-harness-change');
    await expect(
      runWorkflow(definition, {
        ...options,
        runId: 'fork',
        harness: cli,
        forkFrom: { runId: options.runId },
      }),
    ).rejects.toThrow('--allow-harness-change');
    expect(await readFile(join(options.stateDir, options.runId, 'run.json'), 'utf8')).toBe(before);
    expect(
      (
        await runWorkflow(definition, {
          ...options,
          harness: cli,
          resume: true,
          allowHarnessChange: true,
        })
      ).output,
    ).toBe('saved');
    expect(
      (
        await runWorkflow(definition, {
          ...options,
          runId: 'fork',
          harness: cli,
          forkFrom: { runId: options.runId },
          allowHarnessChange: true,
        })
      ).harness,
    ).toEqual({ kind: 'cli', previousKinds: ['fixture'] });
    const dry = new RehearsalHarness({ kind: 'cli', config: {} });
    await runWorkflow(definition, { ...options, runId: 'dry', harness: dry, rehearsal: dry.hooks });
    await expect(
      runWorkflow(definition, { ...options, runId: 'dry', harness: cli, resume: true }),
    ).rejects.toThrow('harness dry-run');
  });

  it('copies checkpoint bytes into ephemeral storage while leaving source locks and unfinished runs untouched', async () => {
    const options = await setup();
    const definition = workflow(async (ctx) => {
      const first = await ctx.claude.text('one', { prompt: 'first' });
      return first.output + (await ctx.codex.text('two', { prompt: 'second' })).output;
    });
    const fixture = new FixtureHarness({ version: 1, calls: [{ step: 'one', text: 'saved' }] });
    await expect(runWorkflow(definition, { ...options, harness: fixture })).rejects.toThrow(
      'step two',
    );
    await writeFile(join(options.stateDir, 'unrelated.lock'), 'do not touch');
    const before = await Promise.all(
      (await readdir(options.stateDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map(async (path) => [path, await readFile(path, 'utf8')]),
    );
    const temporary = await rehearsalState(options.runId, options.stateDir, true);
    try {
      expect(await readdir(temporary.stateDir)).toEqual([options.runId]);
      const harness = new RehearsalHarness({ kind: 'cli', config: {} });
      const run = await runWorkflow(definition, {
        ...options,
        stateDir: temporary.stateDir,
        harness,
        rehearsal: harness.hooks,
        resume: true,
        allowHarnessChange: true,
        onEvent: (event) => {
          harness.observe(event);
        },
      });
      expect(run.output).toBe('saved[dry-run codex two]');
      expect(harness.report(run)).toMatchObject({
        replays: [{ stepId: 'one', kind: 'agent' }],
        providerCounts: { claude: 0, codex: 1 },
      });
    } finally {
      await temporary.dispose();
    }
    expect(
      await Promise.all(
        (await readdir(options.stateDir, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
          .sort()
          .map(async (path) => [path, await readFile(path, 'utf8')]),
      ),
    ).toEqual(before);
    await expect(readdir(temporary.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rehearsalState('missing', options.stateDir, true)).rejects.toThrow('not found');
  });
});

describe('pure native argument planning', () => {
  it.each(['claude', 'codex'] as const)(
    'matches %s materialized argv and keeps artifact-looking user arguments untouched',
    async (provider) => {
      const input: HarnessRequestInput =
        provider === 'claude'
          ? {
              harness: provider,
              cwd: process.cwd(),
              outputSchema: json(z.object({ answer: z.string() })),
              options: {
                prompt: 'hello',
                systemPrompt: 'system',
                mcpServers: {},
                strictMcpConfig: true,
                settings: { alwaysThinkingEnabled: false },
                extraArgs: ['--test-placeholder=<quiet-choir>/system.txt'],
              },
            }
          : {
              harness: provider,
              cwd: process.cwd(),
              outputSchema: json(z.object({ answer: z.string().optional() })),
              options: {
                prompt: 'hello',
                effort: 'high',
                images: ['unread-after-snapshot'],
                extraArgs: ['--test-placeholder=<quiet-choir>/schema.json'],
              },
              imageAttachments: [
                {
                  sha256: 'f'.repeat(64),
                  base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
                },
              ],
            };
      const harness = new CliHarness({ claudeBinary: '/fake/claude', codexBinary: '/fake/codex' });
      const plan = harness.plan(input);
      expect(plan.stdin).toBe('hello');
      expect(plan.binary).toBe(`/fake/${provider}`);
      const invocation = await materializeInvocation(plan, input);
      try {
        const normalized = [...invocation.args];
        for (const artifact of plan.artifacts) {
          const value = invocation.args[artifact.argument];
          if (value === undefined) throw new Error('Missing materialized argument');
          const path = value.replace(/^--image=/u, '');
          expect((await readFile(path)).toString('base64')).toBe(artifact.base64);
          normalized[artifact.argument] = value.startsWith('--image=')
            ? `--image=${artifact.placeholder}`
            : artifact.placeholder;
        }
        expect(normalized).toEqual(plan.argv);
        expect(invocation.args).toContain(
          provider === 'claude'
            ? '--test-placeholder=<quiet-choir>/system.txt'
            : '--test-placeholder=<quiet-choir>/schema.json',
        );
      } finally {
        await invocation.dispose();
      }
    },
  );
  it('runs schema and option checks without spawning or reading image paths', () => {
    const harness = new CliHarness();
    expect(() =>
      harness.plan({
        ...request('x', 'codex'),
        harness: 'codex',
        options: { prompt: 'x', images: ['/must-not-read'] },
      }),
    ).toThrow('imageAttachments');
    expect(() =>
      harness.plan({
        ...request('x', 'codex'),
        harness: 'codex',
        options: { prompt: 'x', structuredOutput: 'strict' },
        outputSchema: json(z.object({ value: z.string().optional() })),
      }),
    ).toThrow('optional');
    expect(() => harness.plan({ ...request(), cwd: 'relative' })).toThrow('absolute path');
  });
});

it.each(['claude', 'codex'] as const)(
  'rehearsal argv equals the argv actually spawned through the shipped %s fake',
  async (provider) => {
    const { stateDir: cwd } = await setup();
    const log = join(cwd, 'calls.jsonl');
    const config = {
      claudeBinary: fileURLToPath(new URL('./bin/fake-claude.mjs', import.meta.url)),
      codexBinary: fileURLToPath(new URL('./bin/fake-codex.mjs', import.meta.url)),
    };
    const base = request('parity', provider);
    const input: HarnessRequest = {
      ...base,
      cwd,
      outputSchema: json(z.object({ answer: z.string() })),
      options: { prompt: 'parity', env: { QUIET_CHOIR_FAKE_LOG: log } },
    };
    const rehearsal = new RehearsalHarness({ kind: 'cli', config });
    const context = { ...testInvocation(), stepId: 'parity' };
    await rehearsal.invoke(input, context);
    await new CliHarness(config).invoke(input, context);
    const capture = z
      .object({
        argv: z.array(z.string()),
        cwd: z.string(),
        stdin: z.string(),
        schema: z.json(),
        stepId: z.string(),
        attempt: z.string(),
      })
      .parse(JSON.parse(await readFile(log, 'utf8')));
    const plan = rehearsal.report(null).calls[0]?.plan;
    if (!plan) throw new Error('Expected dry-run plan');
    const normalized = [...capture.argv];
    for (const artifact of plan.artifacts) normalized[artifact.argument] = artifact.placeholder;
    expect(normalized).toEqual(plan.argv);
    expect(capture).toMatchObject({ cwd, stdin: plan.stdin, stepId: 'parity', attempt: '1' });
    expect(capture.schema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    });
    if (provider === 'claude') expect(capture.schema).toEqual(input.outputSchema);
    else expect(capture.schema).not.toHaveProperty('$schema');
  },
);

it('shows a Codex private CODEX_HOME and its flag in the dry-run plan', async () => {
  const harness = new RehearsalHarness({ kind: 'cli', config: {} });
  const base = request('private-home', 'codex');
  const options: CodexOptions = { prompt: 'prompt', instructions: 'none' };
  await harness.invoke({ ...base, options }, { ...testInvocation(), stepId: 'private-home' });
  const plan = harness.report(null).calls[0]?.plan;
  expect(plan?.codexHome).toBe('private');
  const flag = plan?.argv.indexOf('project_doc_max_bytes=0') ?? -1;
  expect(plan?.argv[flag - 1]).toBe('--config');
});

it('reports failed planning without claiming a payable call', async () => {
  const harness = new RehearsalHarness({ kind: 'cli', config: {} });
  await expect(
    harness.invoke(
      { ...request('invalid-root'), outputSchema: { type: 'string' } },
      testInvocation(),
    ),
  ).rejects.toThrow('object root');
  expect(harness.report(null)).toMatchObject({
    calls: [{ stepId: 'invalid-root', wouldPay: false, plan: null }],
    nominalClaudeCeilingUsd: 0,
  });
});

it('selects a shipped fake CLI envelope by prompt pattern and logs its original call', async () => {
  const { stateDir: cwd } = await setup();
  const routes = join(cwd, 'routes.json');
  const log = join(cwd, 'calls.jsonl');
  await writeFile(
    routes,
    JSON.stringify({
      version: 1,
      calls: [
        { step: 'different/*', scenario: 'claude-text-success' },
        { prompt: '^pattern-only$', scenario: 'claude-api-error' },
      ],
    }),
  );
  const binary = fileURLToPath(new URL('./bin/fake-claude.mjs', import.meta.url));
  await expect(
    new CliHarness({ claudeBinary: binary }).invoke(
      {
        harness: 'claude',
        cwd,
        outputSchema: null,
        options: {
          prompt: 'pattern-only',
          env: { QUIET_CHOIR_FAKE_ROUTES: routes, QUIET_CHOIR_FAKE_LOG: log },
        },
      },
      testInvocation(),
    ),
  ).rejects.toMatchObject({ exit: { code: 1, signal: null } });
  expect(JSON.parse(await readFile(log, 'utf8')) as unknown).toMatchObject({
    scenario: 'claude-api-error',
    stdin: 'pattern-only',
    schema: null,
    stepId: 'call',
    version: '2.1.283',
  });
});

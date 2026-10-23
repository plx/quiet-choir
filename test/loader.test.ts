import { workflowFailure } from '../src/workflow/loader/failure.js';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { ExecuteWorkflowPlan } from '../src/workflow/loader/model.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import type { HarnessFixtures } from '../src/harnesses/fixture.js';
import { startFakeDecisionServer } from './decision-fake-server.js';

// One program cache for the file, so each compile of the engine source after the first reuses its
// parse and checks (see CONTRIBUTING.md, "Test timeouts and storage sync").
const typecheckCache = new TypecheckProgramCache();

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const imports = `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};`;

async function fixture(source: string, extension = 'ts'): Promise<{ file: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-loader-'));
  roots.push(root);
  const file = join(root, `workflow.${extension}`);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  await writeFile(file, source);
  return { file, root };
}

function plan(file: string) {
  const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
  if (!analysis.ok) throw new Error(analysis.error.message);
  return { kind: 'workflow.validate' as const, typecheck: analysis.plan };
}

function executor(): WorkflowExecutor {
  return new WorkflowExecutor({
    typecheckCache,
    logger: new ThresholdLogger('silent', () => undefined),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const validSource = `${imports}
export default defineWorkflow({
  name: 'fixture', version: '1', input: z.object({ value: z.number() }), output: z.number(),
  async run(ctx, input) {
    return ctx.step('double', { input: input.value, schema: z.number(), run: () => input.value * 2 });
  },
});`;

// Real compiler passes can exceed five seconds under coverage on shared CI runners.
// measured: the slowest case takes 0.6 s alone, 3.2-6.5 s in local full coverage runs and 10.0 s on
// the Node 22.13 CI leg (tsImport compile).
describe('trusted TypeScript workflow loader', { timeout: 20_000 }, () => {
  it('type-checks and validates metadata without invoking the body', async () => {
    const { file } = await fixture(
      validSource.replace(
        'return ctx.step(',
        "throw new Error('body was called'); return ctx.step(",
      ),
    );
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      kind: 'workflow.validate.result',
      ok: true,
      workflow: {
        name: 'fixture',
        version: '1',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('rejects type errors before importing module top-level code', async () => {
    const { file, root } = await fixture(`import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported', import.meta.url), 'bad');
export const invalid: number = 'wrong';`);
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: 'Workflow type check failed.',
      diagnostics: [expect.objectContaining({ code: 2322 })],
    });
    await expect(readFile(join(root, 'imported'))).rejects.toThrow();
  });

  it.each([
    ['export const named = {};', 'default-export'],
    ['export default null;', 'default-export'],
    ['export default {name:"",version:"1",run(){}};', '"name" must be a nonempty string'],
    ['export default {name:"test",version:1,run(){}};', '"version" must be a nonempty string'],
    ['export default {name:"test",version:"1",run:42};', '"run" must be a function'],
    [
      'export default {name:"test",version:"1",run(){},input:{},output:{}};',
      '"input" is not a zod 4 schema',
    ],
    [
      `${imports} export default {name:"test",version:"1",run(){},input:z.string(),output:{}};`,
      '"output" is not a zod 4 schema',
    ],
  ])('identifies the invalid default-export field', async (source, message) => {
    const { file } = await fixture(source);
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(message) as unknown,
    });
  });

  it.each(['zod/v3', 'zod/mini'])('explains unsupported %s schemas', async (library) => {
    const { file } = await fixture(`
      import * as unsupported from '${library}';
      export default { name: 'schema', version: '1', input: unsupported.string(), output: unsupported.string(), async run() { return 'ok'; } };
    `);
    expect(await executor().execute(plan(file))).toMatchObject({
      ok: false,
      message: `Workflow "input" is not a zod 4 schema (zod/v3 and zod/mini are unsupported; import { z } from 'quiet-choir').`,
    });
  });

  it('reports module initialization errors as plain data', async () => {
    const { file } = await fixture('throw "module initialization failed"; export default {};');
    const result = await executor().execute(plan(file));
    expect(result).toEqual(workflowFailure('load.import', 'module initialization failed'));
  });

  it('supports CommonJS TypeScript default exports', async () => {
    const { file } = await fixture(validSource, 'cts');
    const result = await executor().execute(plan(file));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, workflow: { name: 'fixture' } });
  });

  it('loads .ts files and local imports in a CommonJS package', async () => {
    const { file, root } = await fixture(
      `import { factor } from './helper.js';\n${validSource.replace('input.value * 2', 'input.value * factor')}`,
    );
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(root, 'helper.ts'), 'export const factor = 2;');
    const result = await executor().execute(plan(file));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('rejects schemas that cannot be represented as JSON before validation succeeds', async () => {
    const { file } = await fixture(
      `${imports} export default defineWorkflow({ name: 'date', version: '1', input: z.date(), output: z.date(), async run(_ctx,input) { return input; } });`,
    );
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: 'Date cannot be represented in JSON Schema',
    });
  });

  it('fingerprints transitive local imports and the selected tsconfig', async () => {
    const { file, root } = await fixture(
      `import { factor } from './helper.js';\n${validSource.replace('input.value * 2', 'input.value * factor')}`,
    );
    const helper = join(root, 'helper.ts');
    await writeFile(helper, 'export const factor = 2;');
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'NodeNext', target: 'ES2023', strict: true, skipLibCheck: true },
      }),
    );
    const first = await executor().execute(plan(file));
    await writeFile(helper, 'export const factor = 3;');
    const second = await executor().execute(plan(file));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (first.kind === 'workflow.validate.result' && second.kind === 'workflow.validate.result') {
      expect(first.workflow.fingerprint).not.toBe(second.workflow.fingerprint);
    }
  });

  it('executes, inspects, and resumes a local workflow with validated input', async () => {
    const { file, root } = await fixture(validSource);
    const executionPlan: ExecuteWorkflowPlan = {
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'loader-test',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: { value: 21 },
    };
    const log = vi.fn();
    const runner = new WorkflowExecutor({
      typecheckCache,
      logger: { log },
      signal: new AbortController().signal,
      harness: { invoke: vi.fn() },
    });
    const executed = await runner.execute(executionPlan);
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: { status: 'completed', output: 42 },
    });
    const inspected = await runner.execute({
      kind: 'workflow.inspect',
      runId: 'loader-test',
      stateDir: join(root, 'state'),
    });
    expect(inspected).toMatchObject({
      ...executed,
      ownership: { locked: false, owner: null, processes: [], locks: [] },
      summary: { id: 'loader-test', status: 'completed', counts: { total: 1, completed: 1 } },
    });
    const resumed = await runner.execute({ ...executionPlan, resume: true });
    expect(resumed).toMatchObject({ ok: true, run: { output: 42 } });
    expect(log).toHaveBeenCalledWith('debug', expect.stringContaining('step.completed double'));
  });

  it('warns instead of throwing when a configuration selects a harness declared only by a dynamically invoked child', async () => {
    const { file, root } = await fixture(`import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
import { defineHarness } from ${JSON.stringify(join(projectRoot, 'src/harnesses/definition.js'))};

const third = defineHarness({
  name: 'third',
  revision: 1,
  options: z.object({ prompt: z.string() }),
  capabilities: { structuredOutput: 'none' },
  access: () => 'none',
  createAdapter: (config) => {
    const parsed = z.object({ token: z.string() }).parse(config);
    return { invoke: async () => ({ text: parsed.token, sessionId: null }) };
  },
});

const child = defineWorkflow({
  name: 'child',
  version: '1',
  harnesses: [third],
  input: z.null(),
  output: z.string(),
  async run(ctx) {
    return ctx.agent('third').value('probe', { prompt: 'hi' });
  },
});

export default defineWorkflow({
  name: 'dynamic-root',
  version: '1',
  input: z.null(),
  output: z.string(),
  async run(ctx) {
    return ctx.workflow('child', child, null);
  },
});`);
    const log = vi.fn();
    const runner = new WorkflowExecutor({ typecheckCache, logger: { log } });
    const executed = await runner.execute({
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'dynamic-child-config',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: null,
      harness: {
        kind: 'cli',
        config: {},
        configurations: { third: { token: 'expected-token' } },
      },
    });
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: { status: 'completed', output: 'expected-token' },
    });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('third'));
  });

  it('passes decisions.<name> configuration to a provider declared in its own module instance', async () => {
    const { file, root } = await fixture(`${imports}
import { defineDecisionProvider, noul } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/decision-protocol.js'))};
const local = defineDecisionProvider({
  name: 'local',
  revision: 1,
  capabilities: { kinds: ['noul'], maxOptions: 1, levels: [2, 2], idempotencyKey: false },
  defaultModel: 'declared-model',
  transport: (configuration) => async (request) => ({
    body: { model: String(request.model) + '@' + String(configuration.baseUrl), answers: { ok: { type: 'noul', noul: 1 } } },
  }),
});
export default defineWorkflow({
  name: 'decide', version: '1', input: z.null(), output: z.number(),
  decisions: [local],
  async run(ctx) {
    const answers = await ctx.decide('ask', { state: null, questions: { ok: noul({ instructions: 'ok?' }) } });
    return answers.ok.noul;
  },
});`);
    const log = vi.fn();
    const runner = new WorkflowExecutor({ typecheckCache, logger: { log } });
    const executed = await runner.execute({
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'decision-config',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: null,
      harness: {
        kind: 'cli',
        config: {},
        decisions: {
          local: { defaultModel: 'configured-model', baseUrl: 'https://decide.example' },
          ghost: {},
        },
      },
    });
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: {
        status: 'completed',
        output: 1,
        steps: { ask: { output: { model: 'configured-model@https://decide.example' } } },
      },
    });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('Decision provider ghost is not declared'),
    );
    expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('provider local'));
  });

  it('rejects invalid inputs and reports missing run metadata', async () => {
    const { file, root } = await fixture(validSource);
    const executed = await executor().execute({
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'bad-input',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: { value: 'wrong' },
    });
    expect(executed).toMatchObject({ ok: false });
    const inspected = await executor().execute({
      kind: 'workflow.inspect',
      runId: 'missing',
      stateDir: root,
    });
    expect(inspected).toMatchObject({ ok: false });
  });
  it('lists available runs and the absolute directory when inspect cannot find a run', async () => {
    const fixtureInfo = await fixture(validSource);
    const root = join(fixtureInfo.root, 'runs');
    await mkdir(root);
    for (const name of ['beta.json', 'alpha.json', 'notes.txt', 'alpha.json.backup'])
      await writeFile(join(root, name), '{}');
    expect(
      await executor().execute({ kind: 'workflow.inspect', stateDir: root, runId: 'nope' }),
    ).toMatchObject({
      ok: false,
      message: `Run nope not found in ${root} (2 runs present: alpha, beta). --state-dir resolves against the current directory.`,
    });
    const absent = join(root, 'absent');
    expect(
      await executor().execute({ kind: 'workflow.inspect', stateDir: absent, runId: 'nope' }),
    ).toMatchObject({
      ok: false,
      message: `Run nope not found in ${absent} (0 runs present). --state-dir resolves against the current directory.`,
    });
  });
});

// Decision fixtures through the executor (#652): --dry-run and --harness fixture answer ctx.decide
// without building a provider transport, and `workflow fixtures` exports decision steps.
// measured: like the loader suite above, dominated by the tsImport compile of each module.
// Node 24 coverage CI shards, six runs (Oct 2026, #715): 10.3-19.7 s for the --dry-run case,
// which also timed out once at 20 s (PR #714).
describe('decision fixtures through the executor', { timeout: 45_000 }, () => {
  const decisionImports = `${imports}
import { choice, defineDecisionProvider, jevCompatible, noul } from ${JSON.stringify(join(projectRoot, 'src/integrations/decision.js'))};`;
  const guardedSource = `${decisionImports}
const guarded = defineDecisionProvider({
  name: 'guarded',
  revision: 1,
  capabilities: { kinds: ['noul', 'choice', 'score'], maxOptions: 255, levels: [2, 10], idempotencyKey: false },
  defaultModel: 'guarded-1',
  transport: () => { throw new Error('the guarded transport factory was called'); },
});
const jev = jevCompatible({ name: 'jev', apiKeyEnv: 'QC_UNSET_DECISION_TOKEN', defaultModel: 'jev-1' });
const team = choice({ instructions: 'Which team?', options: { a: null, b: null } });
export default defineWorkflow({
  name: 'decide', version: '1', input: z.null(), output: z.unknown(),
  decisions: [guarded, jev],
  async run(ctx) {
    const first = await ctx.decide('first', { provider: 'guarded', state: 1, questions: { team } });
    const second = await ctx.decide('second', { provider: 'jev', state: 2, questions: { ok: noul({ instructions: 'ok?' }) } });
    return { first, second };
  },
});`;
  const synthesizedOutput = {
    first: { team: { choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 } },
    second: { ok: { noul: 0 } },
  };

  it('rehearses under --dry-run without configuration, credentials or a transport', async () => {
    vi.stubEnv('QC_UNSET_DECISION_TOKEN', undefined);
    const { file, root } = await fixture(guardedSource);
    const executed = await executor().execute({
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'dry',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: null,
      dryRun: true,
    });
    vi.unstubAllEnvs();
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: { status: 'completed', output: synthesizedOutput },
    });
    if (executed.kind !== 'workflow.run.result' || !executed.rehearsal)
      throw new Error('expected a rehearsal');
    expect(executed.rehearsal.decisions).toEqual([
      {
        stepId: 'first',
        attempt: 1,
        provider: 'guarded',
        model: 'guarded-1',
        outputSource: 'synthesized',
        error: null,
      },
      {
        stepId: 'second',
        attempt: 1,
        provider: 'jev',
        model: 'jev-1',
        outputSource: 'synthesized',
        error: null,
      },
    ]);
  });

  it('answers from a fixture file, refuses an unmatched decision, and synthesizes on request', async () => {
    const { file, root } = await fixture(guardedSource);
    const execute = (
      runId: string,
      decisions: NonNullable<HarnessFixtures['decisions']>,
      unmatched?: 'synthesize',
      dryRun = false,
    ) =>
      executor().execute({
        ...plan(file),
        kind: 'workflow.execute',
        runId,
        stateDir: join(root, 'state'),
        cwd: root,
        resume: false,
        input: null,
        dryRun,
        harness: {
          kind: 'fixture',
          config: {},
          fixtures: {
            version: 1,
            calls: [],
            ...(unmatched === undefined ? {} : { unmatched }),
            decisions,
          },
        },
      });
    const answered = await execute('answered', {
      first: { answers: { team: { choice: 'b', probabilities: { a: 0, b: 1 }, confidence: 0.5 } } },
      second: { answers: { ok: { noul: 0.9 } }, model: 'served' },
    });
    expect(answered).toMatchObject({
      ok: true,
      run: {
        status: 'completed',
        output: {
          first: { team: { choice: 'b', probabilities: { a: 0, b: 1 }, confidence: 0.5 } },
          second: { ok: { noul: 0.9 } },
        },
        harness: { kind: 'fixture' },
        steps: { second: { output: { model: 'served' } } },
      },
    });
    const partial = {
      first: { answers: { team: { choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 } } },
    };
    const refused = await execute('refused', partial);
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        'No decision fixture matches step second (provider jev, attempt 1).',
      ) as unknown,
    });
    expect(await execute('synthesized', partial, 'synthesize')).toMatchObject({
      ok: true,
      run: { output: synthesizedOutput },
    });
    const rehearsed = await execute('rehearsed', partial, undefined, true);
    expect(rehearsed).toMatchObject({ ok: true, run: { output: synthesizedOutput } });
    if (rehearsed.kind !== 'workflow.run.result' || !rehearsed.rehearsal)
      throw new Error('expected a rehearsal');
    expect(rehearsed.rehearsal.decisions.map(({ outputSource }) => outputSource)).toEqual([
      'fixture',
      'synthesized',
    ]);
  });

  it('exports decision steps that replay to the same run and export again identically', async () => {
    const token = 'dummy-decision-token-0123456789';
    const server = await startFakeDecisionServer(token);
    vi.stubEnv('QC_LOADER_DECISION_TOKEN', token);
    try {
      server.script(
        {
          status: 200,
          body: {
            model: 'jev-served',
            answers: {
              refund: { type: 'noul', noul: 0.25 },
              team: {
                type: 'choice',
                choice: 'b',
                probabilities: { a: 0.2, b: 0.8 },
                confidence: 0.7,
              },
            },
            usage: { input_tokens: 11, output_tokens: 4 },
          },
        },
        { status: 429, body: { detail: 'slow down' } },
        { status: 200, body: { answers: { refund: { type: 'noul', noul: 3 } } } },
      );
      const source = (factory: string) => `${decisionImports}
const live = jevCompatible({ name: 'jev', apiKeyEnv: 'QC_LOADER_DECISION_TOKEN', defaultModel: 'jev-1' });
const jev = ${factory};
const refund = noul({ instructions: 'Refund?' });
const team = choice({ instructions: 'Which team?', options: { a: null, b: null } });
export default defineWorkflow({
  name: 'decide', version: '1', input: z.null(), output: z.unknown(),
  decisions: [jev],
  async run(ctx) {
    const answered = await ctx.decide('answered', { state: 1, questions: { refund, team } });
    const limited = await ctx.decide('limited', { state: 2, questions: { refund }, onError: 'return' });
    let absorbed = 'none';
    try {
      await ctx.decide('absorbed', { state: 3, questions: { refund } });
    } catch (error) {
      absorbed = String((error as { kind?: unknown }).kind);
    }
    return { answered, limited: limited.ok ? 'ok' : limited.error.kind, absorbed };
  },
});`;
      const { file, root } = await fixture(source('live'));
      const stateDir = join(root, 'state');
      const original = await executor().execute({
        ...plan(file),
        kind: 'workflow.execute',
        runId: 'original',
        stateDir,
        cwd: root,
        resume: false,
        input: null,
        harness: { kind: 'cli', config: {}, decisions: { jev: { baseUrl: server.url } } },
      });
      if (original.kind !== 'workflow.run.result')
        throw new Error(`expected a completed run: ${JSON.stringify(original)}`);
      expect(original.run.output).toEqual({
        answered: {
          refund: { noul: 0.25 },
          team: { choice: 'b', probabilities: { a: 0.2, b: 0.8 }, confidence: 0.7 },
        },
        limited: 'rate-limit',
        absorbed: 'schema',
      });
      expect(server.count).toBe(3);
      const exported = await executor().execute({
        kind: 'workflow.fixtures',
        runId: 'original',
        stateDir,
      });
      if (exported.kind !== 'workflow.fixtures.result') throw new Error('expected fixtures');
      const limitedMessage = original.run.steps['limited']?.settledError?.message ?? '';
      const absorbedMessage = original.run.steps['absorbed']?.error ?? '';
      expect(limitedMessage).toMatch(/^Decision provider jev: /u);
      expect(exported.fixtures.decisions).toEqual({
        answered: {
          answers: original.run.steps['answered']?.output
            ? (original.run.steps['answered'].output as { answers: unknown }).answers
            : null,
          model: 'jev-served',
          usage: { inputTokens: 11, outputTokens: 4 },
        },
        limited: {
          error: limitedMessage.slice('Decision provider jev: '.length),
          kind: 'rate-limit',
        },
        absorbed: {
          error: absorbedMessage.slice('Decision provider jev: '.length),
          kind: 'schema',
        },
      });
      // The replay's provider factory throws, so every answer must come from the exported file.
      const { file: replayFile } = await fixture(
        source(
          "defineDecisionProvider({ name: 'jev', revision: live.revision, capabilities: live.capabilities, defaultModel: 'jev-1', transport: () => { throw new Error('the replay built a transport'); } })",
        ),
      );
      const replayed = await executor().execute({
        ...plan(replayFile),
        kind: 'workflow.execute',
        runId: 'replayed',
        stateDir,
        // The original cwd, which is part of each step's identity.
        cwd: root,
        resume: false,
        input: null,
        harness: { kind: 'fixture', config: {}, fixtures: exported.fixtures },
      });
      if (replayed.kind !== 'workflow.run.result')
        throw new Error(`expected a completed replay: ${JSON.stringify(replayed)}`);
      expect(server.count).toBe(3);
      expect(replayed.run.output).toEqual(original.run.output);
      for (const id of ['answered', 'limited', 'absorbed']) {
        const before = original.run.steps[id];
        const after = replayed.run.steps[id];
        expect(after?.status).toBe(before?.status);
        expect(after?.output).toEqual(before?.output);
        expect(after?.identity).toEqual(before?.identity);
        expect(after?.settledError?.kind).toBe(before?.settledError?.kind);
        expect(after?.settledError?.message).toBe(before?.settledError?.message);
        expect(after?.error).toBe(before?.error);
      }
      expect(replayed.run.steps['answered']?.attemptHistory?.at(-1)?.usage).toEqual(
        original.run.steps['answered']?.attemptHistory?.at(-1)?.usage,
      );
      expect(replayed.run.steps['limited']?.attemptHistory?.at(-1)?.usage).toEqual(
        original.run.steps['limited']?.attemptHistory?.at(-1)?.usage,
      );
      const again = await executor().execute({
        kind: 'workflow.fixtures',
        runId: 'replayed',
        stateDir,
      });
      expect(again).toEqual(exported);
      // A run without decisions exports no decisions key.
      const { file: plain, root: plainRoot } = await fixture(validSource);
      await executor().execute({
        ...plan(plain),
        kind: 'workflow.execute',
        runId: 'plain',
        stateDir: join(plainRoot, 'state'),
        cwd: plainRoot,
        resume: false,
        input: { value: 2 },
      });
      const plainExport = await executor().execute({
        kind: 'workflow.fixtures',
        runId: 'plain',
        stateDir: join(plainRoot, 'state'),
      });
      expect(plainExport).toMatchObject({ ok: true });
      expect(plainExport).not.toHaveProperty('fixtures.decisions');
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  });
});

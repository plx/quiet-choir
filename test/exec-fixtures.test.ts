import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ExecError,
  FixtureHarness,
  NodeProcessRunner,
  defineWorkflow,
  parseHarnessFixtures,
  readRun,
  runWorkflow,
  z,
  type Command,
  type HarnessFixtures,
  type ProcessRunRequest,
  type WorkflowContext,
} from '../src/index.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { FixtureExecRules, FixtureProcessRunner } from '../src/harnesses/fixture-exec.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { fixturesFromRun } from '../src/workflow/loader/fixtures.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import { RehearsalHarness } from '../src/workflow/loader/rehearsal.js';
import { digest, jsonValue } from '../src/workflow/runtime/json.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';

// One program cache for the file, so each compile of the engine source after the first reuses its
// parse and checks (see CONTRIBUTING.md, "Test timeouts and storage sync").
const typecheckCache = new TypecheckProgramCache();

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let stateDir: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-exec-fixtures-')));
  stateDir = join(root, 'state');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const native = new NodeProcessRunner();
const node = (code: string): Command => [process.execPath, '-e', code];
const definition = <T>(output: z.ZodType<T>, run: (ctx: WorkflowContext) => Promise<T>) =>
  defineWorkflow({ name: 'exec-fixtures', version: '1', input: z.null(), output, run });
const options = (runId = 'run') => ({ cwd: root, stateDir, runId, input: null });
function request(
  command: Command,
  env: Record<string, string> = {},
  input = '',
): ProcessRunRequest {
  return {
    command,
    cwd: '/',
    env,
    inheritEnv: true,
    input,
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    capture: 'truncate',
    schema: null,
  };
}
const at = (stepId: string, attempt = 1) => ({ stepId, attempt });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function rules(exec: HarnessFixtures['exec'], commands?: 'fixture') {
  const parsed = parseHarnessFixtures({
    version: 1,
    calls: [],
    exec,
    ...(commands ? { commands } : {}),
  });
  return new FixtureExecRules(parsed.exec, parsed.commands);
}
function rehearsal(fixtures: Omit<HarnessFixtures, 'version' | 'calls'>) {
  const harness = new RehearsalHarness({
    kind: 'fixture',
    config: {},
    fixtures: parseHarnessFixtures({ version: 1, calls: [], ...fixtures }),
  });
  return {
    harness,
    run: { harness, rehearsal: harness.hooks, processRunner: harness.processRunner },
  };
}

describe('exec fixture rules', () => {
  it('validates exactly one of json or stdout, strict keys, step globs, argv prefixes and digests', () => {
    const parse = (rule: object) => parseHarnessFixtures({ version: 1, calls: [], exec: [rule] });
    expect(parse({ step: 'gate-*', json: null }).exec).toEqual([{ step: 'gate-*', json: null }]);
    expect(() => parse({ step: 'x' })).toThrow('Exactly one of json or stdout');
    expect(() => parse({ step: 'x', json: {}, stdout: '' })).toThrow(
      'Exactly one of json or stdout',
    );
    expect(() => parse({ step: 'x', stdout: '', output: 'agent key' })).toThrow();
    expect(() => parse({ exec: 'x', stdout: '' })).toThrow();
    expect(() => parse({ step: 'x[', stdout: '' })).toThrow();
    expect(() => parse({ step: 'x', stdout: '', envSha256: 'abc' })).toThrow();
    expect(() => parse({ step: 'x', stdout: '', inputSha256: sha256('').toUpperCase() })).toThrow();
    expect(() => parse({ step: 'x', stdout: '', argvPrefix: [] })).toThrow();
    expect(() => parse({ step: 'x', stdout: '', code: 256 })).toThrow();
    expect(() => parse({ step: 'x', stdout: '', occurrence: 0 })).toThrow();
    expect(() => parseHarnessFixtures({ version: 1, calls: [], commands: 'synthesize' })).toThrow();
    expect(
      parse({
        step: 'x',
        stdout: 'out',
        stderr: 'err',
        code: 2,
        argvPrefix: ['gh'],
        envSha256: digest({}),
        inputSha256: sha256(''),
        attempt: 1,
        occurrence: 1,
      }).exec?.[0],
    ).toMatchObject({ code: 2, argvPrefix: ['gh'] });
  });

  it('accepts exec error rules, keeps result rules valid, and refuses malformed error rules (AC3, AC5)', () => {
    const parse = (rule: object) => parseHarnessFixtures({ version: 1, calls: [], exec: [rule] });
    expect(parse({ step: 'x', error: 'Cannot start gh.' }).exec).toEqual([
      { step: 'x', error: 'Cannot start gh.' },
    ]);
    expect(parse({ step: 'x', error: 'too slow', kind: 'timeout', attempt: 1 }).exec).toEqual([
      { step: 'x', error: 'too slow', kind: 'timeout', attempt: 1 },
    ]);
    expect(() => parse({ step: 'x', error: 'e', stdout: '' })).toThrow('Exactly one of json');
    expect(() => parse({ step: 'x', error: 'e', json: null })).toThrow('Exactly one of json');
    expect(() => parse({ step: 'x', kind: 'timeout', stdout: '' })).toThrow('kind requires error');
    expect(() => parse({ step: 'x', error: 'e', stderr: 'oops' })).toThrow(
      'stderr and code require json or stdout',
    );
    expect(() => parse({ step: 'x', error: 'e', code: 1 })).toThrow(
      'stderr and code require json or stdout',
    );
    expect(() => parse({ step: 'x', error: '' })).toThrow();
    expect(() => parse({ step: 'x', error: 'e', kind: 'exploded' })).toThrow();
    // Result rules are unchanged: stderr and code stay valid, and a result rule may not carry kind.
    expect(parse({ step: 'x', json: null, stderr: 'warn', code: 2 }).exec).toEqual([
      { step: 'x', json: null, stderr: 'warn', code: 2 },
    ]);
    expect(parse({ step: 'x', stdout: 'out' }).exec).toEqual([{ step: 'x', stdout: 'out' }]);
  });

  it('matches argv prefixes only on argv commands, and environment and stdin digests', () => {
    const prefixed = rules([
      { step: '*', argvPrefix: ['gh', 'pr'], stdout: 'prefixed' },
      { step: '*', stdout: 'any' },
    ]);
    expect(prefixed.match(request(['gh', 'pr', 'view']), at('a'))?.index).toBe(0);
    expect(prefixed.match(request(['gh']), at('a'))?.index).toBe(1);
    expect(prefixed.match(request(['gh', 'issue']), at('a'))?.index).toBe(1);
    expect(prefixed.match(request({ shell: 'gh pr view' }), at('a'))?.index).toBe(1);
    const digests = rules([
      { step: 'x', envSha256: digest({ A: '1' }), inputSha256: sha256('in'), stdout: 'both' },
      { step: 'x', envSha256: digest({ A: '1' }), stdout: 'env' },
    ]);
    expect(digests.match(request(['a'], { A: '1' }, 'in'), at('x'))?.index).toBe(0);
    expect(digests.match(request(['a'], { A: '1' }, 'other'), at('x'))?.index).toBe(1);
    expect(digests.match(request(['a'], { A: '2' }, 'in'), at('x'))).toBeUndefined();
    expect(digests.match(request(['a'], { A: '1' }, 'in'), at('y'))).toBeUndefined();
    expect(digests.stale()).toEqual([]);
  });

  it('matches attempts and counts occurrences per rule, independent of earlier rules and stable across retries', () => {
    const attempts = rules([
      { step: 'x', attempt: 1, stdout: 'first' },
      { step: 'x', stdout: 'later' },
    ]);
    expect(attempts.match(request(['a']), at('x', 1))?.index).toBe(0);
    expect(attempts.match(request(['a']), at('x', 2))?.index).toBe(1);

    const gate = [
      { step: 'gate-*', occurrence: 1, stdout: 'failure' },
      { step: 'gate-*', occurrence: 2, stdout: 'success' },
      { step: 'gate-*', stdout: 'fallback' },
    ];
    // An earlier rule that wins gate-a does not stop the gate rules from counting it.
    const shadowed = rules([{ step: 'gate-a', stdout: 'special' }, ...gate]);
    const plain = rules(gate);
    for (const [entries, offset] of [
      [shadowed, 1],
      [plain, 0],
    ] as const) {
      const first = entries.match(request(['ci']), at('gate-a'));
      expect(first?.index).toBe(0);
      expect(entries.match(request(['ci']), at('gate-b'))?.index).toBe(1 + offset);
      // A retry of gate-b keeps its occurrence; a third distinct step falls through.
      expect(entries.match(request(['ci']), at('gate-b', 2))?.index).toBe(1 + offset);
      expect(entries.match(request(['ci']), at('gate-c'))?.index).toBe(2 + offset);
      expect(entries.match(request(['ci']), at('gate-a', 2))?.index).toBe(0);
    }
    expect(shadowed.stale()).toEqual([1]);
    expect(plain.stale()).toEqual([]);
  });

  it('builds results, refuses unmatched commands with step, argv and attempt, and reports stale rules', () => {
    const entries = rules(
      [
        { step: 'json', json: null, code: 3 },
        { step: 'text', stdout: 'out', stderr: 'err' },
        { step: 'never', stdout: '' },
      ],
      'fixture',
    );
    const json = entries.match(request(['a']), at('json'));
    const text = entries.match(request(['a']), at('text'));
    if (!json || !text) throw new Error('expected matches');
    expect(entries.result(json.rule)).toEqual({
      code: 3,
      signal: null,
      stdout: 'null',
      stderr: '',
      truncated: false,
      durationMs: 0,
    });
    expect(entries.result(text.rule)).toMatchObject({ code: 0, stdout: 'out', stderr: 'err' });
    const refusal = entries.unmatched(request(['gh', 'pr', 'checks']), at('gate-2', 2));
    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect(refusal.message).toBe(
      'No exec fixture matches step gate-2: ["gh","pr","checks"] (attempt 2).',
    );
    expect(entries.unmatched(request({ shell: 'make' }), at('build')).message).toContain(
      '{"shell":"make"}',
    );
    expect(entries.stale()).toEqual([2]);
  });
});

describe('exec error rules', () => {
  it('answers a result rule with its unchanged result and an error rule with an ExecError (AC1, AC3)', async () => {
    const entries = rules([
      { step: 'ok', stdout: 'out', stderr: 'err', code: 3 },
      { step: 'spawn', error: 'Cannot start gh. Is it installed?' },
      { step: 'slow', error: 'exceeded its 1000ms deadline.', kind: 'timeout' },
    ]);
    const ok = entries.match(request(['a']), at('ok'));
    const spawn = entries.match(request(['a']), at('spawn'));
    const slow = entries.match(request(['a']), at('slow'));
    if (!ok || !spawn || !slow) throw new Error('expected matches');
    await expect(entries.answer(ok.rule)).resolves.toEqual(entries.result(ok.rule));
    const failure = async (rule: typeof spawn.rule) => {
      const error: unknown = await entries.answer(rule).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      if (!(error instanceof ExecError)) throw new Error('expected an ExecError');
      return error;
    };
    const spawnFailure = await failure(spawn.rule);
    expect(spawnFailure.kind).toBe('process');
    expect(spawnFailure.message).toBe('Cannot start gh. Is it installed?');
    expect(spawnFailure.diagnostics).toEqual({
      code: null,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      truncated: false,
      durationMs: 0,
    });
    const slowFailure = await failure(slow.rule);
    expect(slowFailure.kind).toBe('timeout');
    expect(slowFailure.message).toBe('exceeded its 1000ms deadline.');
    expect(slowFailure.diagnostics.code).toBeNull();
  });

  it('keeps first-match order and occurrence counting for error rules', () => {
    const entries = rules([
      { step: 'poll', attempt: 1, error: 'down' },
      { step: 'poll', attempt: 2, stdout: 'up' },
    ]);
    expect(entries.match(request(['a']), at('poll', 1))?.index).toBe(0);
    expect(entries.match(request(['a']), at('poll', 2))?.index).toBe(1);
    expect(entries.stale()).toEqual([]);
  });
});

describe('dry-run command fixtures', () => {
  it('records the output source and matched rule index of each command (AC2a)', async () => {
    const { harness, run } = rehearsal({ exec: [{ step: 'known', stdout: 'from fixture' }] });
    const result = await runWorkflow(
      definition(z.string(), async (ctx) => {
        const known = await ctx.exec('known', ['qc-test-missing-binary', 'known']);
        const other = await ctx.exec('other', ['qc-test-missing-binary', 'other']);
        return `${known.stdout}|${other.stdout}`;
      }),
      { ...options(), ...run },
    );
    expect(result.output).toBe('from fixture|');
    const report = harness.report(result);
    expect(report.commands).toEqual([
      expect.objectContaining({
        stepId: 'known',
        outputSource: 'fixture',
        fixtureIndex: 0,
        error: null,
      }),
      expect.objectContaining({
        stepId: 'other',
        outputSource: 'synthesized',
        fixtureIndex: null,
        error: null,
      }),
    ]);
    expect(report.staleExecFixtures).toEqual([]);
    expect(report.warnings.some((warning) => warning.startsWith('Commands are synthesized'))).toBe(
      true,
    );
  });

  it('fails a missing rule under commands: fixture at its step with the argv, never retried or settled (AC2b)', async () => {
    const { harness, run } = rehearsal({ exec: [], commands: 'fixture' });
    await expect(
      runWorkflow(
        definition(z.string(), async (ctx) => {
          const result = await ctx.exec('missing', ['qc-test-gh', 'pr', 'checks'], {
            retry: { maxAttempts: 3, delayMs: 1 },
          });
          return result.stdout;
        }),
        { ...options(), ...run },
      ),
    ).rejects.toMatchObject({
      stepId: 'missing',
      message: expect.stringContaining(
        'No exec fixture matches step missing: ["qc-test-gh","pr","checks"] (attempt 1).',
      ) as unknown,
    });
    const step = (await readRun(options())).steps['missing'];
    expect(step?.status).toBe('failed');
    expect(step?.settledError).toBeUndefined();
    expect(step?.attempts).toBe(1);
    const report = harness.report(null);
    expect(report.commands).toEqual([
      expect.objectContaining({
        stepId: 'missing',
        outputSource: 'fixture',
        fixtureIndex: null,
        error: 'No exec fixture matches step missing: ["qc-test-gh","pr","checks"] (attempt 1).',
      }),
    ]);
    expect(report.warnings.some((warning) => warning.startsWith('Commands are synthesized'))).toBe(
      false,
    );
  });

  it('reports rules that matched nothing as stale, with a warning (AC2c)', async () => {
    const { harness, run } = rehearsal({
      exec: [
        { step: 'used', stdout: 'ok' },
        { step: 'used', argvPrefix: ['other-program'], stdout: 'never' },
      ],
      commands: 'fixture',
    });
    const result = await runWorkflow(
      definition(
        z.string(),
        async (ctx) => (await ctx.exec('used', ['qc-test-missing-binary'])).stdout,
      ),
      { ...options(), ...run },
    );
    expect(result.output).toBe('ok');
    const report = harness.report(result);
    expect(report.staleExecFixtures).toEqual([1]);
    expect(report.warnings).toContainEqual(
      expect.stringContaining('Exec fixture rules 1 matched no command'),
    );
  });
});

describe('exec error rules end to end', () => {
  const Settled = z.json();
  const flaky = (retry: { maxAttempts: number; delayMs: number; on?: ['transient'] }) =>
    definition(z.string(), async (ctx) => {
      const result = await ctx.exec('probe', ['qc-test-missing-binary', 'probe'], { retry });
      return result.stdout;
    });
  const exec: NonNullable<HarnessFixtures['exec']> = [
    { step: 'probe', attempt: 1, error: 'exceeded its 1000ms deadline.', kind: 'timeout' },
    { step: 'probe', attempt: 2, stdout: 'recovered' },
  ];
  /** Both ways to run a fixture: --dry-run and --harness fixture, which never spawn here. */
  function runners(fixtures: HarnessFixtures) {
    const harness = new RehearsalHarness({ kind: 'fixture', config: {}, fixtures });
    const refuse = { run: () => Promise.reject(new Error('spawned a real command')) };
    return {
      harness,
      dry: { harness, rehearsal: harness.hooks, processRunner: harness.processRunner },
      fixture: {
        harness: new FixtureHarness(fixtures),
        processRunner: refuse,
        execRunner: new FixtureProcessRunner(fixtures, refuse),
      },
    };
  }

  it('fails ctx.exec with a process ExecError for a spawn failure and records it in the report (AC1)', async () => {
    const fixtures = parseHarnessFixtures({
      version: 1,
      calls: [],
      exec: [{ step: 'probe', error: 'Cannot start gh. Is it installed?' }],
    });
    const workflow = definition(Settled, async (ctx) => {
      try {
        await ctx.exec('probe', ['qc-test-missing-binary']);
        return null;
      } catch (error) {
        if (!(error instanceof ExecError)) throw error;
        return { kind: error.kind, message: error.message, ...error.diagnostics };
      }
    });
    const expected = {
      kind: 'process',
      message: 'Cannot start gh. Is it installed?',
      code: null,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      truncated: false,
      durationMs: 0,
    };
    const { harness, dry, fixture } = runners(fixtures);
    const dryResult = await runWorkflow(workflow, { ...options('dry'), ...dry });
    expect(dryResult.output).toEqual(expected);
    expect((await runWorkflow(workflow, { ...options('fixture'), ...fixture })).output).toEqual(
      expected,
    );
    const report = harness.report(dryResult);
    expect(report.commands).toEqual([
      expect.objectContaining({
        stepId: 'probe',
        outputSource: 'fixture',
        fixtureIndex: 0,
        error: 'Cannot start gh. Is it installed?',
      }),
    ]);
    expect(report.staleExecFixtures).toEqual([]);
    expect(report.warnings.some((warning) => warning.startsWith('Commands are synthesized'))).toBe(
      false,
    );
  });

  it('retries a simulated timeout under retry.on transient and takes the attempt-2 result rule (AC1)', async () => {
    const fixtures = parseHarnessFixtures({ version: 1, calls: [], exec });
    const workflow = flaky({ maxAttempts: 2, delayMs: 1, on: ['transient'] });
    const { harness, dry, fixture } = runners(fixtures);
    const dryResult = await runWorkflow(workflow, { ...options('dry'), ...dry });
    expect(dryResult.output).toBe('recovered');
    expect(dryResult.steps['probe']?.attempts).toBe(2);
    expect(dryResult.steps['probe']?.attemptHistory?.[0]?.execError).toMatchObject({ code: null });
    expect(harness.report(dryResult).commands.map((entry) => entry.fixtureIndex)).toEqual([0, 1]);
    expect(harness.report(dryResult).commands[0]?.error).toBe('exceeded its 1000ms deadline.');
    expect(harness.report(dryResult).commands[1]?.error).toBeNull();
    const fixtureResult = await runWorkflow(workflow, { ...options('fixture'), ...fixture });
    expect(fixtureResult.output).toBe('recovered');
    expect(fixtureResult.steps['probe']?.attempts).toBe(2);
  });

  it('does not retry a timeout when retry.on excludes it', async () => {
    const fixtures = parseHarnessFixtures({ version: 1, calls: [], exec });
    const { dry } = runners(fixtures);
    await expect(
      runWorkflow(
        definition(z.string(), async (ctx) => {
          const result = await ctx.exec('probe', ['qc-test-missing-binary'], {
            retry: { maxAttempts: 2, delayMs: 1, on: ['process'] },
          });
          return result.stdout;
        }),
        { ...options('dry'), ...dry },
      ),
    ).rejects.toMatchObject({
      stepId: 'probe',
      message: expect.stringContaining('exceeded its 1000ms deadline.') as unknown,
    });
    expect((await readRun(options('dry'))).steps['probe']?.attempts).toBe(1);
  });

  it('settles an error rule under onError: return with its kind and null process fields (AC1)', async () => {
    const fixtures = parseHarnessFixtures({
      version: 1,
      calls: [],
      exec: [{ step: 'probe', error: 'exceeded its 1000ms deadline.', kind: 'timeout' }],
    });
    const workflow = definition(Settled, async (ctx) => {
      const result = await ctx.exec('probe', ['qc-test-missing-binary'], { onError: 'return' });
      return result.ok ? null : jsonValue(result.error);
    });
    const { dry, fixture } = runners(fixtures);
    const dryResult = await runWorkflow(workflow, { ...options('dry'), ...dry });
    expect(dryResult.output).toMatchObject({
      kind: 'timeout',
      message: 'exceeded its 1000ms deadline.',
      code: null,
      signal: null,
    });
    expect(dryResult.steps['probe']?.status).toBe('settled-failed');
    const fixtureResult = await runWorkflow(workflow, { ...options('fixture'), ...fixture });
    expect(fixtureResult.output).toEqual(dryResult.output);
  });

  it('rejects a matched error rule without calling the fallback runner (AC1)', async () => {
    const fixtures = parseHarnessFixtures({
      version: 1,
      calls: [],
      exec: [{ step: 'probe', error: 'Cannot start gh.' }],
    });
    let fallbackCalls = 0;
    const fallback = {
      run: () => {
        fallbackCalls += 1;
        return Promise.reject(new Error('fallback used'));
      },
    };
    const runner = new FixtureProcessRunner(fixtures, fallback);
    const invocation = { ...at('probe'), signal: new AbortController().signal };
    await expect(
      runner.run(request(['gh']), invocation as unknown as Parameters<typeof runner.run>[1]),
    ).rejects.toMatchObject({ kind: 'process', message: 'Cannot start gh.' });
    expect(fallbackCalls).toBe(0);
  });
});

describe('fixture export of exec results', () => {
  it('exports exec results with digests only and replays the same branch under dry-run (AC3)', async () => {
    const workflow = definition(z.string(), async (ctx) => {
      // Prints branch-a only when it really receives stdin and the environment overlay.
      const marker = await ctx.exec(
        'scope/marker',
        node(
          "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d.length>0&&process.env.QC_SECRET?'branch-a':'branch-b'))",
        ),
        { env: { QC_SECRET: 'env-secret-value' }, input: 'stdin-secret-text' },
      );
      const branch = marker.stdout.trim() === 'branch-a' ? 'A' : 'B';
      const data = await ctx.exec.json('data', node('console.log(JSON.stringify({n:3}))'), {
        schema: z.object({ n: z.number() }),
      });
      const status = await ctx.exec(
        'status',
        node("process.stderr.write('warn');process.exit(3)"),
        {
          okExitCodes: 'any',
        },
      );
      return `${branch}:${String(data.n)}:${String(status.code)}:${status.stderr}`;
    });
    const source = await runWorkflow(workflow, {
      ...options('source'),
      harness: new FixtureHarness({ version: 1, calls: [] }),
      processRunner: native,
    });
    expect(source.output).toBe('A:3:3:warn');
    const exported = await new WorkflowExecutor({
      typecheckCache,
      logger: new ThresholdLogger('silent', () => undefined),
    }).execute({ kind: 'workflow.fixtures', runId: 'source', stateDir });
    if (exported.kind !== 'workflow.fixtures.result') throw new Error(JSON.stringify(exported));
    const fixtures = exported.fixtures;
    const summary = (id: string) => source.steps[id]?.exec;
    expect(fixtures.calls).toEqual([]);
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([
      {
        step: 'scope/marker',
        argvPrefix: summary('scope/marker')?.command,
        envSha256: summary('scope/marker')?.envSha256,
        inputSha256: sha256('stdin-secret-text'),
        stdout: 'branch-a\n',
      },
      {
        step: 'data',
        argvPrefix: summary('data')?.command,
        envSha256: digest({}),
        inputSha256: sha256(''),
        json: { n: 3 },
      },
      expect.objectContaining({ step: 'status', stdout: '', stderr: 'warn', code: 3 }),
    ]);
    const text = JSON.stringify(fixtures);
    expect(text).not.toContain('env-secret-value');
    expect(text).not.toContain('stdin-secret-text');

    await writeFile(join(root, 'export.json'), text);
    const selection = await readHarnessSelection('fixture:export.json', undefined, root);
    const harness = new RehearsalHarness(selection);
    const replay = await runWorkflow(workflow, {
      ...options('replay'),
      harness,
      rehearsal: harness.hooks,
      processRunner: harness.processRunner,
    });
    expect(replay.output).toBe(source.output);
    const report = harness.report(replay);
    expect(report.commands.map((entry) => [entry.outputSource, entry.fixtureIndex])).toEqual([
      ['fixture', 0],
      ['fixture', 1],
      ['fixture', 2],
    ]);
    // Synthesis alone takes the other branch.
    const synthesized = new RehearsalHarness({ kind: 'cli', config: {} });
    const other = await runWorkflow(workflow, {
      ...options('synthesized'),
      harness: synthesized,
      rehearsal: synthesized.hooks,
      processRunner: synthesized.processRunner,
    });
    expect(other.output).toMatch(/^B:/u);
  });
});

describe('fixture export of settled and absorbed exec failures', () => {
  const executor = () =>
    new WorkflowExecutor({
      typecheckCache,
      logger: new ThresholdLogger('silent', () => undefined),
    });
  /** A source run with real processes, exported through the executor as the CLI does. */
  async function exportSource<T>(workflow: ReturnType<typeof definition<T>>) {
    const source = await runWorkflow(workflow, {
      ...options('source'),
      harness: new FixtureHarness({ version: 1, calls: [] }),
      processRunner: native,
    });
    const exported = await executor().execute({
      kind: 'workflow.fixtures',
      runId: 'source',
      stateDir,
    });
    if (exported.kind !== 'workflow.fixtures.result') throw new Error(JSON.stringify(exported));
    expect(fixturesFromRun(source)).toEqual(exported.fixtures);
    return { source, fixtures: exported.fixtures };
  }
  /** Replays under --dry-run (from the written file) and under --harness fixture, never spawning. */
  async function replays<T>(workflow: ReturnType<typeof definition<T>>, fixtures: HarnessFixtures) {
    await writeFile(join(root, 'export.json'), JSON.stringify(fixtures));
    const selection = await readHarnessSelection('fixture:export.json', undefined, root);
    const harness = new RehearsalHarness(selection);
    const dry = await runWorkflow(workflow, {
      ...options('dry'),
      harness,
      rehearsal: harness.hooks,
      processRunner: harness.processRunner,
    });
    const refuse = { run: () => Promise.reject(new Error('spawned a real command')) };
    const fixture = await runWorkflow(workflow, {
      ...options('fixture'),
      harness: new FixtureHarness(fixtures),
      processRunner: refuse,
      execRunner: new FixtureProcessRunner(fixtures, refuse),
    });
    return { dry, fixture, report: harness.report(dry) };
  }
  const key = (source: RunRecord, step: string) => ({
    step,
    argvPrefix: source.steps[step]?.exec?.command,
    envSha256: digest({}),
    inputSha256: sha256(''),
  });
  const Shape = z.object({ n: z.number() });
  type Failures = Record<'long' | 'plain', Record<string, unknown>>;

  it('exports settled exit and schema failures in seq order with completed commands, and replays the same errors (AC1, AC2, AC3, AC7)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      const before = await ctx.exec('before', node("process.stdout.write('first')"));
      const check = await ctx.exec(
        'check',
        node("process.stdout.write('out');process.stderr.write('err');process.exit(4)"),
        { onError: 'return', retry: { maxAttempts: 2, delayMs: 1 } },
      );
      const compact = await ctx.exec.json(
        'compact',
        node('process.stdout.write(JSON.stringify({n:"x"}))'),
        { schema: Shape, onError: 'return' },
      );
      const pretty = await ctx.exec.json(
        'pretty',
        node('console.log(JSON.stringify({n:"y"},null,2))'),
        { schema: Shape, onError: 'return' },
      );
      const exitJson = await ctx.exec.json(
        'exit-json',
        node('process.stdout.write(JSON.stringify({n:1}));process.exit(2)'),
        { schema: Shape, onError: 'return' },
      );
      const after = await ctx.exec('after', node("process.stderr.write('note');process.exit(3)"), {
        okExitCodes: [0, 3],
      });
      return {
        before: before.stdout,
        check: check.ok ? null : jsonValue(check.error),
        compact: compact.ok ? null : jsonValue(compact.error),
        pretty: pretty.ok ? null : jsonValue(pretty.error),
        exitJson: exitJson.ok ? null : jsonValue(exitJson.error),
        after: after.stderr,
      };
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toMatchObject({
      check: { kind: 'process', code: 4, attempts: 2, stdoutTail: 'out', stderrTail: 'err' },
      compact: { kind: 'schema', code: 0, parsed: { n: 'x' } },
      pretty: { kind: 'schema', parsed: { n: 'y' } },
      exitJson: { kind: 'process', code: 2, parsed: { n: 1 } },
    });
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([
      { ...key(source, 'before'), stdout: 'first' },
      { ...key(source, 'check'), stdout: 'out', stderr: 'err', code: 4 },
      // The tail is exactly the compact form of parsed.
      { ...key(source, 'compact'), json: { n: 'x' } },
      // Complete pretty-printed output keeps its bytes.
      { ...key(source, 'pretty'), stdout: '{\n  "n": "y"\n}\n' },
      { ...key(source, 'exit-json'), json: { n: 1 }, code: 2 },
      { ...key(source, 'after'), stdout: '', stderr: 'note', code: 3 },
    ]);

    const { dry, fixture, report } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
    expect(report.commands.map((entry) => [entry.stepId, entry.fixtureIndex])).toEqual([
      ['before', 0],
      ['check', 1],
      ['check', 1],
      ['compact', 2],
      ['pretty', 3],
      ['exit-json', 4],
      ['after', 5],
    ]);
    expect(report.staleExecFixtures).toEqual([]);
    expect(JSON.stringify(fixturesFromRun(dry))).toBe(JSON.stringify(fixtures));
    expect(JSON.stringify(fixturesFromRun(fixture))).toBe(JSON.stringify(fixtures));
  });

  it('exports long output as the recorded tail, and long pretty-printed JSON as json: parsed (AC2, AC7)', async () => {
    const big = { items: Array.from({ length: 80 }, (_, index) => ({ index, label: 'item' })) };
    const workflow = definition(z.json(), async (ctx) => {
      const plain = await ctx.exec(
        'plain',
        node("process.stdout.write('x'.repeat(3000)+'END');process.exit(1)"),
        { onError: 'return' },
      );
      const long = await ctx.exec.json(
        'long',
        node(`console.log(JSON.stringify(${JSON.stringify(big)},null,2))`),
        { schema: Shape, onError: 'return' },
      );
      return {
        plain: plain.ok ? null : jsonValue(plain.error),
        long: long.ok ? null : jsonValue(long.error),
      };
    });
    const { source, fixtures } = await exportSource(workflow);
    const plainTail = `${'x'.repeat(1021)}END`;
    expect(source.output).toMatchObject({ plain: { stdoutTail: plainTail } });
    expect(JSON.stringify(big, null, 2).length).toBeGreaterThan(1024);
    expect(fixtures.exec).toEqual([
      { ...key(source, 'plain'), stdout: plainTail, code: 1 },
      { ...key(source, 'long'), json: big },
    ]);

    const { dry, fixture } = await replays(workflow, fixtures);
    // The long JSON tail replays from the compact form of parsed, so only its whitespace differs.
    const { long: sourceLong, plain: sourcePlain } = source.output as Failures;
    for (const replay of [dry, fixture]) {
      const { long, plain } = replay.output as Failures;
      expect(plain).toEqual(sourcePlain);
      const { stdoutTail, ...rest } = long;
      const { stdoutTail: sourceTail, ...sourceRest } = sourceLong;
      expect(rest).toEqual(sourceRest);
      expect(stdoutTail).toBe(JSON.stringify(big).slice(-1024));
      expect(sourceTail).toBe(JSON.stringify(big, null, 2).concat('\n').slice(-1024));
      expect(JSON.stringify(fixturesFromRun(replay))).toBe(JSON.stringify(fixtures));
    }
  });

  it('exports no rule for an unparsed schema failure whose tail may be truncated, and keeps commands: fixture (AC2, AC6)', async () => {
    // An invalid prefix, more than 1024 whitespace characters, then schema-valid JSON: the stdout is
    // not JSON (no `parsed`), but its last 1024 characters are valid JSON that matches the schema.
    const hidden = `x${' '.repeat(1100)}{"n":1}`;
    const workflow = definition(z.json(), async (ctx) => {
      const long = await ctx.exec.json(
        'long',
        node(`process.stdout.write(${JSON.stringify(hidden)})`),
        { schema: Shape, onError: 'return' },
      );
      return long.ok ? 'ran' : long.error.kind;
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toBe('schema');
    expect(source.steps['long']?.status).toBe('settled-failed');
    expect(JSON.parse(hidden.slice(-1024))).toEqual({ n: 1 });
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });

    await writeFile(join(root, 'export.json'), JSON.stringify(fixtures));
    const selection = await readHarnessSelection('fixture:export.json', undefined, root);
    const harness = new RehearsalHarness(selection);
    await expect(
      runWorkflow(workflow, {
        ...options('dry'),
        harness,
        rehearsal: harness.hooks,
        processRunner: harness.processRunner,
      }),
    ).rejects.toMatchObject({
      stepId: 'long',
      message: expect.stringContaining('No exec fixture matches step long') as unknown,
    });
  });

  /** Replaying `fixtures` with `commands: 'fixture'` fails at `stepId` for lack of a matching rule. */
  async function expectReplayFailsAt(
    workflow: ReturnType<typeof definition<string>>,
    fixtures: HarnessFixtures,
    stepId: string,
  ) {
    await writeFile(join(root, 'export.json'), JSON.stringify(fixtures));
    const selection = await readHarnessSelection('fixture:export.json', undefined, root);
    const harness = new RehearsalHarness(selection);
    await expect(
      runWorkflow(workflow, {
        ...options('dry'),
        harness,
        rehearsal: harness.hooks,
        processRunner: harness.processRunner,
      }),
    ).rejects.toMatchObject({
      stepId,
      message: expect.stringContaining(`No exec fixture matches step ${stepId}`) as unknown,
    });
  }

  it('exports no rule for an absorbed exec.json exit failure whose full tail could replay as parsed, and keeps commands: fixture (AC2, AC5, AC6)', async () => {
    // Valid JSON longer than the 1024-character tail: the thrown ExecError keeps no `parsed`, but
    // the last 1024 characters are valid JSON, so replaying them would invent a `parsed` value.
    const padded = `${' '.repeat(1100)}{"n":1}`;
    const workflow = definition(z.string(), async (ctx) => {
      try {
        await ctx.exec.json(
          'probe',
          node(`process.stdout.write(${JSON.stringify(padded)});process.exit(1)`),
          {
            schema: Shape,
          },
        );
        return 'ran';
      } catch (error) {
        if (!(error instanceof ExecError)) throw error;
        return error.kind;
      }
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toBe('process');
    expect(source.steps['probe']?.status).toBe('failed');
    expect(JSON.parse(padded.slice(-1024))).toEqual({ n: 1 });
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });
    await expectReplayFailsAt(workflow, fixtures, 'probe');
  });

  it('exports no rule for a settled exec.json exit failure with invalid stdout and a full tail (AC2, AC6)', async () => {
    // Not JSON (so no `parsed`), but its last 1024 characters are valid JSON.
    const hidden = `x${' '.repeat(1100)}{"n":1}`;
    const workflow = definition(z.string(), async (ctx) => {
      const result = await ctx.exec.json(
        'probe',
        node(`process.stdout.write(${JSON.stringify(hidden)});process.exit(1)`),
        { schema: Shape, onError: 'return' },
      );
      return result.ok ? 'ran' : result.error.kind;
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toBe('process');
    expect(source.steps['probe']?.status).toBe('settled-failed');
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });
    await expectReplayFailsAt(workflow, fixtures, 'probe');
  });

  it('exports no rule for a settled exec.json exit failure recorded as truncated, and keeps commands: fixture (AC2, AC6)', async () => {
    // A custom runner can report a truncated capture whose short stdout is still complete JSON. The
    // runtime keeps no `parsed` for it, but replaying the tail would invent one.
    const workflow = definition(z.string(), async (ctx) => {
      const result = await ctx.exec.json(
        'probe',
        node('process.stdout.write(\'{"n":1}\');process.exit(1)'),
        { schema: Shape, onError: 'return' },
      );
      return result.ok ? 'ran' : result.error.kind;
    });
    const truncating = {
      run: async (...args: Parameters<typeof native.run>) => ({
        ...(await native.run(...args)),
        truncated: true,
      }),
    };
    const source = await runWorkflow(workflow, {
      ...options('source'),
      harness: new FixtureHarness({ version: 1, calls: [] }),
      processRunner: truncating,
    });
    expect(source.output).toBe('process');
    expect(source.steps['probe']?.status).toBe('settled-failed');
    expect(source.steps['probe']?.execError).toMatchObject({
      truncated: true,
      stdoutTail: '{"n":1}',
    });
    const fixtures = fixturesFromRun(source);
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });
    await expectReplayFailsAt(workflow, fixtures, 'probe');
  });

  it('exports no rule when json: parsed would serialize past the parsed byte bound (AC2, AC6)', async () => {
    // 15000 bytes as printed, which the runtime keeps as `parsed`, but 66000 bytes once each 1e20
    // is re-serialized as 100000000000000000000, so the replay would lose `parsed`.
    const printed = `[${'1e20,'.repeat(2999)}1e20]`;
    expect(Buffer.byteLength(printed)).toBeLessThan(16_384);
    const workflow = definition(z.string(), async (ctx) => {
      const result = await ctx.exec.json(
        'probe',
        node(`process.stdout.write(${JSON.stringify(printed)});process.exit(1)`),
        { schema: z.array(z.number()), onError: 'return' },
      );
      return result.ok
        ? 'ran'
        : `${result.error.kind}:${result.error.parsed === undefined ? 'none' : 'parsed'}`;
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toBe('process:parsed');
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(printed)))).toBeGreaterThan(16_384);
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });
    await expectReplayFailsAt(workflow, fixtures, 'probe');
  });

  it('still exports and replays an unparsed schema failure whose tail is under 1024 characters (AC2, AC7)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      const short = await ctx.exec.json('short', node("process.stdout.write('not json')"), {
        schema: Shape,
        onError: 'return',
      });
      return short.ok ? null : jsonValue(short.error);
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.output).toMatchObject({ kind: 'schema', stdoutTail: 'not json' });
    expect(fixtures).toMatchObject({
      commands: 'fixture',
      exec: [{ ...key(source, 'short'), stdout: 'not json' }],
    });
    const { dry, fixture } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
  });

  it('exports a failure the workflow absorbed with try/catch, and the replay catch sees the same error (AC5)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      try {
        await ctx.exec('probe', node("process.stderr.write('nope');process.exit(2)"));
        return null;
      } catch (error) {
        if (!(error instanceof ExecError)) throw error;
        return {
          kind: error.kind,
          message: error.message,
          code: error.diagnostics.code,
          signal: error.diagnostics.signal,
          stdoutTail: error.diagnostics.stdoutTail,
          stderrTail: error.diagnostics.stderrTail,
        };
      }
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.status).toBe('completed');
    expect(source.steps['probe']?.status).toBe('failed');
    expect(source.output).toEqual({
      kind: 'process',
      message: 'Command exited with 2.',
      code: 2,
      signal: null,
      stdoutTail: '',
      stderrTail: 'nope',
    });
    expect(fixtures).toMatchObject({
      commands: 'fixture',
      exec: [{ ...key(source, 'probe'), stdout: '', stderr: 'nope', code: 2 }],
    });
    const { dry, fixture } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
    expect(JSON.stringify(fixturesFromRun(dry))).toBe(JSON.stringify(fixtures));
  });

  it('exports no rule for a spawn failure but keeps commands: fixture, so the replay fails at that step (AC6)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      const missing = await ctx.exec('missing', ['qc-test-missing-binary'], { onError: 'return' });
      // An absorbed spawn failure has no process fields either.
      const absent = await ctx.exec('absent', ['qc-test-missing-binary']).then(
        () => 'ran',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );
      return [missing.ok ? 'ran' : missing.error.kind, absent];
    });
    const { source, fixtures } = await exportSource(workflow);
    expect(source.steps['missing']?.status).toBe('settled-failed');
    expect(source.steps['absent']?.status).toBe('failed');
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [], commands: 'fixture' });

    await writeFile(join(root, 'export.json'), JSON.stringify(fixtures));
    const selection = await readHarnessSelection('fixture:export.json', undefined, root);
    const harness = new RehearsalHarness(selection);
    await expect(
      runWorkflow(workflow, {
        ...options('dry'),
        harness,
        rehearsal: harness.hooks,
        processRunner: harness.processRunner,
      }),
    ).rejects.toMatchObject({
      stepId: 'missing',
      message: expect.stringContaining('No exec fixture matches step missing') as unknown,
    });
  });
});

describe('command fixtures under --harness fixture', () => {
  it('answers matched commands without spawning and runs unmatched ones for real (AC7)', async () => {
    const fixtures = parseHarnessFixtures({
      version: 1,
      calls: [],
      exec: [{ step: 'fixtured', argvPrefix: ['qc-test-missing-binary'], stdout: 'from fixture' }],
    });
    const workflow = definition(z.string(), async (ctx) => {
      const fixtured = await ctx.exec('fixtured', ['qc-test-missing-binary', 'arg']);
      const real = await ctx.exec('real', node("console.log('real')"));
      return `${fixtured.stdout}|${real.stdout.trim()}`;
    });
    const result = await runWorkflow(workflow, {
      ...options(),
      harness: new FixtureHarness(fixtures),
      processRunner: native,
      execRunner: new FixtureProcessRunner(fixtures, native),
    });
    expect(result.output).toBe('from fixture|real');

    const strict = { ...fixtures, commands: 'fixture' as const };
    await expect(
      runWorkflow(workflow, {
        ...options('strict'),
        harness: new FixtureHarness(strict),
        processRunner: native,
        execRunner: new FixtureProcessRunner(strict, native),
      }),
    ).rejects.toMatchObject({
      stepId: 'real',
      message: expect.stringContaining('No exec fixture matches step real:') as unknown,
    });
    const step = (await readRun(options('strict'))).steps['real'];
    expect(step?.status).toBe('failed');
    expect(step?.settledError).toBeUndefined();
  });
});

// Each case type-checks a workflow module that imports the engine source. measured: 1.3 s alone,
// 5.0 s in the full coverage run (dominated by the loader's TypeScript compile); CI's Node 22.13
// leg runs such compiles about 3.4x slower than local (replay-loader), so about 17 s there.
describe('merge-down-shaped rehearsal through the executor', { timeout: 40_000 }, () => {
  const workflowSource =
    () => `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
const Err = z.object({ error: z.string() });
const Prepared = z.object({ pr: z.number(), headRefOid: z.string() });
const Gate = z.object({ state: z.enum(['failure', 'success']), headRefOid: z.string() });
export default defineWorkflow({
  name: 'merge-down', version: '1', input: z.null(),
  output: z.object({ outcome: z.string(), rounds: z.number() }),
  async run(ctx) {
    const prepared = await ctx.exec.json('prepare', ['qc-test-gh', 'pr', 'view'], { schema: z.union([Err, Prepared]) });
    if ('error' in prepared) return { outcome: 'blocked', rounds: 0 };
    for (let round = 1; round <= 3; round++) {
      const gate = await ctx.exec.json('gate-' + String(round), ['qc-test-gh', 'pr', 'checks', String(prepared.pr)], { schema: Gate });
      if (gate.headRefOid !== prepared.headRefOid) return { outcome: 'head-moved', rounds: round };
      if (gate.state === 'success') {
        await ctx.exec('merge', ['qc-test-gh', 'pr', 'merge', String(prepared.pr)]);
        return { outcome: 'merged', rounds: round };
      }
      await ctx.claude.object('fix-' + String(round), { prompt: 'Fix the failing checks', schema: z.object({ fixed: z.boolean() }) });
    }
    return { outcome: 'exhausted', rounds: 3 };
  },
});
`;
  const fixtureFile = {
    version: 1,
    calls: [{ step: 'fix-*', output: { fixed: true } }],
    exec: [
      { step: 'prepare', json: { pr: 7, headRefOid: 'abc123' } },
      {
        step: 'gate-*',
        argvPrefix: ['qc-test-gh', 'pr', 'checks'],
        occurrence: 1,
        json: { state: 'failure', headRefOid: 'abc123' },
      },
      { step: 'gate-*', json: { state: 'success', headRefOid: 'abc123' } },
      { step: 'merge', argvPrefix: ['qc-test-gh', 'pr', 'merge'], stdout: 'merged\n' },
    ],
    commands: 'fixture',
  };
  async function execute(runId: string, extra: object) {
    const file = join(root, 'workflow.ts');
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
    await writeFile(file, workflowSource());
    await writeFile(join(root, 'f.json'), JSON.stringify(fixtureFile));
    const analysis = analyzeTypecheckEntrypoint(file, root);
    if (!analysis.ok) throw new Error('invalid workflow fixture');
    return new WorkflowExecutor({
      typecheckCache,
      logger: new ThresholdLogger('silent', () => undefined),
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId,
      stateDir,
      cwd: root,
      input: null,
      resume: false,
      harness: await readHarnessSelection('fixture:f.json', undefined, root),
      ...extra,
    });
  }

  it('rehearses to merged through a fix round and a gate round with exec rules and no stub script (AC1)', async () => {
    const result = await execute('dry', { dryRun: true });
    if (result.kind !== 'workflow.run.result' || !result.rehearsal)
      throw new Error(JSON.stringify(result));
    expect(result.run.output).toEqual({ outcome: 'merged', rounds: 2 });
    expect(
      result.rehearsal.commands.map((entry) => [
        entry.stepId,
        entry.outputSource,
        entry.fixtureIndex,
      ]),
    ).toEqual([
      ['prepare', 'fixture', 0],
      ['gate-1', 'fixture', 1],
      ['gate-2', 'fixture', 2],
      ['merge', 'fixture', 3],
    ]);
    expect(result.rehearsal.calls).toEqual([
      expect.objectContaining({ stepId: 'fix-1', outputSource: 'fixture', fixtureIndex: 0 }),
    ]);
    expect(result.rehearsal.staleExecFixtures).toEqual([]);
  });

  it('answers ctx.exec from the same rules under --harness fixture without spawning (AC7)', async () => {
    const result = await execute('live', {});
    if (result.kind !== 'workflow.run.result') throw new Error(JSON.stringify(result));
    expect(result.run.output).toEqual({ outcome: 'merged', rounds: 2 });
    expect(result.run.harness?.kind).toBe('fixture');
    expect(result.run.steps['merge']?.output).toMatchObject({ code: 0, stdout: 'merged\n' });
  });
});

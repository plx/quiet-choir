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
  type ExecResult,
  type HarnessFixtures,
  type JsonValue,
  type ProcessRunner,
  type ProcessRunRequest,
  type WorkflowContext,
  type WorkflowDeclaration,
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
/** A command a callback or observer issues through `context.exec`. */
const nestedRequest = (command: Command): ProcessRunRequest => ({
  ...request(command),
  nested: true,
});
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
    for (const call of [0, -1, 1.5]) expect(() => parse({ step: 'x', stdout: '', call })).toThrow();
    expect(parse({ step: 'x', stdout: '', call: 1 }).exec).toEqual([
      { step: 'x', stdout: '', call: 1 },
    ]);
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

  it('counts the nested commands of one parent as calls, per rule and independent of earlier rules', () => {
    const checks = [
      { step: 'parent', call: 1, stdout: 'a' },
      { step: 'parent', call: 2, stdout: 'b' },
      { step: 'parent', stdout: 'fallback' },
    ];
    const plain = rules(checks);
    const argv = ['gh', 'pr', 'checks'] as const;
    expect(plain.match(nestedRequest(argv), at('parent'))?.index).toBe(0);
    expect(plain.match(nestedRequest(argv), at('parent'))?.index).toBe(1);
    expect(plain.match(nestedRequest(argv), at('parent'))?.index).toBe(2);
    expect(plain.stale()).toEqual([]);
    // An earlier rule that wins a command does not stop the call rules from counting it.
    const shadowed = rules([{ step: 'parent', argvPrefix: ['gh'], stdout: 'special' }, ...checks]);
    expect(shadowed.match(nestedRequest(argv), at('parent'))?.index).toBe(0);
    expect(shadowed.stale()).toEqual([1, 2, 3]);
    const unshadowed = rules([
      { step: 'parent', argvPrefix: ['other'], stdout: 'special' },
      ...checks,
    ]);
    expect(unshadowed.match(nestedRequest(argv), at('parent'))?.index).toBe(1);
    expect(unshadowed.match(nestedRequest(argv), at('parent'))?.index).toBe(2);
  });

  it('counts only the commands an argv prefix admits, separately per attempt and per parent', () => {
    const entries = rules([
      { step: '*', argvPrefix: ['gh', 'pr', 'checks'], call: 2, stdout: 'second checks' },
      { step: '*', argvPrefix: ['gh', 'pr', 'checks'], call: 1, stdout: 'first checks' },
      { step: '*', stdout: 'other' },
    ]);
    const checks = nestedRequest(['gh', 'pr', 'checks']);
    const view = nestedRequest(['gh', 'pr', 'view']);
    expect(entries.match(checks, at('a'))?.index).toBe(1);
    // Other commands in between do not advance the count of the checks rules.
    expect(entries.match(view, at('a'))?.index).toBe(2);
    expect(entries.match(view, at('a'))?.index).toBe(2);
    expect(entries.match(checks, at('a'))?.index).toBe(0);
    expect(entries.match(checks, at('a'))?.index).toBe(2);
    // A retry reruns the callback, so its first command is call 1 again.
    expect(entries.match(checks, at('a', 2))?.index).toBe(1);
    expect(entries.match(checks, at('a', 2))?.index).toBe(0);
    // A different parent counts separately.
    expect(entries.match(checks, at('b'))?.index).toBe(1);
    expect(entries.match(checks, at('b'))?.index).toBe(0);
    expect(entries.stale()).toEqual([]);
  });

  it('combines call with attempt and occurrence, which still counts distinct parents', () => {
    const entries = rules([
      { step: 'p-*', occurrence: 2, call: 2, stdout: 'second parent, second command' },
      { step: 'p-*', attempt: 2, call: 1, stdout: 'retry, first command' },
      { step: 'p-*', stdout: 'fallback' },
    ]);
    const command = nestedRequest(['gh']);
    expect(entries.match(command, at('p-a'))?.index).toBe(2);
    expect(entries.match(command, at('p-a'))?.index).toBe(2);
    expect(entries.match(command, at('p-b'))?.index).toBe(2);
    expect(entries.match(command, at('p-b'))?.index).toBe(0);
    expect(entries.match(command, at('p-a', 2))?.index).toBe(1);
  });

  it('gives a ctx.exec effect call 1 always, so call 2 never matches it and is stale', () => {
    const entries = rules([
      { step: 'x', call: 2, stdout: 'second' },
      { step: 'x', call: 1, stdout: 'first' },
    ]);
    expect(entries.match(request(['a']), at('x', 1))?.index).toBe(1);
    expect(entries.match(request(['a']), at('x', 2))?.index).toBe(1);
    expect(entries.match(request(['a']), at('y'))).toBeUndefined();
    expect(entries.match(request(['a']), at('x', 3))?.index).toBe(1);
    expect(entries.stale()).toEqual([0]);
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
    expect(report.warnings).toContainEqual(
      expect.stringContaining('check their step, argvPrefix, digests, occurrence and call.'),
    );
  });

  it('answers two identical inner commands of one step from different call rules (AC1)', async () => {
    const { harness, run } = rehearsal({
      exec: [
        { step: 'parent', call: 1, stdout: 'pending' },
        { step: 'parent', call: 2, stdout: 'success' },
        { step: 'parent', call: 3, stdout: 'never reached' },
      ],
    });
    const result = await runWorkflow(
      definition(z.array(z.string()), (ctx) =>
        ctx.step('parent', {
          input: null,
          schema: z.array(z.string()),
          run: async (context) => [
            (await context.exec(['gh', 'pr', 'checks'])).stdout,
            (await context.exec(['gh', 'pr', 'checks'])).stdout,
          ],
        }),
      ),
      { ...options(), ...run },
    );
    expect(result.output).toEqual(['pending', 'success']);
    const report = harness.report(result);
    expect(report.commands).toEqual([
      expect.objectContaining({ stepId: 'parent', outputSource: 'fixture', fixtureIndex: 0 }),
      expect.objectContaining({ stepId: 'parent', outputSource: 'fixture', fixtureIndex: 1 }),
    ]);
    expect(report.staleExecFixtures).toEqual([2]);
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
  async function exportSource<T>(
    workflow: ReturnType<typeof definition<T>>,
    calls: HarnessFixtures['calls'] = [],
  ) {
    const source = await runWorkflow(workflow, {
      ...options('source'),
      harness: new FixtureHarness({ version: 1, calls }),
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

  it('exports an accepted nonzero exit without JSON as a stdout and code rule and replays kind process (#349)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      const failures: JsonValue[] = [];
      for (const [id, stdout] of [
        ['empty', ''],
        ['unclosed', '[{"n":1}'],
      ] as const) {
        const read = await ctx.exec.json(
          id,
          node(`process.stdout.write(${JSON.stringify(stdout)});process.exit(1)`),
          { schema: Shape, okExitCodes: [0, 1], onError: 'return' },
        );
        failures.push(read.ok ? null : jsonValue(read.error));
      }
      return failures;
    });
    const { source, fixtures } = await exportSource(workflow);
    const output = source.output as Record<string, unknown>[];
    expect(output).toHaveLength(2);
    for (const failure of output) {
      expect(failure).toMatchObject({ kind: 'process', code: 1 });
      expect(failure['message']).toMatch(/^Command exited with 1 without JSON on stdout: /u);
      expect(failure).not.toHaveProperty('parsed');
    }
    expect(fixtures).toMatchObject({
      commands: 'fixture',
      exec: [
        { ...key(source, 'empty'), stdout: '', code: 1 },
        { ...key(source, 'unclosed'), stdout: '[{"n":1}', code: 1 },
      ],
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

  /** A parent that declares `children` and settles each one under `onError: 'return'`. */
  const settledParent = (
    children: readonly WorkflowDeclaration[],
    frames: readonly (readonly [string, number])[],
  ) =>
    // Cast to the childless type the replay helpers take; declared children do not change how it runs.
    defineWorkflow({
      name: 'exec-fixtures',
      version: '1',
      input: z.null(),
      output: z.json(),
      children,
      async run(ctx) {
        const out: Record<string, unknown> = {};
        for (const [id, index] of frames) {
          const result = await ctx.workflow(id, children[index] as never, null, {
            onError: 'return',
          });
          out[id] = result.ok
            ? { ok: jsonValue(result.value) }
            : {
                kind: result.error.kind,
                message: result.error.message,
                stepId: result.error.stepId,
                attempts: result.error.attempts,
              };
        }
        return jsonValue(out);
      },
    }) as unknown as ReturnType<typeof definition<JsonValue>>;
  const kid = (name: string, run: (ctx: WorkflowContext) => Promise<unknown>) =>
    defineWorkflow({
      name,
      version: '1',
      input: z.null(),
      output: z.json(),
      run: async (ctx) => jsonValue(await run(ctx)),
    });
  const settledOutcomes = (run: RunRecord) =>
    Object.fromEntries(
      Object.entries(run.children ?? {})
        .filter(([, frame]) => frame.settled)
        .map(([id, frame]) => [id, frame.settled?.outcome]),
    );

  describe('inside settled child frames (#383)', () => {
    const innerKid = kid('inner-kid', (ctx) =>
      ctx.exec('probe', node("process.stderr.write('deep');process.exit(5)")),
    );
    const children = [
      kid('agent-kid', (ctx) => ctx.claude.text('ask', { prompt: 'x' })),
      kid('exec-kid', (ctx) =>
        ctx.exec('probe', node("process.stderr.write('nope');process.exit(2)")),
      ),
      kid('mixed-kid', async (ctx) => {
        const first = await ctx.claude.text('first', { prompt: 'x' });
        const broken = await ctx.codex.text('broken', { prompt: 'y' }).catch(() => 'caught');
        await ctx.exec('probe', node('process.exit(3)'));
        return [first, broken];
      }),
      defineWorkflow({
        name: 'outer-kid',
        version: '1',
        input: z.null(),
        output: z.json(),
        children: [innerKid],
        run: async (ctx) => jsonValue(await ctx.workflow('inner', innerKid, null)),
      }),
    ];
    const parent = settledParent(children, [
      ['a', 0],
      ['x', 1],
      ['m', 2],
      ['o', 3],
    ]);
    const sourceCalls: HarnessFixtures['calls'] = [
      { step: 'a/ask', error: 'boom', kind: 'rate-limit' },
      { step: 'm/first', text: 'one' },
      { step: 'm/broken', error: 'odd' },
    ];

    it('exports failed agent and exec steps inside settled child frames and replays the same settled errors (#383)', async () => {
      const { source, fixtures } = await exportSource(parent, sourceCalls);
      expect(source.status).toBe('completed');
      for (const id of ['a/ask', 'x/probe', 'm/broken', 'm/probe', 'o/inner/probe']) {
        expect(source.steps[id]?.status, id).toBe('failed');
      }
      expect(source.steps['m/first']?.status).toBe('completed');
      const expectedOutput = {
        a: { kind: 'rate-limit', message: 'Step a/ask: boom', stepId: 'a/ask', attempts: 1 },
        x: { kind: 'process', message: 'Command exited with 2.', stepId: 'x/probe', attempts: 1 },
        m: { kind: 'process', message: 'Command exited with 3.', stepId: 'm/probe', attempts: 1 },
        o: {
          kind: 'process',
          message: 'Command exited with 5.',
          stepId: 'o/inner/probe',
          attempts: 1,
        },
      };
      expect(source.output).toEqual(expectedOutput);
      const sourceOutcomes = settledOutcomes(source);
      expect(Object.keys(sourceOutcomes).sort()).toEqual(['a', 'm', 'o', 'x']);
      for (const outcome of Object.values(sourceOutcomes))
        expect(outcome).toMatchObject({ ok: false });

      expect(fixtures.commands).toBe('fixture');
      expect(fixtures.calls).toEqual([
        { step: 'a/ask', harness: 'claude', error: 'boom', kind: 'rate-limit' },
        {
          step: 'm/first',
          harness: 'claude',
          output: 'one',
          usage: { costUsd: null, inputTokens: null, outputTokens: null },
        },
        { step: 'm/broken', harness: 'codex', error: 'odd' },
      ]);
      expect(fixtures.exec).toEqual([
        { ...key(source, 'x/probe'), stdout: '', stderr: 'nope', code: 2 },
        { ...key(source, 'm/probe'), stdout: '', code: 3 },
        { ...key(source, 'o/inner/probe'), stdout: '', stderr: 'deep', code: 5 },
      ]);

      const { dry, fixture, report } = await replays(parent, fixtures);
      for (const replay of [dry, fixture]) {
        expect(replay.status).toBe('completed');
        expect(replay.output).toEqual(source.output);
        expect(settledOutcomes(replay)).toEqual(sourceOutcomes);
        expect(JSON.stringify(fixturesFromRun(replay))).toBe(JSON.stringify(fixtures));
      }
      expect(report.staleExecFixtures).toEqual([]);
      expect(report.staleCallFixtures).toEqual([]);
    });

    it('forks a run so that a settled frame reruns against the exported rules and settles the same errors (#383)', async () => {
      const { source, fixtures } = await exportSource(parent, sourceCalls);
      const refuse = { run: () => Promise.reject(new Error('spawned a real command')) };
      const fork = await runWorkflow(parent, {
        ...options('fork'),
        forkFrom: { runId: 'source', invalidate: ['a/*', 'x/*', 'm/*', 'o/**'] },
        harness: new FixtureHarness(fixtures),
        processRunner: refuse,
        execRunner: new FixtureProcessRunner(fixtures, refuse),
      });
      expect(fork.status).toBe('completed');
      expect(fork.output).toEqual(source.output);
      expect(settledOutcomes(fork)).toEqual(settledOutcomes(source));
    });
  });

  it('a settled frame whose failure export cannot reproduce fails the replay at that step instead of settling (#383)', async () => {
    const lonely = kid('lonely-kid', (ctx) => ctx.exec('missing', ['qc-test-missing-binary']));
    const workflow = settledParent([lonely], [['c', 0]]);
    const { source, fixtures } = await exportSource(workflow);
    expect(source.steps['c/missing']?.status).toBe('failed');
    expect(source.children?.['c']?.settled?.outcome).toMatchObject({
      ok: false,
      error: { stepId: 'c/missing' },
    });
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
      stepId: 'c/missing',
      message: expect.stringContaining('No exec fixture matches step c/missing') as unknown,
    });
    const replayed = await readRun({ stateDir, runId: 'dry' });
    expect(replayed.children?.['c']?.settled).toBeUndefined();
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

describe('fixture export of inner context.exec commands (#317)', () => {
  const reply = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    truncated: false,
    durationMs: 1,
    ...extra,
  });
  /** A source runner that answers each argv (joined by spaces) from a queue, then its last entry. */
  function scripted(answers: Record<string, (ExecResult | Error)[]>): ProcessRunner {
    const served = new Map<string, number>();
    return {
      run: (request) => {
        const name = Array.isArray(request.command)
          ? (request.command as readonly string[]).join(' ')
          : (request.command as { shell: string }).shell;
        const queue = answers[name];
        if (!queue) return Promise.reject(new Error(`unexpected command ${name}`));
        const index = served.get(name) ?? 0;
        served.set(name, index + 1);
        const answer = queue[Math.min(index, queue.length - 1)];
        return answer instanceof Error || answer === undefined
          ? Promise.reject(answer ?? new Error('no answer'))
          : Promise.resolve(answer);
      },
    };
  }
  /** Run the source with fake processes and export it through the executor, as the CLI does. */
  async function exportSource<T>(
    workflow: ReturnType<typeof definition<T>>,
    runner: ProcessRunner,
    extra: { readonly waitMode?: 'block' } = {},
  ) {
    const source = await runWorkflow(workflow, {
      ...options('source'),
      harness: new FixtureHarness({ version: 1, calls: [] }),
      processRunner: runner,
      ...extra,
    });
    const exported = await new WorkflowExecutor({
      typecheckCache,
      logger: new ThresholdLogger('silent', () => undefined),
    }).execute({ kind: 'workflow.fixtures', runId: 'source', stateDir });
    if (exported.kind !== 'workflow.fixtures.result') throw new Error(JSON.stringify(exported));
    expect(fixturesFromRun(source)).toEqual(exported.fixtures);
    return { source, fixtures: exported.fixtures };
  }
  /**
   * Replay under --dry-run (from the written file) and under fixture execution in suspend mode,
   * with a fallback runner that fails if anything reaches it, then check the re-exports.
   */
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
    const report = harness.report(dry);
    expect(report.staleExecFixtures).toEqual([]);
    expect(JSON.stringify(fixturesFromRun(dry))).toBe(JSON.stringify(fixtures));
    expect(JSON.stringify(fixturesFromRun(fixture))).toBe(JSON.stringify(fixtures));
    return { dry, fixture, report };
  }
  const key = (step: string, argv?: string[]) => ({
    step,
    ...(argv ? { argvPrefix: argv } : {}),
    envSha256: digest({}),
    inputSha256: sha256(''),
  });
  const State = z.object({ state: z.string() });

  it('exports a callback’s commands keyed by the parent, with call only on the repeated pair, and replays them (AC1, AC2)', async () => {
    const workflow = definition(z.json(), (ctx) =>
      ctx.step('gather', {
        input: null,
        schema: z.json(),
        run: async (context) => {
          const first = (await context.exec(['gh', 'pr', 'checks'])).stdout;
          const second = (await context.exec(['gh', 'pr', 'checks'])).stdout;
          const user = await context.exec(['gh', 'api', 'user'], { okExitCodes: 'any' });
          const view = await context.exec.json(['gh', 'pr', 'view'], { schema: State });
          return { first, second, user: `${String(user.code)}:${user.stderr}`, view };
        },
      }),
    );
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({
        'gh pr checks': [reply('pending'), reply('green')],
        'gh api user': [reply('', { code: 2, stderr: 'warn' })],
        'gh pr view': [reply('{"state":"OPEN"}')],
      }),
    );
    expect(source.output).toEqual({
      first: 'pending',
      second: 'green',
      user: '2:warn',
      view: { state: 'OPEN' },
    });
    expect(fixtures.calls).toEqual([]);
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([
      { ...key('gather', ['gh', 'pr', 'checks']), call: 1, stdout: 'pending' },
      { ...key('gather', ['gh', 'pr', 'checks']), call: 2, stdout: 'green' },
      { ...key('gather', ['gh', 'api', 'user']), stdout: '', stderr: 'warn', code: 2 },
      { ...key('gather', ['gh', 'pr', 'view']), stdout: '{"state":"OPEN"}' },
    ]);
    const { dry, fixture, report } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
    expect(report.commands.map((entry) => [entry.parentStepId, entry.fixtureIndex])).toEqual([
      ['gather', 0],
      ['gather', 1],
      ['gather', 2],
      ['gather', 3],
    ]);
  });

  it('exports only the terminal check of an observer poll and a command poll, and replays them on the first check (AC1, AC2)', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      const observed = await ctx.poll('ci', {
        input: null,
        schema: z.literal('success'),
        every: 1,
        timeoutMs: 60_000,
        observe: async (context) => {
          const checks = await context.exec.json(['gh', 'pr', 'checks'], { schema: State });
          return checks.state === 'success'
            ? { done: true, value: 'success' as const }
            : { done: false };
        },
      });
      const command = await ctx.poll('merged', {
        input: null,
        schema: z.literal('MERGED'),
        every: 1,
        timeoutMs: 60_000,
        command: ['gh', 'pr', 'view', '--json', 'state'],
        output: State,
        done: (output) =>
          output.state === 'MERGED' ? { done: true, value: 'MERGED' as const } : { done: false },
      });
      // The check counts differ in a replay, which completes on its first check.
      return [
        observed.by === 'poll' ? observed.value : null,
        command.by === 'poll' ? command.value : null,
      ];
    });
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({
        'gh pr checks': [
          reply('{"state":"pending"}'),
          reply('{"state":"pending"}'),
          reply('{"state":"success"}'),
        ],
        'gh pr view --json state': [reply('{"state":"OPEN"}'), reply('{"state":"MERGED"}')],
      }),
      { waitMode: 'block' },
    );
    expect(source.output).toEqual(['success', 'MERGED']);
    expect(source.steps['ci']?.output).toMatchObject({ by: 'poll', checks: 3 });
    expect(source.steps['merged']?.output).toMatchObject({ by: 'poll', checks: 2 });
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([
      { ...key('ci', ['gh', 'pr', 'checks']), stdout: '{"state":"success"}' },
      { ...key('merged', ['gh', 'pr', 'view', '--json', 'state']), stdout: '{"state":"MERGED"}' },
    ]);
    const { dry, fixture } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
    expect(fixture.steps['ci']?.output).toMatchObject({ by: 'poll', checks: 1 });
  });

  it('counts a shell rule’s calls over every command of the parent with its digests', async () => {
    const workflow = definition(z.json(), (ctx) =>
      ctx.step('shells', {
        input: null,
        schema: z.json(),
        run: async (context) => [
          (await context.exec({ shell: 'gh pr checks' })).stdout,
          (await context.exec(['gh', 'x'])).stdout,
          (await context.exec({ shell: 'gh pr checks' }, { env: { A: '1' } })).stdout,
          (await context.exec({ shell: 'gh pr checks' })).stdout,
        ],
      }),
    );
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({
        'gh pr checks': [reply('one'), reply('env'), reply('two')],
        'gh x': [reply('argv')],
      }),
    );
    expect(source.output).toEqual(['one', 'argv', 'env', 'two']);
    expect(fixtures.exec).toEqual([
      // The argv command meets a shell rule's filters too, so the second shell command is call 3.
      { ...key('shells'), call: 1, stdout: 'one' },
      { ...key('shells', ['gh', 'x']), stdout: 'argv' },
      { ...key('shells'), envSha256: digest({ A: '1' }), stdout: 'env' },
      { ...key('shells'), call: 3, stdout: 'two' },
    ]);
    const { dry, fixture } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
  });

  it('exports a retried step’s final attempt without an attempt pin, and replays absorbed and returned inner failures (AC2)', async () => {
    let attempts = 0;
    const workflow = definition(z.json(), async (ctx) => {
      const merged = await ctx.step('merge', {
        input: null,
        schema: z.string(),
        retry: { maxAttempts: 2, delayMs: 1 },
        run: async (context) => {
          attempts++;
          return (await context.exec(['gh', 'pr', 'merge'])).stdout;
        },
      });
      const absorbed = await ctx
        .step('rethrow', {
          input: null,
          schema: z.null(),
          run: async (context) => {
            await context.exec(['gh', 'fail']);
            return null;
          },
        })
        .then(
          () => null,
          (error: unknown) => {
            let cause: unknown = error;
            while (cause instanceof Error && !(cause instanceof ExecError)) cause = cause.cause;
            return cause instanceof ExecError
              ? { kind: cause.kind, message: cause.message, code: cause.diagnostics.code }
              : String(error);
          },
        );
      const returned = await ctx.step('settle', {
        input: null,
        schema: z.json(),
        run: async (context) => {
          const result = await context.exec.json(['gh', 'view'], {
            schema: State,
            onError: 'return',
          });
          return result.ok
            ? null
            : {
                kind: result.error.kind,
                message: result.error.message,
                code: result.error.code ?? null,
                parsed: result.error.parsed ?? null,
              };
        },
      });
      return { merged, absorbed, returned };
    });
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({
        'gh pr merge': [reply('', { code: 1, stderr: 'not yet' }), reply('merged')],
        'gh fail': [reply('', { code: 3, stderr: 'boom' })],
        'gh view': [reply('{"state":1}')],
      }),
    );
    expect(attempts).toBe(2);
    expect(source.status).toBe('completed');
    expect(source.steps['merge']?.innerCommands?.attempt).toBe(2);
    expect(source.steps['rethrow']?.status).toBe('failed');
    expect(source.output).toMatchObject({
      merged: 'merged',
      absorbed: { kind: 'process', message: 'Command exited with 3.', code: 3 },
      returned: { kind: 'schema', code: 0, parsed: { state: 1 } },
    });
    expect(fixtures.exec).toEqual([
      { ...key('merge', ['gh', 'pr', 'merge']), stdout: 'merged' },
      { ...key('rethrow', ['gh', 'fail']), stdout: '', stderr: 'boom', code: 3 },
      { ...key('settle', ['gh', 'view']), stdout: '{"state":1}' },
    ]);
    attempts = 0;
    const { dry, fixture } = await replays(workflow, fixtures);
    expect(dry.output).toEqual(source.output);
    expect(fixture.output).toEqual(source.output);
    // Each replay's merge took one attempt: the final attempt's answer replays on attempt 1.
    expect(attempts).toBe(2);
    expect(fixture.steps['merge']?.attempts).toBe(1);
  });

  it('exports no rule for a spawn failure, a timeout or a truncated result, but keeps commands: fixture', async () => {
    const workflow = definition(z.json(), (ctx) =>
      ctx.step('probe', {
        input: null,
        schema: z.json(),
        run: async (context) => {
          const missing = await context.exec(['gh', 'missing'], { onError: 'return' });
          const slow = await context.exec(['gh', 'slow'], { onError: 'return' });
          const big = await context.exec(['gh', 'big']);
          const fine = await context.exec(['gh', 'fine']);
          return [
            missing.ok ? 'ran' : missing.error.kind,
            slow.ok ? 'ran' : slow.error.kind,
            big.truncated,
            fine.stdout,
          ];
        },
      }),
    );
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({
        'gh missing': [Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })],
        'gh slow': [Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
        'gh big': [reply('head...tail', { truncated: true })],
        'gh fine': [reply('ok')],
      }),
    );
    expect(source.output).toEqual(['process', 'timeout', true, 'ok']);
    expect(
      source.steps['probe']?.innerCommands?.commands.map((entry) => entry.error?.kind),
    ).toEqual(['process', 'timeout', undefined, undefined]);
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([{ ...key('probe', ['gh', 'fine']), stdout: 'ok' }]);
    const refuse = { run: () => Promise.reject(new Error('spawned a real command')) };
    await expect(
      runWorkflow(workflow, {
        ...options('fixture'),
        harness: new FixtureHarness(fixtures),
        processRunner: refuse,
        execRunner: new FixtureProcessRunner(fixtures, refuse),
      }),
    ).rejects.toThrow('No exec fixture matches step probe: ["gh","missing"]');
  });

  it('exports only the recorded prefix past the command bound', async () => {
    const workflow = definition(z.null(), (ctx) =>
      ctx.step('loop', {
        input: null,
        schema: z.null(),
        run: async (context) => {
          for (let index = 0; index <= 256; index++) await context.exec(['gh', String(index)]);
          return null;
        },
      }),
    );
    const runner: ProcessRunner = { run: () => Promise.resolve(reply('x')) };
    const { source, fixtures } = await exportSource(workflow, runner);
    expect(source.steps['loop']?.innerCommands?.omitted).toBe(1);
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toHaveLength(256);
    // An incomplete record pins every rule with call, unique or not.
    expect(fixtures.exec?.at(-1)).toEqual({ ...key('loop', ['gh', '255']), call: 1, stdout: 'x' });
  });

  it('pins a retained command with call when the byte bound omitted an identical later one, so the replay fails at the parent', async () => {
    const workflow = definition(z.json(), (ctx) =>
      ctx.step('diff', {
        input: null,
        schema: z.json(),
        run: async (context) => [
          (await context.exec(['gh', 'pr', 'diff'])).stdout.length,
          (await context.exec(['gh', 'pr', 'diff'])).stdout.length,
        ],
      }),
    );
    const big = 'x'.repeat(1_048_577);
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({ 'gh pr diff': [reply('small'), reply(big)] }),
    );
    expect(source.output).toEqual([5, big.length]);
    expect(source.steps['diff']?.innerCommands?.omitted).toBe(1);
    expect(fixtures.commands).toBe('fixture');
    expect(fixtures.exec).toEqual([
      { ...key('diff', ['gh', 'pr', 'diff']), call: 1, stdout: 'small' },
    ]);
    const refuse = { run: () => Promise.reject(new Error('spawned a real command')) };
    await expect(
      runWorkflow(workflow, {
        ...options('fixture'),
        harness: new FixtureHarness(fixtures),
        processRunner: refuse,
        execRunner: new FixtureProcessRunner(fixtures, refuse),
      }),
    ).rejects.toThrow('No exec fixture matches step diff: ["gh","pr","diff"]');
  });

  it(
    'keeps the commands of the observation that completed the wait, not those of a later-resolving abandoned one',
    // measured: about 2.1 s alone (the fixed 2 s observer grace before the first is abandoned)
    { timeout: 10_000 },
    async () => {
      let observations = 0;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const workflow = definition(z.json(), async (ctx) => {
        const outcome = await ctx.wait('ci', {
          deadline: Date.now() + 60_000,
          // A signal source makes each check scan the inbox, so the abandoned observation settles
          // between the accepted one's result and the wait's completion save.
          signal: { prompt: 'Override?', schema: z.null() },
          poll: {
            input: null,
            schema: z.string(),
            every: 1,
            observeTimeoutMs: 50,
            onError: { tolerate: 1, retryAfterMs: () => 0 },
            observe: async (context) => {
              const own = ++observations;
              const { stdout } = await context.exec(['gh', 'pr', 'checks']);
              // The first ignores its aborted signal, so it is abandoned and the timeout tolerated;
              // it resolves done only after the second check has returned its own result.
              if (own === 1) await released;
              else setImmediate(release);
              return { done: true as const, value: stdout };
            },
          },
        });
        return outcome.by === 'poll' ? outcome.value : null;
      });
      const { source, fixtures } = await exportSource(
        workflow,
        scripted({ 'gh pr checks': [reply('stale'), reply('fresh')] }),
        { waitMode: 'block' },
      );
      expect(source.output).toBe('fresh');
      expect(source.steps['ci']?.output).toMatchObject({ by: 'poll', checks: 2 });
      expect(fixtures.exec).toEqual([{ ...key('ci', ['gh', 'pr', 'checks']), stdout: 'fresh' }]);
    },
  );

  it('exports nothing for a wait that ended by deadline, and no commands key without commands', async () => {
    const workflow = definition(z.json(), async (ctx) => {
      await ctx.step('quiet', { input: null, schema: z.null(), run: () => Promise.resolve(null) });
      const late = await ctx.poll('late', {
        input: null,
        schema: z.null(),
        every: 1,
        timeoutMs: 30,
        observe: async (context) => {
          await context.exec(['gh', 'never']);
          return { done: false };
        },
      });
      return late.by;
    });
    const { source, fixtures } = await exportSource(
      workflow,
      scripted({ 'gh never': [reply('no')] }),
      { waitMode: 'block' },
    );
    expect(source.output).toBe('deadline');
    expect(fixtures).toEqual({ version: 1, unmatched: 'error', calls: [] });
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

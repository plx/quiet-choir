import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
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
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import { RehearsalHarness } from '../src/workflow/loader/rehearsal.js';
import { digest } from '../src/workflow/runtime/json.js';
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

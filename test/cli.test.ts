import { resolveStateDir } from '../src/index.js';
import WorkflowList from '../src/commands/workflow/list.js';
import { summarizeRun } from '../src/workflow/loader/inspection.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import { capabilityManifest } from '../src/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { ExitError } from '@oclif/core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConfigurationGet from '../src/commands/configuration/get.js';
import ConfigurationSet from '../src/commands/configuration/set.js';
import InfoVersion from '../src/commands/info/version.js';
import WorkflowAnswer from '../src/commands/workflow/answer.js';
import WorkflowExecute from '../src/commands/workflow/execute.js';
import WorkflowInspect from '../src/commands/workflow/inspect.js';
import WorkflowCheckResume from '../src/commands/workflow/check-resume.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';
import WorkflowTypecheck from '../src/commands/workflow/typecheck.js';
import { TypeScriptExecutor } from '../src/workflow/typecheck/typescript-executor.js';
import WorkflowValidate from '../src/commands/workflow/validate.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];

interface RunnableCommand {
  run(argv: string[], options: { root: string }): Promise<unknown>;
}

interface CapturedCommand {
  readonly error: unknown;
  readonly stderr: string;
  readonly stdout: string;
}

async function captureCommand(
  command: RunnableCommand,
  argv: string[] = [],
): Promise<CapturedCommand> {
  const standardOutput: string[] = [];
  const standardError: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    standardOutput.push(typeof message === 'string' ? message : inspect(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    standardError.push(typeof message === 'string' ? message : inspect(message));
  });

  let error: unknown;
  try {
    await command.run(argv, { root: projectRoot });
  } catch (caught: unknown) {
    error = caught;
  }

  return {
    error,
    stderr: standardError.join('\n'),
    stdout: standardOutput.join('\n'),
  };
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('stub command adapters', () => {
  it.each([
    [ConfigurationGet, 'configuration get'],
    [ConfigurationSet, 'configuration set'],
  ] as const)('runs %s through a plan and executor', async (command, commandName) => {
    const output = await captureCommand(command);

    expect(output.error).toBeInstanceOf(ExitError);
    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stdout).toBe(`${commandName} is not implemented yet.`);
    expect(output.stderr).toBe('');
  });

  it('maps --verbose to trace logging', async () => {
    const output = await captureCommand(ConfigurationGet, ['--verbose']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('[trace] Executing plan for configuration.get');
  });

  it('accepts an explicit inherited log level', async () => {
    const output = await captureCommand(ConfigurationGet, ['--log-level', 'debug']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('');
  });

  it('rejects mutually exclusive verbosity flags', async () => {
    const output = await captureCommand(ConfigurationGet, ['--verbose', '--log-level', 'debug']);

    expect(output.error).toBeInstanceOf(Error);
    if (output.error instanceof Error) {
      expect(output.error.message).toContain('cannot also be provided');
    }
  });
});

describe('implemented command adapters', () => {
  it('reports the package version through a plan and executor', async () => {
    const output = await captureCommand(InfoVersion);

    expect(output.error).toBeUndefined();
    expect(output.stdout).toBe('0.0.0');
  });

  it('type-checks a valid entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.ts');
    await writeFile(entrypoint, 'export const value: number = 1;\n', 'utf8');

    const output = await captureCommand(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toBeUndefined();
    expect(output.stdout).toContain('Type check passed');
    expect(output.stderr).toBe('');
  });

  it('renders compiler errors and exits four', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.ts');
    await writeFile(entrypoint, "const count: number = 'wrong';\n", 'utf8');

    const output = await captureCommand(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toBeInstanceOf(ExitError);
    expect(output.error).toMatchObject({ oclif: { exit: 4 } });
    expect(output.stderr).toContain('error TS2322');
    expect(output.stderr).toContain('Type check failed with 1 error.');
  });

  it('rejects unsupported source extensions during plan analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.js');
    await writeFile(entrypoint, 'export const value = 1;\n', 'utf8');

    const output = await captureCommand(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toMatchObject({
      code: 'usage.entrypoint',
      oclif: { exit: 2 },
    });
  });

  it.each([false, true])(
    'reports a first signal during a successful type check as interrupted (JSON=%s)',
    async (json) => {
      const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
      temporaryDirectories.push(root);
      const entrypoint = join(root, 'workflow.ts');
      await writeFile(entrypoint, 'export const value: number = 1;\n', 'utf8');
      const check = TypeScriptExecutor.prototype.execute.bind(
        new TypeScriptExecutor({ log: () => undefined }),
      );
      vi.spyOn(TypeScriptExecutor.prototype, 'execute').mockImplementation((plan) => {
        process.emit('SIGINT');
        return check(plan);
      });

      const output = await captureCommand(WorkflowTypecheck, [
        entrypoint,
        ...(json ? ['--json'] : []),
      ]);

      expect(output.error).toMatchObject({ oclif: { exit: 130 } });
      expect(output.stdout).not.toContain('Type check passed');
      if (json)
        expect(JSON.parse(output.stdout)).toMatchObject({
          kind: 'workflow.error',
          ok: false,
          exitCode: 130,
          error: { code: 'workflow.interrupted' },
        });
    },
  );

  it('uses oclif file validation for missing entrypoints', async () => {
    const output = await captureCommand(WorkflowTypecheck, ['/definitely/missing/workflow.ts']);

    expect(output.error).toBeInstanceOf(Error);
    if (output.error instanceof Error) {
      expect(output.error.message).toContain('No file found');
    }
  });
});

async function workflowFile(extension = 'ts'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
  temporaryDirectories.push(root);
  const file = join(root, `workflow.${extension}`);
  await writeFile(file, 'export default {};\n');
  return file;
}

const runRecord = {
  formatVersion: 1,
  id: 'test-run',
  status: 'completed',
  workflow: { name: 'test', version: '1', fingerprint: null },
  cwd: projectRoot,
  input: {},
  output: 42,
  error: null,
  steps: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies RunRecord;

const failedResult = workflowFailure('load.typecheck', 'Workflow type check failed.', {
  diagnostics: [
    {
      category: 'error',
      code: 2322,
      column: 1,
      filePath: null,
      line: null,
      message: 'Wrong type.',
      relatedInformation: [],
    },
  ],
});

describe('workflow lifecycle command adapters', () => {
  it.each([false, true])('validates and renders metadata (JSON=%s)', async (json) => {
    const file = await workflowFile();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.validate.result',
      ok: true,
      entrypoint: file,
      workflow: {
        harnesses: [],
        name: 'test',
        version: '1',
        fingerprint: 'hash',
        capabilities: capabilityManifest({}),
        description: null,
        whenToUse: null,
        phases: [],
        inputSchema: {},
        outputSchema: {},
        profiles: {},
        children: [],
        recursive: false,
        entrypoint: file,
      },
    });
    const output = await captureCommand(WorkflowValidate, [file, ...(json ? ['--json'] : [])]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workflow.validate' }));
    expect(output.stdout).toContain(json ? '"fingerprint":"hash"' : 'Validated test@1');
  });

  it.each([WorkflowValidate, WorkflowExecute])(
    'reports type errors before execution for %s',
    async (command) => {
      const file = await workflowFile();
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failedResult);
      const output = await captureCommand(command, [file]);
      expect(output.error).toMatchObject({ oclif: { exit: 4 } });
      expect(output.stderr).toContain('TS2322');
    },
  );

  it.each([WorkflowValidate, WorkflowExecute])(
    'rejects unsupported extensions for %s',
    async (command) => {
      const file = await workflowFile('js');
      const output = await captureCommand(command, [file]);
      expect(output.error).toMatchObject({
        code: 'usage.entrypoint',
        oclif: { exit: 2 },
      });
    },
  );

  it('requires valid JSON input and a resume identifier', async () => {
    const file = await workflowFile();
    const invalid = await captureCommand(WorkflowExecute, [file, '--input', '{nope}']);
    expect(invalid.error).toMatchObject({
      oclif: { exit: 2 },
      message: expect.stringContaining('--input must contain valid JSON.') as unknown,
    });
    const missingId = await captureCommand(WorkflowExecute, [file, '--resume']);
    expect(missingId.error).toBeInstanceOf(Error);
  });

  it.each([false, true])('executes with JSON input and renders a run (JSON=%s)', async (json) => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const output = await captureCommand(WorkflowExecute, [
      file,
      '--input',
      '{"value":2}',
      '--run-id',
      'test-run',
      ...(json ? ['--json'] : []),
    ]);
    expect(output.error).toBeUndefined();
    expect(output.stderr).toBe(
      `Run ID: test-run\nState directory: ${resolveStateDir({ runId: 'test-run' })}`,
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { value: 2 }, runId: 'test-run', resume: false }),
    );
    expect(output.stdout).toContain(json ? '"output":42' : 'Run test-run completed.');
  });

  it('passes positive agent limits as plain execution policy and rejects malformed values before execution', async () => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const valid = await captureCommand(WorkflowExecute, [
      file,
      '--max-agents',
      '5',
      '--provider-limit',
      'codex=1',
      '--provider-limit',
      'claude=2',
    ]);
    expect(valid.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ agentLimits: { total: 5, perProvider: { codex: 1, claude: 2 } } }),
    );
    execute.mockClear();
    for (const args of [
      ['--max-agents', '0'],
      ['--max-agents', '1.5'],
      ['--provider-limit', 'codex=0'],
      ['--provider-limit', 'codex=9007199254740992'],
    ]) {
      const invalid = await captureCommand(WorkflowExecute, [file, ...args]);
      expect(invalid.error).toMatchObject({ oclif: { exit: 2 } });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'prints cleanup warnings to stderr without failing the completed run (JSON=%s)',
    async (json) => {
      const file = await workflowFile();
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
        kind: 'workflow.run.result',
        ok: true,
        run: { ...runRecord, warnings: ['Could not release run test-run lock: EACCES'] },
      });
      const output = await captureCommand(WorkflowExecute, [
        file,
        '--run-id',
        'test-run',
        ...(json ? ['--json'] : []),
      ]);
      expect(output.error).toBeUndefined();
      expect(output.stderr).toContain('Warning: Could not release run test-run lock: EACCES');
      expect(output.stdout).toContain(json ? '"status":"completed"' : 'Run test-run completed.');
    },
  );

  it('preserves saved input on resume and removes signal handlers', async () => {
    const file = await workflowFile();
    const interruptListeners = process.listenerCount('SIGINT');
    const terminateListeners = process.listenerCount('SIGTERM');
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const output = await captureCommand(WorkflowExecute, [
      file,
      '--run-id',
      'test-run',
      '--resume',
    ]);
    expect(output.error).toBeUndefined();
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('input');
    expect(process.listenerCount('SIGINT')).toBe(interruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(terminateListeners);
  });

  it('uses exit 130 on cooperative cancellation', async () => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve(workflowFailure('workflow.interrupted', 'Cancelled'));
    });
    const output = await captureCommand(WorkflowExecute, [file]);
    expect(output.error).toMatchObject({ oclif: { exit: 130 } });
  });

  it('keeps exit 1 for a saved failed checkpoint when a signal also arrives', async () => {
    const file = await workflowFile();
    const run = { ...runRecord, status: 'failed', error: 'application failure' } as const;
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve(workflowFailure('workflow.failed', 'application failure', { run }));
    });
    const output = await captureCommand(WorkflowExecute, [file, '--json']);
    expect(output.error).toMatchObject({ oclif: { exit: 1 } });
    expect(JSON.parse(output.stdout)).toMatchObject({
      exitCode: 1,
      error: { code: 'workflow.failed' },
      run: { status: 'failed' },
    });
  });

  it('keeps a saved completion successful when a signal arrives after the last check', async () => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve({ kind: 'workflow.run.result', ok: true, run: runRecord });
    });
    const output = await captureCommand(WorkflowExecute, [file, '--run-id', 'test-run', '--json']);
    expect(output.error).toBeUndefined();
    expect(JSON.parse(output.stdout)).toMatchObject({ id: 'test-run', status: 'completed' });
  });

  it('keeps a durably queued answer successful when a signal arrives after delivery', async () => {
    const delivery = {
      runId: 'test-run',
      stepId: 'approve',
      path: '/state/test-run.inbox/approve.answer.json',
      questionFingerprint: 'fp',
    };
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve({ kind: 'workflow.answer.result', ok: true, delivery });
    });
    const output = await captureCommand(WorkflowAnswer, ['test-run', 'approve', '--json', 'true']);
    expect(output.error).toBeUndefined();
    expect(JSON.parse(output.stdout)).toMatchObject({ kind: 'workflow.answer.result', delivery });
  });

  it.each([false, true])(
    'reports a first signal during a successful inspect as interrupted (JSON=%s)',
    async (json) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
      temporaryDirectories.push(stateDir);
      await writeFile(join(stateDir, 'test-run.json'), JSON.stringify(runRecord));
      const ownership = { locked: false, owner: null, processes: [] };
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
        process.emit('SIGINT');
        return Promise.resolve({
          kind: 'workflow.run.result',
          ok: true,
          run: runRecord,
          ownership,
          summary: summarizeRun(runRecord, ownership),
        });
      });
      const output = await captureCommand(WorkflowInspect, [
        'test-run',
        '--state-dir',
        stateDir,
        ...(json ? ['--json'] : []),
      ]);
      expect(output.error).toMatchObject({ oclif: { exit: 130 } });
      expect(output.stdout).not.toContain('Steps: 0');
      if (json)
        expect(JSON.parse(output.stdout)).toMatchObject({
          exitCode: 130,
          error: { code: 'workflow.interrupted', message: 'Workflow interrupted.' },
          runId: 'test-run',
          stateDir,
          status: 'completed',
        });
    },
  );

  it.each([false, true])('inspects a run without a source file (JSON=%s)', async (json) => {
    const run = {
      ...runRecord,
      harnesses: { codex: { binary: 'codex', version: '0.157.1' } },
      harnessWarnings: ['native version changed'],
    };
    const ownership = { locked: false, owner: null, processes: [] };
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run,
      ownership,
      summary: summarizeRun(run, ownership),
    });
    const output = await captureCommand(WorkflowInspect, ['test-run', ...(json ? ['--json'] : [])]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.inspect', runId: 'test-run' }),
    );
    expect(output.stdout).toContain(json ? '"output":42' : 'Steps: 0');
    expect(output.stdout).toContain(json ? '"version":"0.157.1"' : 'Harness codex: codex@0.157.1');
    expect(output.stdout).toContain('native version changed');
  });

  it('renders failure metadata and missing-run errors', async () => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: { ...runRecord, status: 'failed', error: 'Effect failed.' },
      ownership: { locked: false, owner: null, processes: [] },
      summary: summarizeRun(
        { ...runRecord, status: 'failed', error: 'Effect failed.' },
        { locked: false, owner: null, processes: [] },
      ),
    });
    const failed = await captureCommand(WorkflowInspect, ['test-run']);
    expect(failed.stdout).toContain('Effect failed.');
    execute.mockResolvedValue(workflowFailure('run.not_found', 'Run does not exist.'));
    const missing = await captureCommand(WorkflowInspect, ['missing']);
    expect(missing.error).toMatchObject({ oclif: { exit: 3 }, message: 'Run does not exist.' });
  });
});

describe('recovery command adapters', () => {
  it.each([false, true])(
    'prints a compatibility report and uses its exit status (compatible=%s)',
    async (compatible) => {
      const file = await workflowFile();
      const check = {
        compatible,
        changed: compatible ? [] : ['code'],
        unchanged: ['name'],
        files: [],
        fingerprint: 'new',
        savedFingerprint: 'old',
        canAcceptCodeChange: true,
        refinalizable: true,
        message: 'compatibility report',
      };
      const execute = vi
        .spyOn(WorkflowExecutor.prototype, 'execute')
        .mockResolvedValue(
          compatible
            ? { kind: 'workflow.check-resume.result', ok: true, check }
            : workflowFailure('run.incompatible', check.message, { details: check }),
        );
      const output = await captureCommand(WorkflowCheckResume, [
        file,
        '--run-id',
        'r',
        '--json',
        '--accept-code-change',
      ]);
      expect(JSON.parse(output.stdout)).toMatchObject(
        compatible ? { check } : { error: { code: 'run.incompatible', details: check } },
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workflow.check-resume', acceptCodeChange: true }),
      );
      if (compatible) expect(output.error).toBeUndefined();
      else expect(output.error).toMatchObject({ oclif: { exit: 3 } });
    },
  );

  it.each([false, true])('reports check-resume load failures (JSON=%s)', async (json) => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failedResult);
    const output = await captureCommand(WorkflowCheckResume, [
      file,
      '--run-id',
      'r',
      ...(json ? ['--json'] : []),
    ]);
    expect(output.error).toMatchObject({ oclif: { exit: 4 } });
    if (json) expect(JSON.parse(output.stdout)).toMatchObject({ ok: false });
    else expect(output.stderr).toContain('TS2322');
  });

  it('passes explicit fork and replay options as data and inherits source input when omitted', async () => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const fork = await captureCommand(WorkflowExecute, [
      file,
      '--run-id',
      'new',
      '--fork-from',
      'old',
      '--fork-state-dir',
      projectRoot,
      '--reuse',
      'matching',
      '--invalidate',
      'reports/**',
      '--strict-replay',
    ]);
    expect(fork.error).toBeUndefined();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      forkFrom: {
        runId: 'old',
        stateDir: projectRoot,
        reuse: 'matching',
        invalidate: ['reports/**'],
      },
      strictReplay: true,
    });
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('input');
    const resume = await captureCommand(WorkflowExecute, [
      file,
      '--run-id',
      'old',
      '--resume',
      '--accept-code-change',
    ]);
    expect(resume.error).toBeUndefined();
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ resume: true, acceptCodeChange: true });
  });

  it('rejects incompatible recovery flags and detached fork modifiers', async () => {
    const file = await workflowFile();
    for (const flags of [
      ['--resume', '--fork-from', 'old'],
      ['--accept-code-change'],
      ['--reuse', 'matching'],
      ['--invalidate', 'a'],
    ]) {
      expect(
        (await captureCommand(WorkflowExecute, [file, '--run-id', 'new', ...flags])).error,
      ).toBeInstanceOf(Error);
    }
    const bad = await captureCommand(WorkflowCheckResume, [
      await workflowFile('js'),
      '--run-id',
      'r',
    ]);
    expect(bad.error).toMatchObject({ oclif: { exit: 2 } });
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.check-resume.result',
      ok: true,
      check: {
        compatible: true,
        changed: [],
        unchanged: [],
        files: [],
        fingerprint: 'same',
        savedFingerprint: 'same',
        canAcceptCodeChange: true,
        refinalizable: false,
        message: 'compatible',
      },
    });
    expect((await captureCommand(WorkflowCheckResume, [file, '--run-id', 'r'])).stdout).toBe(
      'compatible',
    );
  });
});

describe('monitoring command adapters', () => {
  it.each([false, true])('lists and filters saved runs (JSON=%s)', async (json) => {
    const summary = summarizeRun(runRecord, { locked: false, owner: null, processes: [] });
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.list.result',
      ok: true,
      stateDir: projectRoot,
      runs: [summary],
      warnings: ['Skipped corrupt checkpoint'],
    });
    const output = await captureCommand(WorkflowList, [
      '--status',
      'completed',
      ...(json ? ['--json'] : []),
    ]);
    expect(output.error).toBeUndefined();
    expect(output.stdout).toContain(
      json ? '"kind":"workflow.list.result"' : 'test-run  test@1  completed',
    );
    expect(output.stderr).toContain('Skipped corrupt checkpoint');
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.list', status: 'completed' }),
    );
  });
  it('renders compact summaries and returns the watched terminal status without an error document', async () => {
    const ownership = { locked: false, owner: null, processes: [] };
    const summary = summarizeRun({ ...runRecord, status: 'failed' }, ownership);
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: runRecord,
      ownership,
      summary,
    });
    const output = await captureCommand(WorkflowInspect, ['test-run', '--json', '--summary']);
    expect(output.stdout).toContain('"counts"');
    expect(output.stdout).not.toContain('"output":42');
    const previous = process.exitCode;
    try {
      const watched = await captureCommand(WorkflowInspect, [
        'test-run',
        '--watch',
        '--interval',
        '250ms',
      ]);
      expect(watched.error).toBeUndefined();
      expect(watched.stdout).toBe('');
      expect(process.exitCode).toBe(1);
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'workflow.watch', intervalMs: 250 }),
      );
    } finally {
      process.exitCode = previous;
    }
  });
});

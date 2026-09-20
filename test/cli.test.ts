import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { ExitError } from '@oclif/core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConfigurationDoctor from '../src/commands/configuration/doctor.js';
import ConfigurationGet from '../src/commands/configuration/get.js';
import ConfigurationSet from '../src/commands/configuration/set.js';
import InfoVersion from '../src/commands/info/version.js';
import WorkflowExecute from '../src/commands/workflow/execute.js';
import WorkflowInspect from '../src/commands/workflow/inspect.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';
import WorkflowTypecheck from '../src/commands/workflow/typecheck.js';
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
    [ConfigurationDoctor, 'configuration doctor'],
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
    const output = await captureCommand(ConfigurationDoctor, ['--verbose']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('[trace] Executing plan for configuration.doctor');
  });

  it('accepts an explicit inherited log level', async () => {
    const output = await captureCommand(ConfigurationDoctor, ['--log-level', 'debug']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('');
  });

  it('rejects mutually exclusive verbosity flags', async () => {
    const output = await captureCommand(ConfigurationDoctor, ['--verbose', '--log-level', 'debug']);

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

  it('renders compiler errors and exits one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.ts');
    await writeFile(entrypoint, "const count: number = 'wrong';\n", 'utf8');

    const output = await captureCommand(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toBeInstanceOf(ExitError);
    expect(output.error).toMatchObject({ oclif: { exit: 1 } });
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
      code: 'UNSUPPORTED_TYPESCRIPT_EXTENSION',
      oclif: { exit: 2 },
    });
  });

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

const failedResult = {
  kind: 'workflow.error',
  ok: false,
  message: 'Workflow type check failed.',
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
} as const;

describe('workflow lifecycle command adapters', () => {
  it.each([false, true])('validates and renders metadata (JSON=%s)', async (json) => {
    const file = await workflowFile();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.validate.result',
      ok: true,
      entrypoint: file,
      workflow: { name: 'test', version: '1', fingerprint: 'hash' },
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
      expect(output.error).toMatchObject({ oclif: { exit: 1 } });
      expect(output.stderr).toContain('TS2322');
    },
  );

  it.each([WorkflowValidate, WorkflowExecute])(
    'rejects unsupported extensions for %s',
    async (command) => {
      const file = await workflowFile('js');
      const output = await captureCommand(command, [file]);
      expect(output.error).toMatchObject({
        code: 'UNSUPPORTED_TYPESCRIPT_EXTENSION',
        oclif: { exit: 2 },
      });
    },
  );

  it('requires valid JSON input and a resume identifier', async () => {
    const file = await workflowFile();
    const invalid = await captureCommand(WorkflowExecute, [file, '--input', '{nope}']);
    expect(invalid.error).toMatchObject({
      oclif: { exit: 2 },
      message: '--input must contain valid JSON.',
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
    expect(output.stderr).toBe('Run ID: test-run');
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { value: 2 }, runId: 'test-run', resume: false }),
    );
    expect(output.stdout).toContain(json ? '"output":42' : 'Run test-run completed.');
  });

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
      return Promise.resolve({
        kind: 'workflow.error',
        ok: false,
        message: 'Cancelled',
        diagnostics: [],
      });
    });
    const output = await captureCommand(WorkflowExecute, [file]);
    expect(output.error).toMatchObject({ oclif: { exit: 130 } });
  });

  it.each([false, true])('inspects a run without a source file (JSON=%s)', async (json) => {
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const output = await captureCommand(WorkflowInspect, ['test-run', ...(json ? ['--json'] : [])]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.inspect', runId: 'test-run' }),
    );
    expect(output.stdout).toContain(json ? '"output":42' : 'Steps: 0');
  });

  it('renders failure metadata and missing-run errors', async () => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: { ...runRecord, status: 'failed', error: 'Effect failed.' },
    });
    const failed = await captureCommand(WorkflowInspect, ['test-run']);
    expect(failed.stdout).toContain('Effect failed.');
    execute.mockResolvedValue({
      kind: 'workflow.error',
      ok: false,
      message: 'Run does not exist.',
      diagnostics: [],
    });
    const missing = await captureCommand(WorkflowInspect, ['missing']);
    expect(missing.error).toMatchObject({ oclif: { exit: 1 }, message: 'Run does not exist.' });
  });
});

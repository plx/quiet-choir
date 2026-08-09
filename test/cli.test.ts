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
    [WorkflowExecute, 'workflow execute'],
    [WorkflowValidate, 'workflow validate'],
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
    const output = await captureCommand(WorkflowExecute, ['--verbose']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('[trace] Executing plan for workflow.execute');
  });

  it('accepts an explicit inherited log level', async () => {
    const output = await captureCommand(WorkflowExecute, ['--log-level', 'debug']);

    expect(output.error).toMatchObject({ oclif: { exit: 2 } });
    expect(output.stderr).toBe('');
  });

  it('rejects mutually exclusive verbosity flags', async () => {
    const output = await captureCommand(WorkflowExecute, ['--verbose', '--log-level', 'debug']);

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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import WorkflowAnswer from '../src/commands/workflow/answer.js';
import WorkflowExecute from '../src/commands/workflow/execute.js';
import WorkflowInspect from '../src/commands/workflow/inspect.js';
import WorkflowResume from '../src/commands/workflow/resume.js';
import { defineWorkflow, resolveStateDir, runWorkflow, z } from '../src/index.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import type { RehearsalReport } from '../src/workflow/loader/rehearsal.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];

interface RunnableCommand {
  run(argv: string[], options: { root: string }): Promise<unknown>;
}

async function captureCommand(command: RunnableCommand, argv: string[] = []) {
  const standardOutput: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    standardOutput.push(typeof message === 'string' ? message : inspect(message));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let error: unknown;
  try {
    await command.run(argv, { root: projectRoot });
  } catch (caught: unknown) {
    error = caught;
  }
  return { error, stdout: standardOutput.join('\n') };
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-run-result-'));
  temporaryDirectories.push(directory);
  return directory;
}

const runRecord = {
  formatVersion: 1,
  id: 'test-run',
  status: 'completed',
  workflow: { name: 'test', version: '1', fingerprint: null },
  cwd: projectRoot,
  input: {},
  output: { answer: 42 },
  error: null,
  steps: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies RunRecord;

const pending = [
  {
    stepId: 'gate',
    answerCommand: ['quiet-choir', 'workflow', 'answer', 'test-run', 'gate', '--json', '<value>'],
  },
];
const resumeCommand = ['quiet-choir', 'workflow', 'resume', 'test-run'];
const suspendedRun = { ...runRecord, status: 'suspended', output: null, pending, resumeCommand };
const failedRun = { ...runRecord, status: 'failed', output: null, error: 'boom' } as const;

type Outcome = 'success' | 'suspension' | 'failure';
const outcomes: readonly Outcome[] = ['success', 'suspension', 'failure'];

function mockOutcome(outcome: Outcome, extra: object = {}) {
  return vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(
    outcome === 'failure'
      ? workflowFailure('workflow.failed', 'boom', { run: failedRun })
      : ({
          kind: 'workflow.run.result',
          ok: true,
          run: outcome === 'success' ? runRecord : suspendedRun,
          ...extra,
        } as never),
  );
}

interface Invocation {
  readonly name: string;
  readonly stateDir: string;
  readonly argv: (flags: string[]) => Promise<string[]>;
  readonly command: RunnableCommand;
}

async function invocations(): Promise<Invocation[]> {
  const stateDir = await temporaryDirectory();
  const file = join(stateDir, 'workflow.ts');
  await writeFile(file, 'export default {};\n');
  const state = ['--state-dir', stateDir];
  return [
    {
      name: 'execute',
      stateDir,
      command: WorkflowExecute,
      argv: (flags) =>
        Promise.resolve([file, '--run-id', 'test-run', ...state, '--json', ...flags]),
    },
    {
      name: 'resume',
      stateDir,
      command: WorkflowResume,
      argv: (flags) => Promise.resolve(['test-run', ...state, '--json', ...flags]),
    },
    {
      name: 'answer --resume',
      stateDir,
      command: WorkflowAnswer,
      argv: (flags) =>
        Promise.resolve([
          'test-run',
          'gate',
          '--json',
          '{"approved":true}',
          '--resume',
          ...state,
          ...flags,
        ]),
    },
  ];
}

describe.each(outcomes)('run commands, %s', (outcome) => {
  const exitCode = { success: 0, suspension: 75, failure: 1 }[outcome];
  const record = { success: runRecord, suspension: suspendedRun, failure: failedRun }[outcome];

  it.each(['execute', 'resume', 'answer --resume'])(
    '%s prints a typed compact document by default',
    async (name) => {
      const invocation = (await invocations()).find((item) => item.name === name);
      if (!invocation) throw new Error(name);
      mockOutcome(outcome);
      const output = await captureCommand(invocation.command, await invocation.argv([]));
      const document = JSON.parse(output.stdout) as Record<string, unknown>;
      expect(typeof document['kind']).toBe('string');
      expect(typeof document['ok']).toBe('boolean');
      expect(document['exitCode']).toBe(exitCode);
      expect(document).not.toHaveProperty('run');
      const summary = {
        runId: 'test-run',
        stateDir: resolveStateDir({ runId: 'test-run', stateDir: invocation.stateDir }),
        status: record.status,
        output: record.output,
      };
      if (outcome === 'success') {
        expect(document).toMatchObject({ kind: 'workflow.run.result', ok: true, ...summary });
        expect(document).not.toHaveProperty('summary');
      } else {
        expect(document['summary']).toMatchObject(summary);
      }
      if (outcome === 'suspension') {
        expect(document).toMatchObject({
          kind: 'workflow.run.suspended',
          ok: true,
          pending,
          resumeCommand,
        });
      }
      if (outcome === 'failure') {
        expect(document).toMatchObject({
          kind: 'workflow.error',
          ok: false,
          status: 'failed',
          error: { code: 'workflow.failed' },
          runId: 'test-run',
          stateDir: summary.stateDir,
          failedSteps: [],
        });
      }
    },
  );

  it.each(['execute', 'resume', 'answer --resume'])(
    '%s prints the whole record with --full',
    async (name) => {
      const invocation = (await invocations()).find((item) => item.name === name);
      if (!invocation) throw new Error(name);
      mockOutcome(outcome);
      const output = await captureCommand(invocation.command, await invocation.argv(['--full']));
      const document = JSON.parse(output.stdout) as Record<string, unknown>;
      const stateDir = resolveStateDir({ runId: 'test-run', stateDir: invocation.stateDir });
      if (outcome === 'success') {
        // Exactly the record plus the state directory: no kind or ok is added.
        expect(document).toEqual({ ...record, stateDir });
        expect(document).not.toHaveProperty('kind');
        expect(document).not.toHaveProperty('ok');
      } else {
        expect(document['run']).toEqual(record);
        expect(document).not.toHaveProperty('summary');
        expect(document['kind']).toBe(
          outcome === 'failure' ? 'workflow.error' : 'workflow.run.suspended',
        );
        expect(document['exitCode']).toBe(exitCode);
      }
    },
  );
});

async function executeInvocation(): Promise<Invocation> {
  const found = (await invocations()).find((item) => item.name === 'execute');
  if (!found) throw new Error('execute');
  return found;
}

describe('dry-run documents', () => {
  const rehearsal = {
    kind: 'workflow.rehearsal',
    warnings: [],
    calls: [],
    commands: [],
    replays: [],
    nominalClaudeCeilingUsd: 0,
  } as unknown as RehearsalReport;

  it('keeps run in a rehearsal success', async () => {
    const execute = await executeInvocation();
    mockOutcome('success', { rehearsal });
    const output = await captureCommand(execute.command, await execute.argv(['--dry-run']));
    expect(JSON.parse(output.stdout)).toMatchObject({
      kind: 'workflow.rehearsal',
      ok: true,
      run: { id: 'test-run', output: { answer: 42 } },
    });
  });

  it('keeps run in a rehearsal suspension', async () => {
    const execute = await executeInvocation();
    mockOutcome('suspension', { rehearsal });
    const output = await captureCommand(execute.command, await execute.argv(['--dry-run']));
    const document = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({
      kind: 'workflow.run.suspended',
      stateDir: null,
      run: { id: 'test-run' },
      rehearsal: { kind: 'workflow.rehearsal' },
    });
    expect(document).not.toHaveProperty('summary');
  });

  it('keeps run in a failure that carries a rehearsal', async () => {
    const execute = await executeInvocation();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure('workflow.failed', 'boom', { run: failedRun, rehearsal }),
    );
    const output = await captureCommand(execute.command, await execute.argv(['--dry-run']));
    const document = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({
      run: { id: 'test-run' },
      rehearsal: { kind: 'workflow.rehearsal' },
    });
    expect(document).not.toHaveProperty('summary');
  });
});

describe('other commands', () => {
  it('keep the whole run in their failure documents', async () => {
    const stateDir = await temporaryDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure('run.not_found', 'Run does not exist.', {
        run: failedRun,
        runId: 'test-run',
        stateDir,
      }),
    );
    const output = await captureCommand(WorkflowInspect, [
      'test-run',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    const document = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(document['run']).toEqual(failedRun);
    expect(document).not.toHaveProperty('summary');
  });
});

describe('answer.invalid on a run with many steps', () => {
  async function savedRun(stateDir: string) {
    const definition = defineWorkflow({
      name: 'many',
      version: '1',
      input: z.null(),
      output: z.number(),
      async run(ctx) {
        for (let index = 0; index < 60; index++)
          await ctx.step(`step-${String(index)}`, {
            input: index,
            schema: z.string(),
            run: () => 'x'.repeat(500),
          });
        return 60;
      },
    });
    return runWorkflow(definition, { stateDir, runId: 'many', input: null, harness: {} as never });
  }

  async function invalid(flags: string[]) {
    const stateDir = await temporaryDirectory();
    const saved = await savedRun(stateDir);
    const output = await captureCommand(WorkflowAnswer, [
      'many',
      'gate',
      '--json',
      '{not json',
      '--state-dir',
      stateDir,
      ...flags,
    ]);
    return { saved, output, document: JSON.parse(output.stdout) as Record<string, unknown> };
  }

  it('is a small document with a summary and no run', async () => {
    const { saved, output, document } = await invalid([]);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(output.stdout)).toBeLessThan(4096);
    expect(document).toMatchObject({
      kind: 'workflow.error',
      exitCode: 2,
      error: { code: 'answer.invalid' },
      summary: { runId: 'many', status: 'completed', counts: { total: 60, completed: 60 } },
    });
    expect(document).not.toHaveProperty('run');
  });

  it('restores the run with --full', async () => {
    const { document } = await invalid(['--full']);
    expect(document).toMatchObject({ error: { code: 'answer.invalid' }, run: { id: 'many' } });
    expect(document).not.toHaveProperty('summary');
  });
});

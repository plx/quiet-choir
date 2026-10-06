import { resolveStateDir } from '../src/index.js';
import WorkflowList from '../src/commands/workflow/list.js';
import { summarizeRun } from '../src/workflow/loader/inspection.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import { capabilityManifest } from '../src/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExitError } from '@oclif/core/errors';
import { afterEach, describe, expect, vi } from 'vitest';

import InfoVersion from '../src/commands/info/version.js';
import WorkflowAnswer from '../src/commands/workflow/answer.js';
import WorkflowExecute from '../src/commands/workflow/execute.js';
import WorkflowInspect from '../src/commands/workflow/inspect.js';
import WorkflowPending from '../src/commands/workflow/pending.js';
import WorkflowResume from '../src/commands/workflow/resume.js';
import WorkflowTick from '../src/commands/workflow/tick.js';
import WorkflowCheckResume from '../src/commands/workflow/check-resume.js';
import WorkflowStart from '../src/commands/workflow/start.js';
import { StartWorkflowExecutor } from '../src/workflow/loader/start.js';
import { setSpawnLauncher } from '../src/cli/launcher.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import type { TickWorkflowsResult } from '../src/workflow/loader/tick.js';
import type { PendingOperation } from '../src/workflow/runtime/wait-model.js';
import type { PendingRow } from '../src/workflow/loader/pending-listing.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';
import WorkflowTypecheck from '../src/commands/workflow/typecheck.js';
import { TypeScriptExecutor } from '../src/workflow/typecheck/typescript-executor.js';
import WorkflowValidate from '../src/commands/workflow/validate.js';
import { it } from './setup/cli-capture.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('inherited verbosity flags', () => {
  it('maps --verbose to trace logging', async ({ cli }) => {
    const output = await cli.run(InfoVersion, ['--verbose']);

    expect(output.error).toBeUndefined();
    expect(output.stdout).toBe('0.0.0');
    expect(output.stderr).toBe('[trace] Executing info.version');
  });

  it('accepts an explicit inherited log level', async ({ cli }) => {
    const output = await cli.run(InfoVersion, ['--log-level', 'debug']);

    expect(output.error).toBeUndefined();
    expect(output.stderr).toBe('');
  });

  it('rejects mutually exclusive verbosity flags', async ({ cli }) => {
    const output = await cli.run(InfoVersion, ['--verbose', '--log-level', 'debug']);

    expect(output.error).toBeInstanceOf(Error);
    if (output.error instanceof Error) {
      expect(output.error.message).toContain('cannot also be provided');
    }
  });
});

describe('implemented command adapters', () => {
  it('reports the package version through a plan and executor', async ({ cli }) => {
    const output = await cli.run(InfoVersion);

    expect(output.error).toBeUndefined();
    expect(output.stdout).toBe('0.0.0');
  });

  // Full TypeScript compile with no program cache (the CLI passes none). measured: 0.15-0.35 s alone,
  // 0.9 s worst of three full coverage runs, 2.0 s with a CPU hog on every core, 0.3-3.1 s on the CI legs
  // (slowest on the Node 24 coverage leg).
  it('type-checks a valid entrypoint', { timeout: 10_000 }, async ({ cli }) => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.ts');
    await writeFile(entrypoint, 'export const value: number = 1;\n', 'utf8');

    const output = await cli.run(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toBeUndefined();
    expect(output.stdout).toContain('Type check passed');
    expect(output.stderr).toBe('');
  });

  // Full TypeScript compile with no program cache (the CLI passes none). measured: 0.15-0.35 s alone,
  // 0.9 s worst of three full coverage runs, 2.0 s with a CPU hog on every core, 0.3-3.1 s on the CI legs
  // (slowest on the Node 24 coverage leg).
  it('renders compiler errors and exits four', { timeout: 10_000 }, async ({ cli }) => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.ts');
    await writeFile(entrypoint, "const count: number = 'wrong';\n", 'utf8');

    const output = await cli.run(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toBeInstanceOf(ExitError);
    expect(output.error).toMatchObject({ oclif: { exit: 4 } });
    expect(output.stderr).toContain('error TS2322');
    expect(output.stderr).toContain('Type check failed with 1 error.');
  });

  it('rejects unsupported source extensions during plan analysis', async ({ cli }) => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
    temporaryDirectories.push(root);
    const entrypoint = join(root, 'workflow.js');
    await writeFile(entrypoint, 'export const value = 1;\n', 'utf8');

    const output = await cli.run(WorkflowTypecheck, [entrypoint]);

    expect(output.error).toMatchObject({
      code: 'usage.entrypoint',
      oclif: { exit: 2 },
    });
  });

  // Full TypeScript compile with no program cache (the CLI passes none). measured: 0.15-0.35 s alone,
  // 0.9 s worst of three full coverage runs, 2.0 s with a CPU hog on every core, 0.3-3.1 s on the CI legs
  // (slowest on the Node 24 coverage leg).
  it.for([false, true])(
    'reports a first signal during a successful type check as interrupted (JSON=%s)',
    { timeout: 10_000 },
    async (json, { cli }) => {
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

      const output = await cli.run(WorkflowTypecheck, [entrypoint, ...(json ? ['--json'] : [])]);

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

  it('uses oclif file validation for missing entrypoints', async ({ cli }) => {
    const output = await cli.run(WorkflowTypecheck, ['/definitely/missing/workflow.ts']);

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
  it.for([false, true])('validates and renders metadata (JSON=%s)', async (json, { cli }) => {
    const file = await workflowFile();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.validate.result',
      ok: true,
      entrypoint: file,
      diagnostics: [],
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
    const output = await cli.run(WorkflowValidate, [file, ...(json ? ['--json'] : [])]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workflow.validate' }));
    expect(output.stdout).toContain(json ? '"fingerprint":"hash"' : 'Validated test@1');
  });

  it.for([WorkflowValidate, WorkflowExecute])(
    'reports type errors before execution for %s',
    async (command, { cli }) => {
      const file = await workflowFile();
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failedResult);
      const output = await cli.run(command, [file]);
      expect(output.error).toMatchObject({ oclif: { exit: 4 } });
      expect(output.stderr).toContain('TS2322');
    },
  );

  it.for([WorkflowValidate, WorkflowExecute])(
    'rejects unsupported extensions for %s',
    async (command, { cli }) => {
      const file = await workflowFile('js');
      const output = await cli.run(command, [file]);
      expect(output.error).toMatchObject({
        code: 'usage.entrypoint',
        oclif: { exit: 2 },
      });
    },
  );

  it('requires valid JSON input and a resume identifier', async ({ cli }) => {
    const file = await workflowFile();
    const invalid = await cli.run(WorkflowExecute, [file, '--input', '{nope}']);
    expect(invalid.error).toMatchObject({
      oclif: { exit: 2 },
      message: expect.stringContaining('--input must contain valid JSON.') as unknown,
    });
    const missingId = await cli.run(WorkflowExecute, [file, '--resume']);
    expect(missingId.error).toBeInstanceOf(Error);
  });

  it.for([false, true])(
    'executes with JSON input and renders a run (JSON=%s)',
    async (json, { cli }) => {
      const file = await workflowFile();
      const execute = vi
        .spyOn(WorkflowExecutor.prototype, 'execute')
        .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
      const output = await cli.run(WorkflowExecute, [
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
    },
  );

  it('passes positive agent limits as plain execution policy and rejects malformed values before execution', async ({
    cli,
  }) => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const valid = await cli.run(WorkflowExecute, [
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
      const invalid = await cli.run(WorkflowExecute, [file, ...args]);
      expect(invalid.error).toMatchObject({ oclif: { exit: 2 } });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes --max-window-utilization as plain policy and rejects one above 1 before execution', async ({
    cli,
  }) => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const valid = await cli.run(WorkflowExecute, [file, '--max-window-utilization', '0.5']);
    expect(valid.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ maxWindowUtilization: 0.5 }));
    execute.mockClear();
    const invalid = await cli.run(WorkflowExecute, [file, '--max-window-utilization', '1.5']);
    expect(invalid.error).toMatchObject({
      code: 'usage.flag',
      oclif: { exit: 2 },
      message: expect.stringContaining('--max-window-utilization') as unknown,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.for([false, true])(
    'prints cleanup warnings to stderr without failing the completed run (JSON=%s)',
    async (json, { cli }) => {
      const file = await workflowFile();
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
        kind: 'workflow.run.result',
        ok: true,
        run: { ...runRecord, warnings: ['Could not release run test-run lock: EACCES'] },
      });
      const output = await cli.run(WorkflowExecute, [
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

  it('preserves saved input on resume and removes signal handlers', async ({ cli }) => {
    const file = await workflowFile();
    const interruptListeners = process.listenerCount('SIGINT');
    const terminateListeners = process.listenerCount('SIGTERM');
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const output = await cli.run(WorkflowExecute, [file, '--run-id', 'test-run', '--resume']);
    expect(output.error).toBeUndefined();
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('input');
    expect(process.listenerCount('SIGINT')).toBe(interruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(terminateListeners);
  });

  it('uses exit 130 on cooperative cancellation', async ({ cli }) => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve(workflowFailure('workflow.interrupted', 'Cancelled'));
    });
    const output = await cli.run(WorkflowExecute, [file]);
    expect(output.error).toMatchObject({ oclif: { exit: 130 } });
  });

  it('keeps exit 1 for a saved failed checkpoint when a signal also arrives', async ({ cli }) => {
    const file = await workflowFile();
    const run = { ...runRecord, status: 'failed', error: 'application failure' } as const;
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve(workflowFailure('workflow.failed', 'application failure', { run }));
    });
    const output = await cli.run(WorkflowExecute, [file, '--json']);
    expect(output.error).toMatchObject({ oclif: { exit: 1 } });
    expect(JSON.parse(output.stdout)).toMatchObject({
      exitCode: 1,
      error: { code: 'workflow.failed' },
      summary: { status: 'failed' },
    });
  });

  it('keeps a saved completion successful when a signal arrives after the last check', async ({
    cli,
  }) => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(() => {
      process.emit('SIGINT');
      return Promise.resolve({ kind: 'workflow.run.result', ok: true, run: runRecord });
    });
    const output = await cli.run(WorkflowExecute, [file, '--run-id', 'test-run', '--json']);
    expect(output.error).toBeUndefined();
    expect(JSON.parse(output.stdout)).toMatchObject({
      kind: 'workflow.run.result',
      runId: 'test-run',
      status: 'completed',
    });
  });

  it('keeps a durably queued answer successful when a signal arrives after delivery', async ({
    cli,
  }) => {
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
    const output = await cli.run(WorkflowAnswer, ['test-run', 'approve', '--json', 'true']);
    expect(output.error).toBeUndefined();
    expect(JSON.parse(output.stdout)).toMatchObject({ kind: 'workflow.answer.result', delivery });
  });

  it.for([false, true])(
    'reports a first signal during a successful inspect as interrupted (JSON=%s)',
    async (json, { cli }) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-'));
      temporaryDirectories.push(stateDir);
      await writeFile(join(stateDir, 'test-run.json'), JSON.stringify(runRecord));
      const ownership = { locked: false, owner: null, processes: [], locks: [] };
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
      const output = await cli.run(WorkflowInspect, [
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

  it.for([false, true])('inspects a run without a source file (JSON=%s)', async (json, { cli }) => {
    const run = {
      ...runRecord,
      harnesses: { codex: { binary: 'codex', version: '0.157.1' } },
      harnessWarnings: ['native version changed'],
    };
    const ownership = { locked: false, owner: null, processes: [], locks: [] };
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run,
      ownership,
      summary: summarizeRun(run, ownership),
    });
    const output = await cli.run(WorkflowInspect, ['test-run', ...(json ? ['--json'] : [])]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.inspect', runId: 'test-run' }),
    );
    expect(output.stdout).toContain(json ? '"output":42' : 'Steps: 0');
    expect(output.stdout).toContain(json ? '"version":"0.157.1"' : 'Harness codex: codex@0.157.1');
    expect(output.stdout).toContain('native version changed');
  });

  it('renders failure metadata and missing-run errors', async ({ cli }) => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: { ...runRecord, status: 'failed', error: 'Effect failed.' },
      ownership: { locked: false, owner: null, processes: [], locks: [] },
      summary: summarizeRun(
        { ...runRecord, status: 'failed', error: 'Effect failed.' },
        { locked: false, owner: null, processes: [], locks: [] },
      ),
    });
    const failed = await cli.run(WorkflowInspect, ['test-run']);
    expect(failed.stdout).toContain('Effect failed.');
    execute.mockResolvedValue(workflowFailure('run.not_found', 'Run does not exist.'));
    const missing = await cli.run(WorkflowInspect, ['missing']);
    expect(missing.error).toMatchObject({ oclif: { exit: 3 }, message: 'Run does not exist.' });
  });
});

describe('next commands in failures', () => {
  const next = [
    {
      why: 'Stop orphans and resume.',
      argv: ['/x/node', '/a b/run.js', 'workflow', 'resume', 'r1', '--kill-orphans'],
    },
  ];
  const failure = () =>
    workflowFailure('run.orphans', 'Orphans survive.', { runId: 'r1', stateDir: '/s', next });

  it('prints one shell-quoted Next: line per entry after a human failure message', async ({
    cli,
  }) => {
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failure());
    const output = await cli.run(WorkflowResume, ['r1', '--state-dir', projectRoot]);
    expect(output.error).toMatchObject({
      oclif: { exit: 3 },
      message:
        "Orphans survive.\nNext: /x/node '/a b/run.js' workflow resume r1 --kill-orphans  (Stop orphans and resume.)",
    });
  });

  it('keeps the JSON document constant-shape: next is the entries, or an empty array', async ({
    cli,
  }) => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failure());
    const json = ['r1', '--state-dir', projectRoot, '--json'];
    const orphans = await cli.run(WorkflowResume, json);
    expect(JSON.parse(orphans.stdout)).toMatchObject({ error: { code: 'run.orphans' }, next });
    execute.mockResolvedValue(workflowFailure('run.locked', 'Locked.', { runId: 'r1' }));
    const locked = await cli.run(WorkflowResume, json);
    expect(JSON.parse(locked.stdout)).toMatchObject({ error: { code: 'run.locked' }, next: [] });
  });

  it('hands the detected launcher to the executor, which emits it in answerCommand', async ({
    cli,
  }) => {
    const { setCommandLauncher } = await import('../src/cli/launcher.js');
    const { defineWorkflow, runWorkflow, z } = await import('../src/index.js');
    const stateDir = await stateDirectory();
    const definition = defineWorkflow({
      name: 'gate',
      version: '1',
      input: z.null(),
      output: z.string(),
      run: (ctx) => ctx.ask('gate', { prompt: 'Ship?', schema: z.string() }),
    });
    await runWorkflow(definition, { runId: 'gate', stateDir, input: null });
    try {
      setCommandLauncher(['/x/node', '/y/run.js']);
      const output = await cli.run(WorkflowPending, ['--state-dir', stateDir, '--json']);
      expect(output.error).toBeUndefined();
      expect(
        (JSON.parse(output.stdout) as { pending: PendingOperation[] }).pending[0]?.answerCommand,
      ).toEqual([
        '/x/node',
        '/y/run.js',
        'workflow',
        'answer',
        'gate',
        'gate',
        '--state-dir',
        stateDir,
        '--json',
        '<ANSWER_JSON>',
      ]);
    } finally {
      setCommandLauncher(undefined);
    }
  });
});

describe('recovery command adapters', () => {
  it.for([false, true])(
    'prints a compatibility report and uses its exit status (compatible=%s)',
    async (compatible, { cli }) => {
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
      const output = await cli.run(WorkflowCheckResume, [
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

  it.for([false, true])('reports check-resume load failures (JSON=%s)', async (json, { cli }) => {
    const file = await workflowFile();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(failedResult);
    const output = await cli.run(WorkflowCheckResume, [
      file,
      '--run-id',
      'r',
      ...(json ? ['--json'] : []),
    ]);
    expect(output.error).toMatchObject({ oclif: { exit: 4 } });
    if (json) expect(JSON.parse(output.stdout)).toMatchObject({ ok: false });
    else expect(output.stderr).toContain('TS2322');
  });

  it('passes explicit fork and replay options as data and inherits source input when omitted', async ({
    cli,
  }) => {
    const file = await workflowFile();
    const execute = vi
      .spyOn(WorkflowExecutor.prototype, 'execute')
      .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: runRecord });
    const fork = await cli.run(WorkflowExecute, [
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
    const resume = await cli.run(WorkflowExecute, [
      file,
      '--run-id',
      'old',
      '--resume',
      '--accept-code-change',
    ]);
    expect(resume.error).toBeUndefined();
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ resume: true, acceptCodeChange: true });
  });

  it('rejects incompatible recovery flags and detached fork modifiers', async ({ cli }) => {
    const file = await workflowFile();
    for (const flags of [
      ['--resume', '--fork-from', 'old'],
      ['--accept-code-change'],
      ['--reuse', 'matching'],
      ['--invalidate', 'a'],
    ]) {
      expect(
        (await cli.run(WorkflowExecute, [file, '--run-id', 'new', ...flags])).error,
      ).toBeInstanceOf(Error);
    }
    const bad = await cli.run(WorkflowCheckResume, [await workflowFile('js'), '--run-id', 'r']);
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
    expect((await cli.run(WorkflowCheckResume, [file, '--run-id', 'r'])).stdout).toBe('compatible');
  });
});

describe('monitoring command adapters', () => {
  it.for([false, true])('lists and filters saved runs (JSON=%s)', async (json, { cli }) => {
    const summary = summarizeRun(runRecord, {
      locked: false,
      owner: null,
      processes: [],
      locks: [],
    });
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.list.result',
      ok: true,
      stateDir: projectRoot,
      runs: [summary],
      warnings: ['Skipped corrupt checkpoint'],
    });
    const output = await cli.run(WorkflowList, [
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
  it('renders compact summaries and returns the watched terminal status without an error document', async ({
    cli,
  }) => {
    const ownership = { locked: false, owner: null, processes: [], locks: [] };
    const summary = summarizeRun({ ...runRecord, status: 'failed' }, ownership);
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: runRecord,
      ownership,
      summary,
    });
    const output = await cli.run(WorkflowInspect, ['test-run', '--json', '--summary']);
    expect(output.stdout).toContain('"counts"');
    expect(output.stdout).not.toContain('"output":42');
    const watched = await cli.run(WorkflowInspect, ['test-run', '--watch', '--interval', '250ms']);
    expect(watched.error).toBeUndefined();
    expect(watched.stdout).toBe('');
    expect(watched.exitCode).toBe(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'workflow.watch', intervalMs: 250 }),
    );
  });
});

/** An existing, empty runs container, so commands never consult the developer's project state. */
async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-cli-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('resume command exit and error codes', () => {
  const suspendedRun = {
    ...runRecord,
    status: 'suspended',
    output: null,
    pending: [],
    resumeCommand: ['quiet-choir', 'workflow', 'resume', 'test-run'],
  } as const;

  it.for([false, true])(
    'exits 75 for a suspended run without an error (JSON=%s)',
    async (json, { cli }) => {
      const stateDir = await stateDirectory();
      const execute = vi
        .spyOn(WorkflowExecutor.prototype, 'execute')
        .mockResolvedValue({ kind: 'workflow.run.result', ok: true, run: suspendedRun });
      const output = await cli.run(WorkflowResume, [
        'test-run',
        '--state-dir',
        stateDir,
        ...(json ? ['--json'] : []),
      ]);
      expect(output.error).toBeUndefined();
      expect(output.exitCode).toBe(75);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workflow.resume', runId: 'test-run', stateDir }),
      );
      if (json)
        expect(JSON.parse(output.stdout)).toMatchObject({
          kind: 'workflow.run.suspended',
          ok: true,
          exitCode: 75,
          runId: 'test-run',
          nextWakeAt: null,
        });
      else expect(output.stdout).toContain('Run test-run suspended.');
    },
  );

  it.for([false, true])(
    'reports a window-gate suspension with its wake time (JSON=%s)',
    async (json, { cli }) => {
      const stateDir = await stateDirectory();
      const gated = {
        ...suspendedRun,
        nextWakeAt: 1_791_360_000_000,
        budgetStop: {
          stepId: 'two',
          metric: 'maxWindowUtilization',
          limit: 0.5,
          observed: 0.84,
          at: '2026-10-04T00:00:00.000Z',
          harness: 'claude',
          window: 'seven_day',
          resetsAt: 1_791_360_000,
        },
      } as const;
      vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
        kind: 'workflow.run.result',
        ok: true,
        run: gated,
      });
      const output = await cli.run(WorkflowResume, [
        'test-run',
        '--state-dir',
        stateDir,
        ...(json ? ['--json'] : []),
      ]);
      expect(output.error).toBeUndefined();
      expect(output.exitCode).toBe(75);
      if (json)
        expect(JSON.parse(output.stdout)).toMatchObject({
          kind: 'workflow.run.suspended',
          exitCode: 75,
          nextWakeAt: 1_791_360_000_000,
        });
      else
        expect(output.stdout).toContain(
          'Run test-run suspended until 2026-10-07T08:00:00.000Z: claude seven_day window at 84% reached --max-window-utilization 0.5. workflow tick resumes it once that time has passed.',
        );
    },
  );

  it('forwards strictReplay only when --strict-replay is given', async ({ cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: runRecord,
    });
    const strict = await cli.run(WorkflowResume, [
      'test-run',
      '--state-dir',
      stateDir,
      '--strict-replay',
    ]);
    expect(strict.error).toBeUndefined();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: 'workflow.resume',
      runId: 'test-run',
      strictReplay: true,
    });
    const plain = await cli.run(WorkflowResume, ['test-run', '--state-dir', stateDir]);
    expect(plain.error).toBeUndefined();
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ kind: 'workflow.resume' });
    expect(execute.mock.calls[1]?.[0]).not.toHaveProperty('strictReplay');
  });

  it('exits 0 and renders a completed run', async ({ cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.run.result',
      ok: true,
      run: runRecord,
    });
    const output = await cli.run(WorkflowResume, ['test-run', '--state-dir', stateDir]);
    expect(output.error).toBeUndefined();
    expect(output.exitCode).toBeUndefined();
    expect(output.stdout).toContain('Run test-run completed.');
    expect(output.stdout).toContain('42');
  });

  it.for([
    ['run.locked', 3],
    ['run.incompatible', 3],
    ['run.not_found', 3],
    ['run.unreadable', 3],
    ['workflow.storage', 74],
    ['workflow.failed', 1],
  ] as const)('maps the %s failure to exit %i', async ([code, exit], { cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure(code, `Failure ${code}.`),
    );
    const human = await cli.run(WorkflowResume, ['test-run', '--state-dir', stateDir]);
    expect(human.error).toMatchObject({ code, oclif: { exit }, message: `Failure ${code}.` });
    const json = await cli.run(WorkflowResume, ['test-run', '--state-dir', stateDir, '--json']);
    expect(json.error).toMatchObject({ oclif: { exit } });
    expect(JSON.parse(json.stdout)).toMatchObject({
      kind: 'workflow.error',
      ok: false,
      exitCode: exit,
      error: { code },
      runId: 'test-run',
    });
  });

  it('rejects an invalid run ID before execution', async ({ cli }) => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute');
    const output = await cli.run(WorkflowResume, ['bad/id']);
    expect(output.error).toMatchObject({ code: 'usage.run_id', oclif: { exit: 2 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid run budget before execution', async ({ cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute');
    const output = await cli.run(WorkflowResume, [
      'test-run',
      '--state-dir',
      stateDir,
      '--max-run-cost-usd',
      'lots',
    ]);
    expect(output.error).toMatchObject({ code: 'usage.flag', oclif: { exit: 2 } });
    const window = await cli.run(WorkflowResume, [
      'test-run',
      '--state-dir',
      stateDir,
      '--max-window-utilization',
      '1.5',
    ]);
    expect(window.error).toMatchObject({
      code: 'usage.flag',
      oclif: { exit: 2 },
      message: expect.stringContaining('--max-window-utilization') as unknown,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('pending command exit and error codes', () => {
  const question: PendingRow = {
    runId: 'run-a',
    stepId: 'approve',
    questionFingerprint: 'fingerprint',
    askedAt: '2026-01-01T00:00:00.000Z',
    prompt: 'Ship it?',
    details: null,
    choices: [],
    audience: 'human',
    subject: null,
    title: null,
    schema: {},
    rejections: [],
    codeChanged: false,
    answerCommand: null,
    runStatus: 'suspended',
    delivery: null,
    next: [],
  };
  const wait: PendingRow = {
    kind: 'wait',
    runId: 'run-b',
    stepId: 'poll',
    openedAt: 1,
    deadline: 5_000,
    nextCheckAt: 2_000,
    checks: 3,
    note: null,
    lastError: null,
    signal: null,
    command: null,
    rejections: [],
    codeChanged: null,
    answerCommand: null,
    runStatus: 'suspended',
    delivery: null,
    next: [],
  };

  it('renders a question and a wait as human text', async ({ cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [question, wait, { ...wait, stepId: 'ci', command: ['gh', 'pr', 'checks', '1'] }],
      hidden: 0,
    });
    const output = await cli.run(WorkflowPending, ['--state-dir', stateDir]);
    expect(output.error).toBeUndefined();
    expect(output.exitCode).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.pending', stateDir }),
    );
    expect(output.stdout).toContain('run-a approve [human] Ship it?');
    expect(output.stdout).toContain('run-b poll [wait] checks=3 nextCheckAt=2000 deadline=5000');
    // A command poll's row names the command it runs on each check.
    expect(output.stdout).toContain(
      'run-b ci [wait] checks=3 nextCheckAt=2000 deadline=5000 command=["gh","pr","checks","1"]',
    );
  });

  it('renders the latest tolerated observation error of a wait as text and JSON', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    const tolerated: PendingRow = {
      ...wait,
      note: { state: 'pending' },
      lastError: { message: 'HTTP 502: Bad Gateway', consecutive: 2, at: 1_500 },
    };
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [tolerated, wait],
      hidden: 0,
    });
    const text = await cli.run(WorkflowPending, ['--state-dir', stateDir]);
    expect(text.stdout).toBe(
      [
        'run-b poll [wait] checks=3 nextCheckAt=2000 deadline=5000',
        '  {"state":"pending"}',
        '  lastError (consecutive=2): HTTP 502: Bad Gateway',
        'run-b poll [wait] checks=3 nextCheckAt=2000 deadline=5000',
      ].join('\n'),
    );
    const json = await cli.run(WorkflowPending, ['--state-dir', stateDir, '--json']);
    const document = JSON.parse(json.stdout) as { pending: { lastError: unknown }[] };
    expect(document.pending.map((item) => item.lastError)).toEqual([
      { message: 'HTTP 502: Bad Gateway', consecutive: 2, at: 1_500 },
      null,
    ]);
  });

  it('marks queued and ended-run rows, prints their next command and the hidden hint', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    const queued: PendingRow = {
      ...question,
      runStatus: 'suspended',
      delivery: { state: 'queued', at: '2026-01-02T00:00:00.000Z', by: 'human:Pat' },
      next: [
        { why: 'An answer is queued; resume the run.', argv: ['q', 'workflow', 'resume', 'run-a'] },
      ],
    };
    const ended: PendingRow = { ...wait, runStatus: 'failed' };
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [queued, ended],
      hidden: 2,
    });
    const output = await cli.run(WorkflowPending, ['--state-dir', stateDir, '--all']);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
    expect(output.stdout).toBe(
      [
        'run-a approve [human] Ship it? (answer queued by human:Pat at 2026-01-02T00:00:00.000Z)',
        'Next: q workflow resume run-a  (An answer is queued; resume the run.)',
        'run-b poll [wait] checks=3 nextCheckAt=2000 deadline=5000 [run failed]',
        '2 hidden (answered, or from ended runs); --all lists them.',
      ].join('\n'),
    );
  });

  it('keeps the hidden hint after "No pending waits." and omits all by default', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [],
      hidden: 1,
    });
    const output = await cli.run(WorkflowPending, ['--state-dir', stateDir]);
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('all');
    expect(output.stdout).toBe(
      'No pending waits.\n1 hidden (answered, or from ended runs); --all lists them.',
    );
  });

  it('renders the pending result as JSON', async ({ cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [question, wait],
      hidden: 0,
    });
    const output = await cli.run(WorkflowPending, ['--state-dir', stateDir, '--json']);
    expect(output.error).toBeUndefined();
    const document = JSON.parse(output.stdout) as { pending: { runId: string }[] };
    expect(document).toMatchObject({ kind: 'workflow.pending.result', ok: true });
    expect(document.pending.map((item) => item.runId)).toEqual(['run-a', 'run-b']);
  });

  it('says so when nothing is pending', async ({ cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.pending.result',
      ok: true,
      pending: [],
      hidden: 0,
    });
    const output = await cli.run(WorkflowPending, ['--state-dir', stateDir]);
    expect(output.error).toBeUndefined();
    expect(output.stdout).toBe('No pending waits.');
  });

  it.for([
    ['workflow.storage', 74],
    ['run.unreadable', 3],
  ] as const)('maps the %s failure to exit %i', async ([code, exit], { cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(WorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure(code, `Failure ${code}.`),
    );
    const human = await cli.run(WorkflowPending, ['--state-dir', stateDir]);
    expect(human.error).toMatchObject({ code, oclif: { exit } });
    const json = await cli.run(WorkflowPending, ['--state-dir', stateDir, '--json']);
    expect(json.error).toMatchObject({ oclif: { exit } });
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, exitCode: exit, error: { code } });
  });
});

describe('tick command exit and error codes', () => {
  const tickResult = (exitCode: 0 | 75 | 1): TickWorkflowsResult => ({
    kind: 'workflow.tick.result',
    ok: true,
    resumed:
      exitCode === 0
        ? [{ runId: 'run-a', outcome: 'completed' }]
        : exitCode === 1
          ? [{ runId: 'run-a', outcome: 'failed', message: 'It broke.' }]
          : [],
    skipped: exitCode === 75 ? [{ runId: 'run-a', reason: 'locked' }] : [],
    observed: 0,
    exitCode,
  });

  it.for([0, 75, 1] as const)('propagates a result exit code of %i', async (exitCode, { cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi
      .spyOn(TickWorkflowExecutor.prototype, 'execute')
      .mockResolvedValue(tickResult(exitCode));
    const output = await cli.run(WorkflowTick, ['--state-dir', stateDir]);
    expect(output.error).toBeUndefined();
    expect(output.exitCode ?? 0).toBe(exitCode);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.tick', stateDir, watch: false }),
    );
    expect(output.stdout).toContain(
      exitCode === 75
        ? 'Resumed 0; skipped 1; observed 0.\nrun-a: skipped: locked'
        : 'Resumed 1; skipped 0; observed 0.',
    );
    if (exitCode === 0) expect(output.stdout).toContain('run-a: completed');
    if (exitCode === 1) expect(output.stdout).toContain('run-a: failed: It broke.');
  });

  it('renders a suspended outcome with its next wake and a skip with its message', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(TickWorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'run-a', outcome: 'suspended', nextWakeAt: Date.UTC(2030, 0, 1) }],
      skipped: [{ runId: 'run-b', reason: 'incompatible', message: 'Changed.' }],
      observed: 2,
      exitCode: 0,
    });
    const output = await cli.run(WorkflowTick, ['--state-dir', stateDir]);
    expect(output.error).toBeUndefined();
    expect(output.stdout).toContain(
      [
        'Resumed 1; skipped 1; observed 2.',
        'run-a: suspended (next wake 2030-01-01T00:00:00.000Z)',
        'run-b: skipped: incompatible: Changed.',
      ].join('\n'),
    );
  });

  it('renders the tick result as JSON', async ({ cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(TickWorkflowExecutor.prototype, 'execute').mockResolvedValue(tickResult(75));
    const output = await cli.run(WorkflowTick, ['--state-dir', stateDir, '--json']);
    expect(output.error).toBeUndefined();
    expect(output.exitCode).toBe(75);
    expect(JSON.parse(output.stdout)).toMatchObject({
      kind: 'workflow.tick.result',
      ok: true,
      exitCode: 75,
    });
  });

  it('rejects an invalid --run ID before execution', async ({ cli }) => {
    const execute = vi.spyOn(TickWorkflowExecutor.prototype, 'execute');
    const output = await cli.run(WorkflowTick, ['--run', 'bad/id']);
    expect(output.error).toMatchObject({ code: 'usage.run_id', oclif: { exit: 2 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.for(['0s', '0', 'soon', '-5s'])(
    'rejects --timeout %s before execution',
    async (timeout, { cli }) => {
      const stateDir = await stateDirectory();
      const execute = vi.spyOn(TickWorkflowExecutor.prototype, 'execute');
      const output = await cli.run(WorkflowTick, ['--state-dir', stateDir, '--timeout', timeout]);
      expect(output.error).toMatchObject({ code: 'usage.flag', oclif: { exit: 2 } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.for([
    [['--timeout', '60s', '--claim-margin', '5s'], { timeoutMs: 60_000, claimMarginMs: 5_000 }],
    [['--timeout', '2m', '--claim-margin', '0ms'], { timeoutMs: 120_000, claimMarginMs: 0 }],
    [
      ['--timeout', '1h', '--claim-margin', '1.5m'],
      { timeoutMs: 3_600_000, claimMarginMs: 90_000 },
    ],
  ] as const)('passes --claim-margin %j as claimMarginMs', async ([flags, expected], { cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi
      .spyOn(TickWorkflowExecutor.prototype, 'execute')
      .mockResolvedValue(tickResult(0));
    const output = await cli.run(WorkflowTick, ['--state-dir', stateDir, ...flags]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it('leaves the claim margin to the executor default when the flag is absent', async ({ cli }) => {
    const stateDir = await stateDirectory();
    const execute = vi
      .spyOn(TickWorkflowExecutor.prototype, 'execute')
      .mockResolvedValue(tickResult(0));
    await cli.run(WorkflowTick, ['--state-dir', stateDir, '--timeout', '10s']);
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('claimMarginMs');
  });

  it.for([
    ['10s', '10s'],
    ['10s', '11s'],
    ['10s', 'soon'],
    ['10s', '-1s'],
    ['10s', '0.5ms'],
  ] as const)(
    'rejects --timeout %s with --claim-margin %s before execution',
    async ([timeout, margin], { cli }) => {
      const stateDir = await stateDirectory();
      const execute = vi.spyOn(TickWorkflowExecutor.prototype, 'execute');
      const output = await cli.run(WorkflowTick, [
        '--state-dir',
        stateDir,
        '--timeout',
        timeout,
        '--claim-margin',
        margin,
      ]);
      expect(output.error).toMatchObject({ code: 'usage.flag', oclif: { exit: 2 } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('renders a deadline skip and an interrupted suspension', async ({ cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(TickWorkflowExecutor.prototype, 'execute').mockResolvedValue({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [
        {
          runId: 'run-a',
          outcome: 'suspended',
          nextWakeAt: Date.UTC(2030, 0, 1),
          message: 'Tick timeout reached.',
        },
      ],
      skipped: [{ runId: 'run-b', reason: 'deadline', nextWakeAt: null }],
      observed: 0,
      exitCode: 0,
    });
    const output = await cli.run(WorkflowTick, ['--state-dir', stateDir]);
    expect(output.stdout).toContain(
      [
        'run-a: suspended: Tick timeout reached. (next wake 2030-01-01T00:00:00.000Z)',
        'run-b: skipped: deadline',
      ].join('\n'),
    );
  });

  it.for([
    ['run.locked', 3],
    ['workflow.storage', 74],
  ] as const)('maps the %s failure to exit %i', async ([code, exit], { cli }) => {
    const stateDir = await stateDirectory();
    vi.spyOn(TickWorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure(code, `Failure ${code}.`),
    );
    const human = await cli.run(WorkflowTick, ['--state-dir', stateDir]);
    expect(human.error).toMatchObject({ code, oclif: { exit } });
    expect(human.exitCode).toBeUndefined();
    const json = await cli.run(WorkflowTick, ['--state-dir', stateDir, '--json']);
    expect(json.error).toMatchObject({ oclif: { exit } });
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, exitCode: exit, error: { code } });
  });
});

describe('workflow start adapter', () => {
  afterEach(() => {
    setSpawnLauncher(undefined);
  });
  const launcher = ['/bin/node', '/checkout/bin/run.js'];
  const started = (stateDir: string) => ({
    kind: 'workflow.start.result' as const,
    ok: true as const,
    exitCode: 0 as const,
    runId: 'x',
    stateDir,
    pid: 42,
    status: 'running' as const,
    log: `${stateDir}/x/launch/1.log`,
    result: `${stateDir}/x/launch/1.result.json`,
    next: [{ why: 'Inspect it.', argv: ['qc', 'workflow', 'inspect', 'x'] }],
  });

  it('builds the runner argv behind the spawn launcher and prints the started run', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    setSpawnLauncher(launcher);
    const execute = vi
      .spyOn(StartWorkflowExecutor.prototype, 'execute')
      .mockResolvedValue(started(stateDir));
    const output = await cli.run(WorkflowStart, [
      'wf.ts',
      '--run-id',
      'x',
      '--state-dir',
      stateDir,
      '--provider-limit',
      'codex=1',
      '--start-timeout',
      '5s',
      '--kill-grace-ms',
      '250',
    ]);
    expect(output.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({
      kind: 'workflow.start',
      runId: 'x',
      stateDir,
      cwd: process.cwd(),
      argv: [
        ...launcher,
        'workflow',
        'execute',
        'wf.ts',
        '--run-id',
        'x',
        '--state-dir',
        stateDir,
        '--provider-limit',
        'codex=1',
        '--kill-grace-ms',
        '250',
        '--json',
      ],
      timeoutMs: 5000,
      killGraceMs: 250,
    });
    expect(output.stdout).toBe(
      [
        'Started run x (runner PID 42, status running).',
        `Log: ${stateDir}/x/launch/1.log`,
        `Result: ${stateDir}/x/launch/1.result.json`,
        'Next: qc workflow inspect x  (Inspect it.)',
      ].join('\n'),
    );
  });

  it('generates a run ID, defaults the timeout and grace, and prints JSON', async ({ cli }) => {
    const stateDir = await stateDirectory();
    setSpawnLauncher(launcher);
    const execute = vi
      .spyOn(StartWorkflowExecutor.prototype, 'execute')
      .mockResolvedValue(started(stateDir));
    const output = await cli.run(WorkflowStart, [
      'wf.ts',
      '--state-dir',
      stateDir,
      '--json',
      '--kill-grace-ms',
      '0',
    ]);
    expect(output.error).toBeUndefined();
    const plan = execute.mock.calls[0]?.[0];
    expect(plan?.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(plan?.argv.slice(-3)).toEqual(['--run-id', plan?.runId, '--json']);
    expect(plan).toMatchObject({ timeoutMs: 60_000, killGraceMs: 3000 });
    expect(JSON.parse(output.stdout)).toMatchObject({ kind: 'workflow.start.result', runId: 'x' });
  });

  it('propagates a runner failure with its launch evidence and no run ID', async ({ cli }) => {
    const stateDir = await stateDirectory();
    setSpawnLauncher(launcher);
    const launch = {
      runId: 'x',
      pid: 42,
      log: '/l',
      result: '/r',
      exitCode: 4,
      signal: null,
    };
    vi.spyOn(StartWorkflowExecutor.prototype, 'execute').mockResolvedValue(
      workflowFailure('load.typecheck', 'Workflow type check failed.', {
        stateDir,
        launch,
        diagnostics: [
          {
            category: 'error',
            code: 2322,
            column: 7,
            filePath: `${stateDir}/wf.ts`,
            line: 2,
            message: 'Nope.',
            relatedInformation: [],
          },
        ],
      }),
    );
    const output = await cli.run(WorkflowStart, [
      'wf.ts',
      '--run-id',
      'x',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    expect(output.error).toMatchObject({ oclif: { exit: 4 } });
    expect(output.stderr).toContain('Log: /l');
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      exitCode: 4,
      error: { code: 'load.typecheck' },
      runId: null,
      launch,
    });
  });

  it('refuses without a spawn launcher or with an invalid timeout, before executing', async ({
    cli,
  }) => {
    const stateDir = await stateDirectory();
    const execute = vi.spyOn(StartWorkflowExecutor.prototype, 'execute');
    const missing = await cli.run(WorkflowStart, ['wf.ts', '--state-dir', stateDir]);
    expect(missing.error).toMatchObject({ code: 'usage.flag', oclif: { exit: 2 } });
    setSpawnLauncher(launcher);
    const timeout = await cli.run(WorkflowStart, [
      'wf.ts',
      '--state-dir',
      stateDir,
      '--start-timeout',
      '0s',
    ]);
    expect(timeout.error).toMatchObject({ code: 'usage.flag', oclif: { exit: 2 } });
    const resume = await cli.run(WorkflowStart, ['wf.ts', '--resume']);
    expect(resume.error).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

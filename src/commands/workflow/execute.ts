import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { CliHarness } from '../../harnesses/cli.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { JsonValue } from '../../workflow/runtime/model.js';
import { analyzeTypecheckEntrypoint } from '../../workflow/typecheck/plan.js';

interface WorkflowExecuteArgs {
  readonly file: string;
}

interface WorkflowExecuteFlags {
  readonly input: string | undefined;
  readonly 'run-id': string | undefined;
  readonly resume: boolean | undefined;
  readonly 'state-dir': string;
  readonly json: boolean | undefined;
}

export default class WorkflowExecute extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowExecuteArgs> = {
    file: Args.file({
      description: 'Trusted TypeScript workflow module',
      exists: true,
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowExecuteFlags> = {
    input: Flags.string({
      description: 'JSON workflow input; defaults to {} for new runs, saved input on resume',
    }),
    'run-id': Flags.string({ description: 'Run identifier; generated for new runs' }),
    resume: Flags.boolean({
      description: 'Replay an existing run using its completed checkpoints',
      default: false,
    }),
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({ description: 'Print the completed run record as JSON', default: false }),
  };

  public static override readonly summary =
    'Execute or resume a typed workflow with durable checkpoints';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowExecute);
    if (flags.resume && flags['run-id'] === undefined) {
      this.error('--resume requires --run-id.', { exit: 2 });
    }
    const analysis = analyzeTypecheckEntrypoint(args.file, process.cwd());
    if (!analysis.ok) {
      this.error(analysis.error.message, { code: analysis.error.code, exit: 2 });
    }
    let input: JsonValue | undefined;
    if (flags.input !== undefined) {
      try {
        input = JSON.parse(flags.input) as JsonValue;
      } catch {
        this.error('--input must contain valid JSON.', { exit: 2 });
      }
    } else if (!flags.resume) {
      input = {};
    }
    const runId = flags['run-id'] ?? randomUUID();
    this.logToStderr(`Run ID: ${runId}`);
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort(new Error('Workflow interrupted.'));
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const executor = new WorkflowExecutor({
        logger: this.createExecutionLogger(flags),
        harness: new CliHarness(),
        signal: controller.signal,
      });
      const result = await executor.execute({
        kind: 'workflow.execute',
        typecheck: analysis.plan,
        runId,
        stateDir: resolve(flags['state-dir']),
        cwd: process.cwd(),
        resume: flags.resume ?? false,
        ...(input === undefined ? {} : { input }),
      });
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
        }
        this.error(result.message, { exit: controller.signal.aborted ? 130 : 1 });
      }
      if (result.kind === 'workflow.run.result') {
        for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
        this.log(
          flags.json
            ? JSON.stringify(result.run)
            : `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
        );
      }
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}

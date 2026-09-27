import { resolve } from 'node:path';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';

export default class WorkflowResume extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({
      description: 'Run whose stored entrypoint should resume',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string;
    readonly json: boolean | undefined;
    readonly 'accept-code-change': boolean | undefined;
    readonly 'allow-harness-change': boolean | undefined;
    readonly 'kill-orphans': boolean | undefined;
    readonly harness: string;
    readonly 'harness-config': string | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({ description: 'Print the result or structured error as JSON' }),
    'accept-code-change': Flags.boolean({
      description: 'Record source/schema acceptance; retain question and step identity checks',
    }),
    'allow-harness-change': Flags.boolean({
      description: 'Accept saved effects from another harness kind',
    }),
    'kill-orphans': Flags.boolean({
      description: 'Recover identity-confirmed orphan children before resuming',
    }),
    harness: Flags.string({ description: 'cli or fixture:<JSON file>', default: 'cli' }),
    'harness-config': Flags.string({ description: 'CliHarness configuration JSON or @file' }),
  };
  public static override readonly summary =
    'Resume a run using its stored entrypoint and working directory';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowResume);
    this.runContext(args.runId, flags['state-dir']);
    let harness: HarnessSelection;
    try {
      harness = await readHarnessSelection(flags.harness, flags['harness-config'], process.cwd());
    } catch (error) {
      this.fail('usage.flag', error instanceof Error ? error.message : String(error));
    }
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.resume',
      runId: args.runId,
      stateDir: resolve(flags['state-dir']),
      harness,
      acceptCodeChange: flags['accept-code-change'] ?? false,
      allowHarnessChange: flags['allow-harness-change'] ?? false,
      killOrphans: flags['kill-orphans'] ?? false,
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      this.failResult(result);
    }
    if (result.kind === 'workflow.run.result') {
      if (result.run.status === 'suspended') {
        this.suspended(result.run);
        return;
      }
      for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
      this.outputSavedCompletion(
        result.run,
        `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}

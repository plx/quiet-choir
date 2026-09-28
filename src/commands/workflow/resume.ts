import { parseRunBudget, runBudgetFlags } from '../../cli/run-budget.js';
import type { RunBudgetPolicy } from '../../workflow/runtime/run-budget.js';
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
    readonly 'max-child-depth': number | undefined;
    readonly 'max-run-cost-usd': string | undefined;
    readonly 'max-run-agent-attempts': string | undefined;
    readonly 'state-dir': string | undefined;
    readonly json: boolean | undefined;
    readonly 'accept-code-change': boolean | undefined;
    readonly 'allow-harness-change': boolean | undefined;
    readonly 'kill-orphans': boolean | undefined;
    readonly harness: string;
    readonly 'harness-config': string | undefined;
    readonly 'notify-command': string | undefined;
    readonly 'wait-mode': 'suspend' | 'block' | undefined;
  }> = {
    'max-child-depth': Flags.integer({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      description: 'Replace the saved inline child depth limit',
    }),
    ...runBudgetFlags,
    'notify-command': Flags.string({
      description: 'Best-effort sh -c hook receiving event JSON on stdin',
      env: 'QUIET_CHOIR_NOTIFY_COMMAND',
    }),

    'wait-mode': Flags.option({ options: ['suspend', 'block'] as const })({
      description: 'Suspend long waits (default) or keep waiting in this process',
    }),
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
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
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    this.logToStderr(`Run ID: ${args.runId}\nState directory: ${stateDir}`);
    let runBudget: Partial<RunBudgetPolicy>;
    let harness: HarnessSelection;
    try {
      runBudget = parseRunBudget(flags['max-run-cost-usd'], flags['max-run-agent-attempts']);
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
      ...(flags['max-child-depth'] === undefined
        ? {}
        : { maxChildDepth: flags['max-child-depth'] }),
      ...runBudget,
      ...(flags['notify-command'] === undefined ? {} : { notifyCommand: flags['notify-command'] }),
      ...(flags['wait-mode'] === undefined ? {} : { waitMode: flags['wait-mode'] }),
      runId: args.runId,
      stateDir: stateDir,
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
        { ...result.run, stateDir },
        `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}

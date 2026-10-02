import { parseRunBudget, runBudgetFlags } from '../../cli/run-budget.js';
import type { RunBudgetPolicy } from '../../workflow/runtime/run-budget.js';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { eventsFlag, executeFlags, worktreePlan } from '../../cli/execute-flags.js';
import { requestedFull } from '../../cli/workflow-errors.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { formatWorkflowDiagnostic } from '../../cli/presentation.js';

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
    readonly full: boolean | undefined;
    readonly 'accept-code-change': boolean | undefined;
    readonly 'allow-harness-change': boolean | undefined;
    readonly 'allow-harness-config-change': boolean | undefined;
    readonly 'kill-orphans': boolean | undefined;
    readonly harness: string[] | undefined;
    readonly 'harness-config': string | undefined;
    readonly 'notify-command': string | undefined;
    readonly events: string | undefined;
    readonly 'wait-mode': 'suspend' | 'block' | undefined;
    readonly 'worktree-keep': 'all' | 'failed' | 'none' | undefined;
    readonly 'worktree-root': string | undefined;
    readonly 'strict-replay': boolean | undefined;
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
    events: eventsFlag(),

    'wait-mode': Flags.option({ options: ['suspend', 'block'] as const })({
      description:
        'Suspend long waits or keep waiting in this process; omitted uses the mode the run last executed with (default suspend)',
    }),
    'worktree-keep': Flags.option({ options: ['all', 'failed', 'none'] as const })({
      description:
        'Worktree cache retention; omitted uses the value the run last executed with, else the definition (default failed)',
    }),
    'worktree-root': Flags.string({
      description:
        'Worktree cache container, resolved against cwd; omitted uses the value the run last executed with. A run keeps the root it first used',
    }),
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({
      description: 'Print the run result or structured error as JSON; --full for the whole record',
    }),
    full: Flags.boolean({
      description: 'With --json, print the full run record instead of the compact result',
    }),
    'accept-code-change': Flags.boolean({
      description:
        'Record source/schema acceptance; retain question and step identity checks. Refuses without changes when a completed step changed',
    }),
    'allow-harness-change': Flags.boolean({
      description: 'Accept saved effects from another harness kind',
    }),
    'allow-harness-config-change': Flags.boolean({
      description: 'Accept a --harness-config different from the one the run last executed with',
    }),
    'kill-orphans': Flags.boolean({
      description: 'Recover identity-confirmed orphan children before resuming',
    }),
    'strict-replay': executeFlags['strict-replay'],
    harness: Flags.string({
      description:
        'cli, fixture:<file>, or name=fixture:<file>; repeatable. Omitted uses the selection the run last executed with (default cli)',
      multiple: true,
    }),
    'harness-config': Flags.string({
      env: 'QUIET_CHOIR_HARNESS_CONFIG',
      description: 'Adapter configuration JSON or @file (harnesses.<name> for packages)',
    }),
  };
  public static override readonly summary =
    'Resume a run using its stored entrypoint and working directory';
  protected override compactRunDocuments(): boolean {
    return !requestedFull(this.argv);
  }

  public async run(): Promise<void> {
    this.refuseEventsStdoutWithJson();
    const { args, flags } = await this.parse(WorkflowResume);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    this.logToStderr(`Run ID: ${args.runId}\nState directory: ${stateDir}`);
    let runBudget: Partial<RunBudgetPolicy>;
    let harness: HarnessSelection;
    let worktrees: ReturnType<typeof worktreePlan>;
    try {
      worktrees = worktreePlan(flags['worktree-keep'], flags['worktree-root'], process.cwd());
      runBudget = parseRunBudget(flags['max-run-cost-usd'], flags['max-run-agent-attempts']);
      harness = await readHarnessSelection(
        flags.harness ?? 'cli',
        flags['harness-config'],
        process.cwd(),
      );
    } catch (error) {
      this.fail('usage.flag', error instanceof Error ? error.message : String(error));
    }
    const events = this.eventsOptions(flags.events);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
      ...events.executor,
    });
    const result = await executor.execute({
      kind: 'workflow.resume',
      ...(flags['max-child-depth'] === undefined
        ? {}
        : { maxChildDepth: flags['max-child-depth'] }),
      ...runBudget,
      ...(flags['notify-command'] === undefined ? {} : { notifyCommand: flags['notify-command'] }),
      ...events.plan,
      ...(flags['wait-mode'] === undefined ? {} : { waitMode: flags['wait-mode'] }),
      ...worktrees,
      runId: args.runId,
      stateDir: stateDir,
      harness,
      inheritHarness: flags.harness === undefined,
      acceptCodeChange: flags['accept-code-change'] ?? false,
      allowHarnessChange: flags['allow-harness-change'] ?? false,
      allowHarnessConfigChange: flags['allow-harness-config-change'] ?? false,
      killOrphans: flags['kill-orphans'] ?? false,
      ...(flags['strict-replay'] === undefined ? {} : { strictReplay: flags['strict-replay'] }),
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatWorkflowDiagnostic(diagnostic, process.cwd()));
      this.failResult(result);
    }
    if (result.kind === 'workflow.run.result') {
      if (result.run.status === 'suspended') {
        this.suspended(result.run);
        return;
      }
      for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
      this.outputSavedCompletion(
        this.runResult(result.run, stateDir),
        `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}

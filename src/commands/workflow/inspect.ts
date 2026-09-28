import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatRunSummary, parseWatchInterval, watchExitCodes } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { RunInspection } from '../../workflow/loader/inspection.js';

interface WorkflowInspectArgs {
  readonly runId: string;
}
interface WorkflowInspectFlags {
  readonly 'state-dir': string | undefined;
  readonly json: boolean | undefined;
  readonly summary: boolean | undefined;
  readonly watch: boolean | undefined;
  readonly interval: string | undefined;
}

export default class WorkflowInspect extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowInspectArgs> = {
    runId: Args.string({ description: 'Persisted run identifier', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<WorkflowInspectFlags> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({
      description: 'Print the run as JSON (JSONL per change with --watch)',
      default: false,
    }),
    summary: Flags.boolean({
      description: 'Print the compact dashboard data as JSON',
      dependsOn: ['json'],
    }),
    watch: Flags.boolean({
      description: 'Wait until completed, failed, cancelled, or stale; exit with that status',
    }),
    interval: Flags.string({
      description: 'Watch polling interval, e.g. 2s or 250ms (default 2s)',
      dependsOn: ['watch'],
    }),
  };
  public static override readonly summary =
    'Inspect or watch a workflow without importing its code';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowInspect);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const intervalMs = parseWatchInterval(flags.interval ?? '2s');
    const render = (value: RunInspection): void => {
      const human = `${flags.watch && !flags.json && process.stdout.isTTY ? '\u001b[2J\u001b[H' : ''}${formatRunSummary(value.summary, flags.verbose)}`;
      this.output(
        flags.summary ? value.summary : { ...value.run, ownership: value.ownership },
        human,
      );
    };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
      onInspection: render,
    });
    const result = await executor.execute({
      ...(flags.watch
        ? { kind: 'workflow.watch' as const, intervalMs }
        : { kind: 'workflow.inspect' as const }),
      runId: args.runId,
      stateDir: stateDir,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.run.result' && result.summary && result.ownership) {
      if (flags.watch) process.exitCode = watchExitCodes[result.summary.status];
      else render({ run: result.run, summary: result.summary, ownership: result.ownership });
    }
  }
}

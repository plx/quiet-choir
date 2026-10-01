import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowClean extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({
      description: 'Run whose isolated checkout caches should be removed',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly json: boolean | undefined;
    readonly refs: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Runs container; defaults to environment, legacy discovery, then project state',
    }),
    json: Flags.boolean({ description: 'Print cleanup results as JSON' }),
    refs: Flags.boolean({
      description:
        'Also delete this run’s pinned Git refs; future recovery may lose these commits after Git garbage collection',
    }),
  };
  public static override readonly summary =
    'Remove run-owned worktree caches without importing workflow code';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowClean);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.clean',
      runId: args.runId,
      stateDir,
      refs: flags.refs ?? false,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.clean.result')
      this.output(
        result,
        [
          `Removed ${String(result.directories.length)} worktree caches and ${String(result.refs.length)} pinned refs for ${result.runId}.`,
          ...result.warnings.map((warning) => `Warning: ${warning}`),
        ].join('\n'),
      );
  }
}

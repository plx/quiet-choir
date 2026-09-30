import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowUnlock extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({
      description: 'Run whose abandoned lock should be cleared',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly 'force-remote': boolean | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Runs container; defaults to environment, legacy discovery, then project state',
    }),
    'force-remote': Flags.boolean({
      description:
        'Assert that a foreign recorded host is this machine under an old name or is permanently gone, so its owner, recoverer and children are judged by local PID observations',
    }),
    json: Flags.boolean({ description: 'Print the unlock result as JSON' }),
  };
  public static override readonly summary =
    'Clear an abandoned run lock without importing workflow code';
  public static override readonly description =
    'Refuses (exit 3) while any lock owner or recoverer is alive or unverifiable, while a recorded child process is alive or unverifiable, or while a lock belongs to a foreign host without --force-remote. Removes locks only by the tombstone rename and never signals a process.';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowUnlock);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.unlock',
      runId: args.runId,
      stateDir,
      forceRemote: flags['force-remote'] ?? false,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.unlock.result')
      this.output(
        result,
        result.locks.length === 0
          ? `Run ${result.runId} is not locked.`
          : result.locks
              .flatMap((lock) => [
                `${lock.action === 'removed' ? 'Removed' : 'Already gone:'} ${lock.kind} lock ${lock.path} (${
                  lock.owner
                    ? `owner PID ${String(lock.owner.pid)} on ${lock.owner.host}, ${lock.owner.state}`
                    : 'no readable owner'
                }${
                  lock.recovery
                    ? `; recoverer PID ${String(lock.recovery.pid)} on ${lock.recovery.host}, ${lock.recovery.state}`
                    : ''
                }).`,
                ...(lock.warning === undefined ? [] : [`Warning: ${lock.warning}`]),
              ])
              .join('\n'),
      );
  }
}

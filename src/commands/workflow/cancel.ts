import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { parseWatchBound } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowCancel extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({
      description: 'Unfinished run to end as cancelled',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly force: boolean | undefined;
    readonly timeout: string | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Runs container; defaults to environment, legacy discovery, then project state',
    }),
    force: Flags.boolean({
      description:
        'If the run has not ended at the timeout and the same verified owner still holds it, send a second SIGINT, which force-kills its process groups (the run may stay running)',
    }),
    timeout: Flags.string({
      description:
        'How long to wait for the run to end after each signal, e.g. 30s or 2m (default 30s); then exit 79 (watch.timeout) while the run keeps running',
    }),
    json: Flags.boolean({ description: 'Print the cancel result as JSON' }),
  };
  public static override readonly summary =
    'End an unfinished run as cancelled, signalling only its identity-verified owner';
  public static override readonly description =
    'A run that no process owns (suspended, or running with no lock) is saved as cancelled under its lock, without a signal. Otherwise signals only a live lock owner on this host whose recorded OS start time still matches, after leaving a cancel request bound to that execution, then waits for the run to end. A cancelled owner exits 130, and tick does not resume a cancelled run. Refuses (exit 3, run.locked) for a foreign, dead, released or unverifiable owner, whose lock workflow unlock clears before a second cancel, and (exit 3, run.unowned) when the owner exits without saving cancelled; an already finished run is a no-op (exit 0).';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowCancel);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const timeoutMs = parseWatchBound(flags.timeout ?? '30s');
    if (timeoutMs === null)
      this.fail(
        'usage.flag',
        '--timeout must be a positive duration such as 30s, 2m or 250ms (at most 2147483647ms).',
      );
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.cancel',
      runId: args.runId,
      stateDir,
      force: flags.force ?? false,
      timeoutMs,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.cancel.result')
      this.output(
        result,
        result.previousStatus !== null
          ? `Run ${result.runId} was ${result.previousStatus} with no owner; saved cancelled.`
          : result.owner === null
            ? `Run ${result.runId} is already ${result.status}; nothing to cancel.`
            : result.status === 'cancelled'
              ? `Run ${result.runId} cancelled.`
              : `Run ${result.runId} ended ${result.status}.`,
      );
  }

  /** Failure documents carry the bounded summary, never the whole record. */
  protected override compactRunDocuments(): boolean {
    return true;
  }
}

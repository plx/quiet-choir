import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { parseWatchBound } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowCancel extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({
      description: 'Run whose live local execution should end',
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
    'End a live local run as cancelled, signalling only its identity-verified owner';
  public static override readonly description =
    'Signals only a live lock owner on this host whose recorded OS start time still matches, after leaving a cancel request bound to that execution, then waits for the run to end. A cancelled owner exits 130 and tick does not resume the run. Refuses (exit 3, run.locked) for a foreign, dead, released or unverifiable owner and (exit 3, run.unowned) for an unfinished run no process owns; an already finished run is a no-op (exit 0).';

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
        result.owner === null
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

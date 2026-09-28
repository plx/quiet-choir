import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowFixtures extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({ description: 'Completed run to export', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({
      description: 'Print reusable fixture JSON (also the default human output)',
      default: false,
    }),
  };
  public static override readonly summary = 'Export completed agent outputs for fixture rehearsal';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowFixtures);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.fixtures',
      runId: args.runId,
      stateDir: stateDir,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.fixtures.result')
      this.output(result.fixtures, JSON.stringify(result.fixtures, null, 2));
  }
}

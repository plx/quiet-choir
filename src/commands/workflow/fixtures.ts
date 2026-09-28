import { resolve } from 'node:path';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowFixtures extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({ description: 'Completed run to export', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({
      description: 'Print reusable fixture JSON (also the default human output)',
      default: false,
    }),
  };
  public static override readonly summary = 'Export completed agent outputs for fixture rehearsal';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowFixtures);
    this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.fixtures',
      runId: args.runId,
      stateDir: resolve(flags['state-dir']),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.fixtures.result')
      this.output(result.fixtures, JSON.stringify(result.fixtures, null, 2));
  }
}

import { resolve } from 'node:path';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowPending extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({ description: 'Print waiting questions as JSON' }),
  };
  public static override readonly summary = 'List waiting questions without loading workflow code';
  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowPending);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.pending',
      stateDir: resolve(flags['state-dir']),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.pending.result')
      this.output(
        result,
        result.pending
          .map(
            (q) =>
              `${q.runId} ${q.stepId} [${q.audience}] ${q.prompt}${q.codeChanged ? ' (source changed; check resume before requesting a decision)' : ''}${q.rejections.length ? `\n  Last rejection: ${q.rejections.at(-1)?.error ?? ''}` : ''}`,
          )
          .join('\n') || 'No pending questions.',
      );
  }
}

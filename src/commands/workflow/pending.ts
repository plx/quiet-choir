import { resolve } from 'node:path';
import { resolveStateDir } from '../../workflow/runtime/paths.js';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowPending extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({ description: 'Print waiting questions as JSON' }),
  };
  public static override readonly summary = 'List waiting questions without loading workflow code';
  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowPending);
    const stateDir = resolveStateDir(
      flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] },
    );
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.pending',
      additionalStateDirs:
        flags['state-dir'] === undefined && process.env['QUIET_CHOIR_STATE_DIR'] === undefined
          ? [resolve('.quiet-choir/runs')]
          : [],
      stateDir: stateDir,
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

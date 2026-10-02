import { resolve } from 'node:path';
import { resolveStateDir } from '../../workflow/runtime/paths.js';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatNextCommands } from '../../cli/presentation.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowPending extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly json: boolean | undefined;
    readonly all: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({ description: 'Print parked questions, polls, and deadlines as JSON' }),
    all: Flags.boolean({
      description: 'Include answered rows and rows of failed, cancelled or completed runs',
    }),
  };
  public static override readonly summary = 'List parked waits without loading workflow code';
  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowPending);
    const stateDir = resolveStateDir(
      flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] },
    );
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.pending',
      additionalStateDirs:
        flags['state-dir'] === undefined && process.env['QUIET_CHOIR_STATE_DIR'] === undefined
          ? [resolve('.quiet-choir/runs')]
          : [],
      stateDir: stateDir,
      ...(flags.all === undefined ? {} : { all: flags.all }),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.pending.result') {
      const rows = result.pending.map((q) => {
        const head =
          'kind' in q
            ? `${q.runId} ${q.stepId} [wait] checks=${String(q.checks)} nextCheckAt=${String(q.nextCheckAt)} deadline=${String(q.deadline)}${q.command ? ` command=${JSON.stringify(q.command)}` : ''}${q.signal ? ` ${q.signal.prompt}` : ''}`
            : `${q.runId} ${q.stepId} [${q.audience}] ${q.prompt}${q.codeChanged ? ' (source changed; check resume before requesting a decision)' : ''}`;
        const marks = `${q.delivery?.state === 'queued' ? ` (answer queued${q.delivery.by === null ? '' : ` by ${q.delivery.by}`}${q.delivery.at === null ? '' : ` at ${q.delivery.at}`})` : ''}${q.runStatus === 'running' || q.runStatus === 'suspended' ? '' : ` [run ${q.runStatus}]`}`;
        const detail =
          'kind' in q
            ? `${q.note === null ? '' : `\n  ${JSON.stringify(q.note)}`}${q.lastError ? `\n  lastError (consecutive=${String(q.lastError.consecutive)}): ${q.lastError.message}` : ''}`
            : q.rejections.length
              ? `\n  Last rejection: ${q.rejections.at(-1)?.error ?? ''}`
              : '';
        return [`${head}${marks}${detail}`, ...formatNextCommands(q.next)].join('\n');
      });
      this.output(
        result,
        [
          rows.join('\n') || 'No pending waits.',
          ...(result.hidden
            ? [`${String(result.hidden)} hidden (answered, or from ended runs); --all lists them.`]
            : []),
        ].join('\n'),
      );
    }
  }
}

import { resolve } from 'node:path';
import { resolveStateDir } from '../../workflow/runtime/paths.js';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatRunList } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import { toRunListRow, type InspectionStatus } from '../../workflow/loader/inspection.js';

interface WorkflowListFlags {
  readonly all: boolean | undefined;
  readonly 'state-dir': string | undefined;
  readonly status: InspectionStatus | undefined;
  readonly json: boolean | undefined;
  readonly full: boolean | undefined;
}

export default class WorkflowList extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<WorkflowListFlags> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    all: Flags.boolean({
      description: 'List every registered XDG project plus the current project',
      exclusive: ['state-dir'],
    }),
    status: Flags.option({
      options: ['running', 'failed', 'completed', 'cancelled', 'stale', 'suspended'] as const,
    })({ description: 'Filter by observed status' }),
    json: Flags.boolean({
      description:
        'Print runs, leftover launch directories of pre-record start failures and unreadable-checkpoint warnings as JSON',
      default: false,
    }),
    full: Flags.boolean({
      description: 'With --json, print full run summaries instead of compact rows',
      dependsOn: ['json'],
    }),
  };
  public static override readonly summary =
    'List saved workflows, newest first, without importing code';
  public static override readonly description =
    'Lists every saved run with its status, step counts, usage and on-disk size. Without --status it also reports leftover launch directories: the record-less <run-id>/launch/ of a start that failed before its record, once its runner has exited (or, without a runner record, an hour after its last write), each with the workflow rm command that removes it.';

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowList);
    const stateDir = resolveStateDir(
      flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] },
    );
    this.failureContext = { runId: null, stateDir: stateDir };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.list',
      all: flags.all ?? false,
      additionalStateDirs:
        flags['state-dir'] === undefined && process.env['QUIET_CHOIR_STATE_DIR'] === undefined
          ? [resolve('.quiet-choir/runs')]
          : [],
      stateDir: stateDir,
      ...(flags.status ? { status: flags.status } : {}),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.list.result') {
      for (const warning of result.warnings) this.logToStderr(`Warning: ${warning}`);
      this.output(
        flags.full ? result : { ...result, runs: result.runs.map(toRunListRow) },
        formatRunList(result.runs, flags.all ?? false, {
          leftoverLaunches: result.leftoverLaunches,
          launcher: this.commandLauncher,
        }),
      );
    }
  }
}

import { resolve } from 'node:path';
import { resolveStateDir } from '../../workflow/runtime/paths.js';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatRunList } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { InspectionStatus } from '../../workflow/loader/inspection.js';

interface WorkflowListFlags {
  readonly all: boolean | undefined;
  readonly 'state-dir': string | undefined;
  readonly status: InspectionStatus | undefined;
  readonly json: boolean | undefined;
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
      description: 'Print runs and unreadable-checkpoint warnings as JSON',
      default: false,
    }),
  };
  public static override readonly summary =
    'List saved workflows, newest first, without importing code';

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowList);
    const stateDir = resolveStateDir(
      flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] },
    );
    this.failureContext = { runId: null, stateDir: stateDir };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
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
      this.output(result, formatRunList(result.runs, flags.all ?? false));
    }
  }
}

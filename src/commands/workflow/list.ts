import { resolve } from 'node:path';
import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatRunList } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { InspectionStatus } from '../../workflow/loader/inspection.js';

interface WorkflowListFlags {
  readonly 'state-dir': string;
  readonly status: InspectionStatus | undefined;
  readonly json: boolean | undefined;
}

export default class WorkflowList extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<WorkflowListFlags> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
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
    this.failureContext = { runId: null, stateDir: resolve(flags['state-dir']) };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.list',
      stateDir: resolve(flags['state-dir']),
      ...(flags.status ? { status: flags.status } : {}),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.list.result') {
      for (const warning of result.warnings) this.logToStderr(`Warning: ${warning}`);
      this.output(result, formatRunList(result.runs));
    }
  }
}

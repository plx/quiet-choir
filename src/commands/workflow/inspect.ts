import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

interface WorkflowInspectArgs {
  readonly runId: string;
}

interface WorkflowInspectFlags {
  readonly 'state-dir': string;
  readonly json: boolean | undefined;
}

export default class WorkflowInspect extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowInspectArgs> = {
    runId: Args.string({ description: 'Persisted run identifier', required: true }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowInspectFlags> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({ description: 'Print the complete run record as JSON', default: false }),
  };

  public static override readonly summary =
    'Inspect a persisted workflow run without importing workflow code';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowInspect);
    const executor = new WorkflowExecutor({ logger: this.createExecutionLogger(flags) });
    const result = await executor.execute({
      kind: 'workflow.inspect',
      runId: args.runId,
      stateDir: resolve(flags['state-dir']),
    });
    if (!result.ok) {
      this.error(result.message, { exit: 1 });
    }
    if (result.kind === 'workflow.run.result') {
      this.log(
        flags.json
          ? JSON.stringify(result.run)
          : `Run ${result.run.id}: ${result.run.status}\nWorkflow: ${result.run.workflow.name}@${result.run.workflow.version}\nSteps: ${String(Object.keys(result.run.steps).length)}\n${result.run.error ?? JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}

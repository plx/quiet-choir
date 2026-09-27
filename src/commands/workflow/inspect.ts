import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

import type { RunOwnership } from '../../workflow/runtime/store.js';

function ownershipText(ownership: RunOwnership | undefined): string {
  if (!ownership?.locked) return 'Owner: no lock\n';
  const owner = ownership.owner;
  return `Owner: ${owner ? `pid ${String(owner.pid)} on ${owner.host} ${owner.state}${owner.state === 'dead' || owner.state === 'released' ? ': stale lock' : ''}` : 'unknown'}\n${ownership.warning ? `Warning: ${ownership.warning}\n` : ''}${ownership.processes.map((entry) => (entry.process ? `Process: ${entry.process.binary} pid ${String(entry.process.pid)} group ${String(entry.process.pgid)} step ${entry.process.stepId} attempt ${String(entry.process.attempt)} ${entry.state}\n` : `Process: ${entry.file} ${entry.state}: ${entry.detail ?? ''}\n`)).join('')}`;
}

interface WorkflowInspectArgs {
  readonly runId: string;
}

interface WorkflowInspectFlags {
  readonly 'state-dir': string;
  readonly json: boolean | undefined;
}

export default class WorkflowInspect extends WorkflowCommand {
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
    this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({ logger: this.createExecutionLogger(flags) });
    const result = await executor.execute({
      kind: 'workflow.inspect',
      runId: args.runId,
      stateDir: resolve(flags['state-dir']),
    });
    if (!result.ok) {
      this.failResult(result);
    }
    if (result.kind === 'workflow.run.result') {
      this.output(
        { ...result.run, ownership: result.ownership },
        `Run ${result.run.id}: ${result.run.status}\n${ownershipText(result.ownership)}Workflow: ${result.run.workflow.name}@${result.run.workflow.version}\nSteps: ${String(Object.keys(result.run.steps).length)}\n${Object.entries(
          result.run.harnesses ?? {},
        )
          .map(
            ([provider, value]) =>
              `Harness ${provider}: ${value.binary}@${value.version ?? 'unknown'}\n`,
          )
          .join(
            '',
          )}${(result.run.harnessWarnings ?? []).map((warning) => `Warning: ${warning}\n`).join('')}${result.run.rootCause ? `Root cause (${result.run.rootCause.stepId ?? 'workflow'}): ${result.run.rootCause.error}\n` : ''}${result.run.error ?? JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}

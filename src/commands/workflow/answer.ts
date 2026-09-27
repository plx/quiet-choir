import { resolve } from 'node:path';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { jsonValue } from '../../workflow/runtime/json.js';
import type { JsonValue } from '../../workflow/runtime/model.js';

export default class WorkflowAnswer extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{
    readonly runId: string;
    readonly stepId: string;
  }> = {
    runId: Args.string({ description: 'Run containing the question', required: true }),
    stepId: Args.string({ description: 'Fully qualified question step ID', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string;
    readonly value: string;
    readonly by: string | undefined;
    readonly resume: boolean | undefined;
    readonly harness: string;
    readonly 'harness-config': string | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    value: Flags.string({
      aliases: ['json'],
      description: 'Answer as JSON; --json VALUE also requests JSON output',
      required: true,
    }),
    by: Flags.string({ description: 'Self-asserted author; human questions require human:<name>' }),
    resume: Flags.boolean({ description: 'After delivery, resume using the stored entrypoint' }),
    harness: Flags.string({
      description: 'Harness for --resume: cli or fixture:<JSON file>',
      default: 'cli',
    }),
    'harness-config': Flags.string({
      description: 'Harness configuration for --resume',
      dependsOn: ['resume'],
    }),
  };
  public static override readonly summary =
    'Validate and deliver an answer without taking the run lock';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowAnswer);
    this.runContext(args.runId, flags['state-dir']);
    let value: JsonValue;
    try {
      value = jsonValue(JSON.parse(flags.value));
    } catch (error) {
      this.fail('answer.invalid', error instanceof Error ? error.message : String(error));
    }
    let harness: HarnessSelection | undefined;
    if (flags.resume) {
      try {
        harness = await readHarnessSelection(flags.harness, flags['harness-config'], process.cwd());
      } catch (error) {
        this.fail('usage.flag', error instanceof Error ? error.message : String(error));
      }
    }
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.answer',
      runId: args.runId,
      stepId: args.stepId,
      value,
      stateDir: resolve(flags['state-dir']),
      resume: flags.resume ?? false,
      ...(flags.by === undefined ? {} : { by: flags.by }),
      ...(harness === undefined ? {} : { harness }),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.answer.result')
      this.output(result, `Answer queued for ${args.runId}/${args.stepId}.`);
    if (result.kind === 'workflow.run.result') {
      if (result.run.status === 'suspended') {
        this.suspended(result.run);
        return;
      }
      this.outputSavedCompletion(result.run, `Run ${result.run.id} ${result.run.status}.`);
    }
  }
}

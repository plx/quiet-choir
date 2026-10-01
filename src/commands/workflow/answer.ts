import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { requestedFull } from '../../cli/workflow-errors.js';
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
    readonly 'state-dir': string | undefined;
    readonly value: string;
    readonly by: string | undefined;
    readonly resume: boolean | undefined;
    readonly full: boolean | undefined;
    readonly harness: string;
    readonly 'harness-config': string | undefined;
    readonly 'allow-harness-config-change': boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    value: Flags.string({
      aliases: ['json'],
      description: 'Answer as JSON; --json VALUE also requests JSON output',
      required: true,
    }),
    by: Flags.string({ description: 'Self-asserted author; human questions require human:<name>' }),
    resume: Flags.boolean({ description: 'After delivery, resume using the stored entrypoint' }),
    full: Flags.boolean({
      description:
        'Print the full run record: the success document with --resume, and run in suspension and failure documents',
    }),
    harness: Flags.string({
      description: 'Harness for --resume: cli or fixture:<JSON file>',
      default: 'cli',
    }),
    'harness-config': Flags.string({
      description: 'Harness configuration for --resume',
      dependsOn: ['resume'],
    }),
    'allow-harness-config-change': Flags.boolean({
      description: 'Accept a --harness-config different from the one the run last executed with',
      dependsOn: ['resume'],
    }),
  };
  public static override readonly summary =
    'Validate and deliver an answer without taking the run lock';
  protected override compactRunDocuments(): boolean {
    return !requestedFull(this.argv);
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowAnswer);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
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
      stateDir: stateDir,
      resume: flags.resume ?? false,
      ...(flags.by === undefined ? {} : { by: flags.by }),
      ...(harness === undefined ? {} : { harness }),
      ...(flags['allow-harness-config-change'] === undefined
        ? {}
        : { allowHarnessConfigChange: flags['allow-harness-config-change'] }),
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.answer.result')
      // The inbox write already made the delivery durable, so a late signal must not
      // relabel it as interrupted.
      this.outputSavedCompletion(result, `Answer queued for ${args.runId}/${args.stepId}.`);
    if (result.kind === 'workflow.run.result') {
      if (result.run.status === 'suspended') {
        this.suspended(result.run);
        return;
      }
      this.outputSavedCompletion(
        this.runResult(result.run, stateDir),
        `Run ${result.run.id} ${result.run.status}.`,
      );
    }
  }
}

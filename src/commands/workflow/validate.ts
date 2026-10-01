import { Args, Flags, type Interfaces } from '@oclif/core';

import { withoutHarnessOptions } from '../../cli/workflow-metadata-view.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

interface WorkflowValidateArgs {
  readonly file: string;
}

interface WorkflowValidateFlags {
  readonly json: boolean | undefined;
  readonly 'harness-schemas': boolean | undefined;
}

export default class WorkflowValidate extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowValidateArgs> = {
    file: Args.string({
      description: 'Trusted TypeScript workflow module',
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowValidateFlags> = {
    json: Flags.boolean({ description: 'Print workflow metadata as JSON', default: false }),
    'harness-schemas': Flags.boolean({
      description: 'With --json, include each harness option JSON Schema',
      dependsOn: ['json'],
    }),
  };

  public static override readonly summary =
    'Type-check a workflow and validate its exported definition';
  public static override readonly description =
    'Imports trusted module top-level code to inspect its default export; does not invoke the workflow body.';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowValidate);
    const typecheck = await this.entrypoint(args.file);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
    });
    const result = await executor.execute({ kind: 'workflow.validate', typecheck });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics) {
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      }
      this.failResult(result);
    }
    if (result.kind === 'workflow.validate.result') {
      this.output(
        flags['harness-schemas']
          ? result
          : { ...result, workflow: withoutHarnessOptions(result.workflow) },
        `Validated ${result.workflow.name}@${result.workflow.version} (${result.entrypoint}).`,
      );
    }
  }
}

import { Args, Flags, type Interfaces } from '@oclif/core';

import { compactWorkflowMetadata } from '../../cli/workflow-metadata-view.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatWorkflowDiagnostic } from '../../cli/presentation.js';
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
      description:
        'With --json, print the complete document: harness option JSON Schemas, the uncompacted capability manifest and the root entrypoint',
      dependsOn: ['json'],
    }),
  };

  public static override readonly summary =
    'Type-check and durability-lint a workflow and validate its exported definition';
  public static override readonly description =
    'After a clean type check, runs the static durability lint (QC001-QC005); any finding fails with exit 4 unless a `// quiet-choir-ignore QCnnn <reason>` line before it silences it. Then imports trusted module top-level code to inspect its default export; does not invoke the workflow body.';

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
        this.logToStderr(formatWorkflowDiagnostic(diagnostic, process.cwd()));
      }
      this.failResult(result);
    }
    if (result.kind === 'workflow.validate.result') {
      this.output(
        flags['harness-schemas']
          ? result
          : {
              ...result,
              workflow: compactWorkflowMetadata(result.workflow, result.entrypoint),
            },
        `Validated ${result.workflow.name}@${result.workflow.version} (${result.entrypoint}).`,
      );
    }
  }
}

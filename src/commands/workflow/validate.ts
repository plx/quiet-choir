import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../../workflow/typecheck/plan.js';

interface WorkflowValidateArgs {
  readonly file: string;
}

interface WorkflowValidateFlags {
  readonly json: boolean | undefined;
}

export default class WorkflowValidate extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowValidateArgs> = {
    file: Args.file({
      description: 'Trusted TypeScript workflow module',
      exists: true,
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowValidateFlags> = {
    json: Flags.boolean({ description: 'Print workflow metadata as JSON', default: false }),
  };

  public static override readonly summary =
    'Type-check a workflow and validate its exported definition';
  public static override readonly description =
    'Imports trusted module top-level code to inspect its default export; does not invoke the workflow body.';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowValidate);
    const analysis = analyzeTypecheckEntrypoint(args.file, process.cwd());
    if (!analysis.ok) {
      this.error(analysis.error.message, { code: analysis.error.code, exit: 2 });
    }
    const executor = new WorkflowExecutor({ logger: this.createExecutionLogger(flags) });
    const result = await executor.execute({ kind: 'workflow.validate', typecheck: analysis.plan });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics) {
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      }
      this.error(result.message, { exit: 1 });
    }
    if (result.kind === 'workflow.validate.result') {
      this.log(
        flags.json
          ? JSON.stringify(result)
          : `Validated ${result.workflow.name}@${result.workflow.version} (${result.entrypoint}).`,
      );
    }
  }
}

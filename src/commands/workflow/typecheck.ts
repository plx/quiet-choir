import { workflowFailure } from '../../workflow/loader/failure.js';
import { Args, Flags, type Interfaces } from '@oclif/core';

import { TypeScriptExecutor } from '../../workflow/typecheck/typescript-executor.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';

interface WorkflowTypecheckArgs {
  readonly file: string;
}

export default class WorkflowTypecheck extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowTypecheckArgs> = {
    file: Args.string({
      description: 'TypeScript workflow entrypoint to check',
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<{ json: boolean | undefined }> = {
    json: Flags.boolean({ description: 'Print the typecheck result as JSON', default: false }),
  };

  public static override readonly summary = 'Type-check a TypeScript workflow';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowTypecheck);
    const typecheck = await this.entrypoint(args.file);

    const executor = new TypeScriptExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(typecheck);

    for (const diagnostic of result.diagnostics) {
      this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));

      for (const relatedDiagnostic of diagnostic.relatedInformation) {
        this.logToStderr(`  ${formatTypecheckDiagnostic(relatedDiagnostic, process.cwd())}`);
      }
    }

    if (!result.ok) {
      const errorCount = result.diagnostics.filter(
        (diagnostic) => diagnostic.category === 'error',
      ).length;
      this.failResult(
        workflowFailure(
          'load.typecheck',
          `Type check failed with ${String(errorCount)} error${errorCount === 1 ? '' : 's'}.`,
          { diagnostics: result.diagnostics },
        ),
        true,
      );
    }

    const configuration = result.configPath ?? 'built-in Node ES2023 defaults';
    this.output(
      result,
      `Type check passed for ${result.entrypoint} (TypeScript ${result.compilerVersion}; ${configuration}).`,
    );
  }
}

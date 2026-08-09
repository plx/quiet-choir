import { Args, type Interfaces } from '@oclif/core';

import { TypeScriptExecutor } from '../../workflow/typecheck/typescript-executor.js';
import { analyzeTypecheckEntrypoint } from '../../workflow/typecheck/plan.js';
import { BaseCommand } from '../../cli/base-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';

interface WorkflowTypecheckArgs {
  readonly file: string;
}

export default class WorkflowTypecheck extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowTypecheckArgs> = {
    file: Args.file({
      description: 'TypeScript workflow entrypoint to check',
      exists: true,
      required: true,
    }),
  };

  public static override readonly summary = 'Type-check a TypeScript workflow';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowTypecheck);
    const analysis = analyzeTypecheckEntrypoint(args.file, process.cwd());

    if (!analysis.ok) {
      this.error(analysis.error.message, {
        code: analysis.error.code,
        exit: 2,
      });
    }

    const executor = new TypeScriptExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(analysis.plan);

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
      this.logToStderr(
        `Type check failed with ${String(errorCount)} error${errorCount === 1 ? '' : 's'}.`,
      );
      this.exit(1);
    }

    const configuration = result.configPath ?? 'built-in Node ES2023 defaults';
    this.log(
      `Type check passed for ${result.entrypoint} (TypeScript ${result.compilerVersion}; ${configuration}).`,
    );
  }
}

import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../../workflow/typecheck/plan.js';

interface CheckArgs {
  readonly file: string;
}
interface CheckFlags {
  readonly 'run-id': string;
  readonly 'state-dir': string;
  readonly 'accept-code-change': boolean | undefined;
  readonly json: boolean | undefined;
}

/** CLI adapter for read-only run compatibility inspection. */
export default class WorkflowCheckResume extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<CheckArgs> = {
    file: Args.file({
      description: 'Trusted workflow module to check',
      exists: true,
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<CheckFlags> = {
    'run-id': Flags.string({ description: 'Existing run identifier', required: true }),
    'state-dir': Flags.directory({
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    'accept-code-change': Flags.boolean({
      description: 'Check explicit source/schema acceptance instead of strict resume',
    }),
    json: Flags.boolean({
      description: 'Print compatibility and component differences as JSON',
      default: false,
    }),
  };
  public static override readonly summary =
    'Check run compatibility without a writer lock or workflow-body execution';
  public static override readonly description =
    'Typechecks and imports trusted module top-level code. Does not invoke effects or predict dynamic step identity or replay order.';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowCheckResume);
    const analysis = analyzeTypecheckEntrypoint(args.file, process.cwd());
    if (!analysis.ok) this.error(analysis.error.message, { code: analysis.error.code, exit: 2 });
    const executor = new WorkflowExecutor({ logger: this.createExecutionLogger(flags) });
    const result = await executor.execute({
      kind: 'workflow.check-resume',
      typecheck: analysis.plan,
      runId: flags['run-id'],
      stateDir: resolve(flags['state-dir']),
      cwd: process.cwd(),
      ...(flags['accept-code-change'] === undefined
        ? {}
        : { acceptCodeChange: flags['accept-code-change'] }),
    });
    if (!result.ok) {
      if (flags.json) {
        this.log(JSON.stringify(result));
        this.exit(1);
      }
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      this.error(result.message, { exit: 1 });
    }
    if (result.kind === 'workflow.check-resume.result') {
      this.log(flags.json ? JSON.stringify(result) : result.check.message);
      if (!result.check.compatible) this.exit(1);
    }
  }
}

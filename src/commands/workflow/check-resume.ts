import { Args, Flags, type Interfaces } from '@oclif/core';

import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

interface CheckArgs {
  readonly file: string;
}
interface CheckFlags {
  readonly 'run-id': string;
  readonly 'state-dir': string | undefined;
  readonly 'accept-code-change': boolean | undefined;
  readonly json: boolean | undefined;
}

/** CLI adapter for read-only run compatibility inspection. */
export default class WorkflowCheckResume extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<CheckArgs> = {
    file: Args.string({
      description: 'Trusted workflow module to check',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<CheckFlags> = {
    'run-id': Flags.string({ description: 'Existing run identifier', required: true }),
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
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
    'Typechecks and imports trusted module top-level code. Does not invoke effects or predict dynamic step identity or replay order; preview an accepted resume with workflow execute FILE --dry-run --resume --accept-code-change, which reports a changed completed step as run.incompatible.';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowCheckResume);
    const stateDir = this.runContext(flags['run-id'], flags['state-dir']);
    const typecheck = await this.entrypoint(args.file);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.check-resume',
      typecheck,
      runId: flags['run-id'],
      stateDir: stateDir,
      cwd: process.cwd(),
      ...(flags['accept-code-change'] === undefined
        ? {}
        : { acceptCodeChange: flags['accept-code-change'] }),
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      this.failResult(result);
    }
    if (result.kind === 'workflow.check-resume.result') {
      this.output(result, result.check.message);
    }
  }
}

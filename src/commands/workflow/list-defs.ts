import { Args, Flags, type Interfaces } from '@oclif/core';
import { resolve } from 'node:path';
import { compactWorkflowMetadata } from '../../cli/workflow-metadata-view.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowListDefinitions extends WorkflowCommand {
  public static override readonly strict = false;
  public static override readonly args: Interfaces.ArgInput<{
    readonly directory: string | undefined;
  }> = {
    directory: Args.string({
      description: 'Trusted directory; additional directories may follow',
      required: false,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly json: boolean | undefined;
    readonly refresh: boolean | undefined;
    readonly 'harness-schemas': boolean | undefined;
  }> = {
    json: Flags.boolean({ description: 'Print validated workflow schemas and metadata as JSON' }),
    'harness-schemas': Flags.boolean({
      description:
        'With --json, print the complete document: harness option JSON Schemas, the uncompacted capability manifest and the root entrypoint',
      dependsOn: ['json'],
    }),
    refresh: Flags.boolean({
      description: 'Recheck and import definitions even when their source cache matches',
    }),
  };
  public static override readonly summary =
    'Discover trusted *.workflow.ts, .mts and .cts definitions in directories';
  public static override readonly description =
    'Recursively type-checks and imports trusted modules without calling workflow bodies. Matching source fingerprints reuse private metadata caches. Duplicate names are errors.';

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(WorkflowListDefinitions);
    const directories = argv.length
      ? argv.map((value) => {
          if (typeof value !== 'string') this.fail('usage.flag', 'Directories must be strings.');
          return resolve(value);
        })
      : [process.cwd()];
    const result = await new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
    }).execute({ kind: 'workflow.list-defs', directories, refresh: flags.refresh ?? false });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.list-defs.result')
      this.output(
        flags['harness-schemas']
          ? result
          : {
              ...result,
              definitions: result.definitions.map((entry) => ({
                ...entry,
                workflow: compactWorkflowMetadata(entry.workflow, entry.entrypoint),
              })),
            },
        result.definitions
          .map(
            (entry) =>
              `${entry.workflow.name}@${entry.workflow.version}\t${entry.entrypoint}${entry.workflow.description ? `\t${entry.workflow.description}` : ''}`,
          )
          .join('\n') || 'No workflow definitions found.',
      );
  }
}

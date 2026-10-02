import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatRunSummary, parseWatchInterval, watchExitCodes } from '../../cli/inspection-view.js';
import { parseDuration } from '../../cli/duration.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { RunInspection } from '../../workflow/loader/inspection.js';

interface WorkflowInspectArgs {
  readonly runId: string;
}
interface WorkflowInspectFlags {
  readonly 'state-dir': string | undefined;
  readonly json: boolean | undefined;
  readonly summary: boolean | undefined;
  readonly watch: boolean | undefined;
  readonly interval: string | undefined;
  readonly timeout: string | undefined;
  readonly 'wait-created': string | undefined;
  readonly final: boolean | undefined;
}

export default class WorkflowInspect extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowInspectArgs> = {
    runId: Args.string({ description: 'Persisted run identifier', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<WorkflowInspectFlags> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    json: Flags.boolean({
      description: 'Print the run as JSON (JSONL per change with --watch)',
      default: false,
    }),
    summary: Flags.boolean({
      description: 'Print the compact dashboard data as JSON',
      dependsOn: ['json'],
    }),
    watch: Flags.boolean({
      description:
        'Wait until completed (exit 0), failed (1), suspended (75), cancelled (130) or stale (3)',
    }),
    interval: Flags.string({
      description: 'Watch polling interval, e.g. 2s or 250ms (default 2s)',
      dependsOn: ['watch'],
    }),
    timeout: Flags.string({
      description:
        'Stop watching a run still running this long after the first read, e.g. 9m, then exit 79 (watch.timeout); the run keeps running',
      dependsOn: ['watch'],
    }),
    'wait-created': Flags.string({
      description:
        'Wait up to this long for the run record to appear, e.g. 30s, else exit 66 (watch.record_not_created)',
      dependsOn: ['watch'],
    }),
    final: Flags.boolean({
      description: 'Print only the final snapshot (or only the error document)',
      dependsOn: ['watch'],
    }),
  };
  public static override readonly summary =
    'Inspect or watch a workflow without importing its code';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowInspect);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const intervalMs = parseWatchInterval(flags.interval ?? '2s');
    const timeoutMs = this.#bound('timeout', flags.timeout);
    const waitCreatedMs = this.#bound('wait-created', flags['wait-created']);
    const stream = flags.watch === true && flags.final !== true;
    const render = (value: RunInspection): void => {
      const human = `${stream && !flags.json && process.stdout.isTTY ? '\u001b[2J\u001b[H' : ''}${formatRunSummary(value.summary, flags.verbose)}`;
      this.output(
        flags.summary
          ? value.summary
          : { ...value.run, ownership: value.ownership, usageSummary: value.summary.usage },
        human,
      );
    };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      ...(stream ? { onInspection: render } : {}),
    });
    const result = await executor.execute({
      ...(flags.watch
        ? {
            kind: 'workflow.watch' as const,
            intervalMs,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(waitCreatedMs === undefined ? {} : { waitCreatedMs }),
          }
        : { kind: 'workflow.inspect' as const }),
      runId: args.runId,
      stateDir: stateDir,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.run.result' && result.summary && result.ownership) {
      if (!stream)
        render({ run: result.run, summary: result.summary, ownership: result.ownership });
      if (flags.watch) process.exitCode = watchExitCodes[result.summary.status];
    }
  }

  /** Under `--summary`, watch error documents carry the bounded summary, not the whole record. */
  protected override compactRunDocuments(): boolean {
    const end = this.argv.indexOf('--');
    return this.argv.slice(0, end === -1 ? undefined : end).includes('--summary');
  }

  /** A watch bound in milliseconds, with the same duration syntax and range as `tick --timeout`. */
  #bound(flag: 'timeout' | 'wait-created', value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const ms = parseDuration(value);
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647)
      this.fail(
        'usage.flag',
        `--${flag} must be a positive duration such as 30s, 9m or 250ms (at most 2147483647ms).`,
      );
    return ms;
  }
}

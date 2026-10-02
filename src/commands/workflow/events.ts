import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { parseWatchBound, parseWatchInterval, watchExitCodes } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { EventFollowStart } from '../../workflow/loader/event-follow.js';

interface WorkflowEventsArgs {
  readonly runId: string;
}
interface WorkflowEventsFlags {
  readonly 'state-dir': string | undefined;
  readonly follow: boolean | undefined;
  readonly 'from-start': boolean | undefined;
  readonly 'after-execution': number | undefined;
  readonly interval: string | undefined;
  readonly timeout: string | undefined;
  readonly 'wait-created': string | undefined;
  readonly json: boolean | undefined;
}

export default class WorkflowEvents extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowEventsArgs> = {
    runId: Args.string({ description: 'Persisted run identifier', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<WorkflowEventsFlags> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    follow: Flags.boolean({
      description:
        'Keep printing new lines until completed (exit 0), failed (1), suspended (75), cancelled (130) or stale (3); starts from the current end',
    }),
    'from-start': Flags.boolean({
      description:
        'With --follow, print every line already in the record first (printing without --follow always does)',
      exclusive: ['after-execution'],
    }),
    'after-execution': Flags.integer({
      description:
        "Print only lines of executions after N (a suspended snapshot's execution); with --follow, wait for a later execution to end",
      min: 0,
      exclusive: ['from-start'],
    }),
    interval: Flags.string({
      description: 'Polling interval, e.g. 2s or 250ms (default 2s)',
      dependsOn: ['follow'],
    }),
    timeout: Flags.string({
      description:
        'Stop following a run that has not ended this long after the first read, e.g. 9m, then exit 79 (watch.timeout); the run keeps running',
      dependsOn: ['follow'],
    }),
    'wait-created': Flags.string({
      description:
        'Wait up to this long for the run record to appear, e.g. 30s, else exit 66 (watch.record_not_created)',
      dependsOn: ['follow'],
    }),
    json: Flags.boolean({
      description:
        'Report a failure as a workflow.error JSON document on stdout; event lines are always JSONL',
      default: false,
    }),
  };
  public static override readonly summary =
    "Print or follow a run's compact event lines without importing its code";

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowEvents);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const follow = flags.follow === true;
    const intervalMs = parseWatchInterval(flags.interval ?? '2s');
    const timeoutMs = this.#bound('timeout', flags.timeout);
    const waitCreatedMs = this.#bound('wait-created', flags['wait-created']);
    const after = flags['after-execution'];
    const start: EventFollowStart =
      after !== undefined
        ? { afterExecution: after }
        : follow && flags['from-start'] !== true
          ? 'end'
          : 'all';
    // One write per line through the same saved stdout writer as `--events -`; a reader that went
    // away (such as a closed pipe) stops the follower instead of polling for nobody.
    const closed = new AbortController();
    const write = this.eventsOptions('-').executor.eventsStdout;
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: AbortSignal.any([this.signal, closed.signal]),
      onEventLine: (line) => {
        write?.(`${line}\n`, (error) => {
          closed.abort(error);
        });
      },
    });
    const result = await executor.execute({
      kind: 'workflow.events',
      runId: args.runId,
      stateDir,
      follow,
      start,
      intervalMs,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(waitCreatedMs === undefined ? {} : { waitCreatedMs }),
    });
    if (!result.ok) this.failResult(result);
    if (follow && result.kind === 'workflow.run.result' && result.summary)
      process.exitCode = watchExitCodes[result.summary.status];
  }

  /** Error documents carry the bounded summary, never the whole record. */
  protected override compactRunDocuments(): boolean {
    return true;
  }

  /** A follow bound in milliseconds, with the same syntax and range as `inspect --watch`. */
  #bound(flag: 'timeout' | 'wait-created', value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const ms = parseWatchBound(value);
    if (ms === null)
      this.fail(
        'usage.flag',
        `--${flag} must be a positive duration such as 30s, 9m or 250ms (at most 2147483647ms).`,
      );
    return ms;
  }
}

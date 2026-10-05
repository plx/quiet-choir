import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { eventsFlag } from '../../cli/execute-flags.js';
import { TickWorkflowExecutor } from '../../workflow/loader/tick.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { resolveStateDir } from '../../workflow/runtime/paths.js';
import { parseDuration } from '../../cli/duration.js';

interface TickFlags {
  readonly 'notify-command': string | undefined;
  readonly events: string | undefined;
  readonly 'state-dir': string | undefined;
  readonly run: string | undefined;
  readonly watch: boolean | undefined;
  readonly timeout: string;
  readonly 'claim-margin': string | undefined;
  readonly 'max-runs': number | undefined;
  readonly harness: string[] | undefined;
  readonly 'harness-config': string | undefined;
  readonly 'allow-harness-config-change': boolean | undefined;
  readonly json: boolean | undefined;
}

export default class WorkflowTick extends WorkflowCommand {
  public static override readonly summary =
    'Resume due suspended runs and recover crashed ones; optionally watch for a bounded duration';
  public static override readonly flags: Interfaces.FlagInput<TickFlags> = {
    'notify-command': Flags.string({
      description: 'Best-effort sh -c hook receiving event JSON on stdin',
      env: 'QUIET_CHOIR_NOTIFY_COMMAND',
    }),
    events: eventsFlag(),

    'state-dir': Flags.directory({ description: 'Runs container; defaults to project state' }),
    run: Flags.string({
      description:
        'Only this run; exit 0 completed, 75 pending/interrupted/locked/orphans/deadline, or 1 failed/cancelled/incompatible/unreadable/crash-loop',
    }),
    watch: Flags.boolean({ description: 'Wait for deadlines or inbox deliveries until timeout' }),
    timeout: Flags.string({
      description: 'Maximum invocation duration, e.g. 540s, 9m, or 250ms',
      default: '540s',
    }),
    'claim-margin': Flags.string({
      description:
        'Stop claiming new runs when less than this much of --timeout remains, e.g. 30s or 0ms; defaults to 10% of --timeout',
    }),
    'max-runs': Flags.integer({
      description: 'Maximum resume attempts in this invocation, taken in run-ID order',
      min: 1,
    }),
    harness: Flags.string({
      description:
        "cli, fixture:<file>, or name=fixture:<file> for every resumed run; repeatable. Omitted uses each run's recorded selection",
      multiple: true,
    }),
    'harness-config': Flags.string({
      description:
        'CliHarness configuration JSON or @file for resumed CLI runs; must match the configuration each run last executed with (omitted means the default)',
    }),
    'allow-harness-config-change': Flags.boolean({
      description:
        'Accept a --harness-config different from the one a run last executed with; applies to every run this tick resumes, so pair it with --run',
    }),
    json: Flags.boolean({ description: 'Print one structured tick result' }),
  };

  public async run(): Promise<void> {
    this.refuseEventsStdoutWithJson();
    const { flags } = await this.parse(WorkflowTick);
    const stateDir =
      flags.run === undefined
        ? resolveStateDir(flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] })
        : this.runContext(flags.run, flags['state-dir']);
    this.failureContext = { runId: flags.run ?? null, stateDir };
    const timeoutMs = parseDuration(flags.timeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      this.fail(
        'usage.flag',
        '--timeout must be a positive duration such as 540s (at most 2147483647ms).',
      );
    const claimMarginMs =
      flags['claim-margin'] === undefined ? undefined : parseDuration(flags['claim-margin']);
    if (
      claimMarginMs !== undefined &&
      (!Number.isSafeInteger(claimMarginMs) || claimMarginMs < 0 || claimMarginMs >= timeoutMs)
    )
      this.fail(
        'usage.flag',
        '--claim-margin must be a duration such as 30s or 0ms, smaller than --timeout.',
      );
    let harness: HarnessSelection | undefined;
    if (flags.harness !== undefined || flags['harness-config'] !== undefined) {
      try {
        harness = await readHarnessSelection(
          flags.harness ?? 'cli',
          flags['harness-config'],
          process.cwd(),
        );
      } catch (error) {
        this.fail('usage.flag', error instanceof Error ? error.message : String(error));
      }
    }
    const events = this.eventsOptions(flags.events);
    const result = await new TickWorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
      ...events.executor,
    }).execute({
      kind: 'workflow.tick',
      stateDir,
      ...(flags['notify-command'] === undefined ? {} : { notifyCommand: flags['notify-command'] }),
      ...events.plan,
      ...(flags.run === undefined ? {} : { runId: flags.run }),
      ...(flags['max-runs'] === undefined ? {} : { maxRuns: flags['max-runs'] }),
      ...(harness === undefined ? {} : { harness }),
      inheritHarness: flags.harness === undefined,
      ...(flags['allow-harness-config-change'] === undefined
        ? {}
        : { allowHarnessConfigChange: flags['allow-harness-config-change'] }),
      watch: flags.watch ?? false,
      timeoutMs,
      ...(claimMarginMs === undefined ? {} : { claimMarginMs }),
    });
    if (!result.ok) this.failResult(result);
    this.output(
      result,
      [
        `Resumed ${String(result.resumed.length)}; skipped ${String(result.skipped.length)}; observed ${String(result.observed)}.`,
        ...result.resumed.map(
          ({ runId, outcome, message, nextWakeAt }) =>
            `${runId}: ${outcome}${message === undefined ? '' : `: ${message}`}${
              nextWakeAt == null ? '' : ` (next wake ${new Date(nextWakeAt).toISOString()})`
            }`,
        ),
        ...result.skipped.map(
          ({ runId, reason, message }) =>
            `${runId}: skipped: ${reason}${message === undefined ? '' : `: ${message}`}`,
        ),
      ].join('\n'),
    );
    process.exitCode = result.exitCode;
  }
}

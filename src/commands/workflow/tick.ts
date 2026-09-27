import { Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { TickWorkflowExecutor } from '../../workflow/loader/tick.js';
import { resolveStateDir } from '../../workflow/runtime/paths.js';

interface TickFlags {
  readonly 'notify-command': string | undefined;
  readonly 'state-dir': string | undefined;
  readonly run: string | undefined;
  readonly watch: boolean | undefined;
  readonly timeout: string;
  readonly 'max-runs': number | undefined;
  readonly json: boolean | undefined;
}

export default class WorkflowTick extends WorkflowCommand {
  public static override readonly summary =
    'Resume due suspended runs; optionally watch for a bounded duration';
  public static override readonly flags: Interfaces.FlagInput<TickFlags> = {
    'notify-command': Flags.string({
      description: 'Best-effort sh -c hook receiving event JSON on stdin',
      env: 'QUIET_CHOIR_NOTIFY_COMMAND',
    }),

    'state-dir': Flags.directory({ description: 'Runs container; defaults to project state' }),
    run: Flags.string({
      description: 'Only this run; exit 0 completed, 75 pending, or 1 failed/incompatible',
    }),
    watch: Flags.boolean({ description: 'Wait for deadlines or inbox deliveries until timeout' }),
    timeout: Flags.string({
      description: 'Maximum invocation duration, e.g. 540s, 9m, or 250ms',
      default: '540s',
    }),
    'max-runs': Flags.integer({
      description: 'Maximum resume attempts in this invocation',
      min: 1,
    }),
    json: Flags.boolean({ description: 'Print one structured tick result' }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowTick);
    const stateDir =
      flags.run === undefined
        ? resolveStateDir(flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] })
        : this.runContext(flags.run, flags['state-dir']);
    this.failureContext = { runId: flags.run ?? null, stateDir };
    const duration = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/u.exec(flags.timeout);
    const unit: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
    const timeoutMs = duration ? Number(duration[1]) * (unit[duration[2] ?? ''] ?? 0) : 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      this.fail(
        'usage.flag',
        '--timeout must be a positive duration such as 540s (at most 2147483647ms).',
      );
    const result = await new TickWorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    }).execute({
      kind: 'workflow.tick',
      stateDir,
      ...(flags['notify-command'] === undefined ? {} : { notifyCommand: flags['notify-command'] }),
      ...(flags.run === undefined ? {} : { runId: flags.run }),
      ...(flags['max-runs'] === undefined ? {} : { maxRuns: flags['max-runs'] }),
      watch: flags.watch ?? false,
      timeoutMs,
    });
    if (!result.ok) this.failResult(result);
    this.output(
      result,
      [
        `Resumed ${String(result.resumed)}; completed ${String(result.completed.length)}; suspended ${String(result.suspended.length)}.`,
        ...result.failed.map(({ runId, message }) => `${runId}: failed: ${message}`),
        ...result.incompatible.map(({ runId, message }) => `${runId}: incompatible: ${message}`),
        ...result.skipped.map(({ runId, reason }) => `${runId}: ${reason}`),
      ].join('\n'),
    );
    process.exitCode = result.exitCode;
  }
}

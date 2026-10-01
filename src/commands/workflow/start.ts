import { randomUUID } from 'node:crypto';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { parseDuration } from '../../cli/duration.js';
import { executeFlags, type WorkflowExecuteFlags } from '../../cli/execute-flags.js';
import { readWorkflowInput } from '../../cli/input.js';
import { spawnLauncher } from '../../cli/launcher.js';
import { formatNextCommands, formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { buildStartChildArgv, type ArgvFlagTable } from '../../cli/start-argv.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { StartWorkflowExecutor } from '../../workflow/loader/start.js';

interface WorkflowStartArgs {
  readonly file: string;
}

/** Execute flags that do not create a new persisted run, which start therefore does not accept. */
const notForStart = [
  'resume',
  'kill-orphans',
  'accept-code-change',
  'dry-run',
  'stub-steps',
  'full',
] as const;

interface WorkflowStartFlags extends Omit<WorkflowExecuteFlags, (typeof notForStart)[number]> {
  readonly 'start-timeout': string;
}

const newRunFlags = Object.fromEntries(
  Object.entries(executeFlags).filter(
    ([name]) => !(notForStart as readonly string[]).includes(name),
  ),
) as Interfaces.FlagInput<Omit<WorkflowExecuteFlags, (typeof notForStart)[number]>>;

export default class WorkflowStart extends WorkflowCommand {
  public static override readonly summary =
    'Start a workflow run in the background and return once its record exists';

  public static override readonly description = `Launches \`workflow execute FILE … --json\` as a detached runner (its own session, stdin from /dev/null) and returns as soon as the run's record exists and is owned by that runner, or the runner fails first. The runner's stdout (its final JSON document) and stderr go to <state-dir>/<run-id>/launch/<n>.result.json and <n>.log, created owner-only. Without --run-id a run ID is generated and printed. A failure before the record exists reports the runner's own error (for example load.typecheck, exit 4) with no run ID. When no owned record appears within --start-timeout (default 60s), start stops the runner (SIGTERM, then SIGKILL after --kill-grace-ms plus 2s) and exits 124 (start.timeout); a runner that exits without a record or a readable document is start.exited (exit 70). An interrupted start stops the runner too, so it never leaves an unreported runner.`;

  public static override readonly args: Interfaces.ArgInput<WorkflowStartArgs> = {
    file: Args.string({
      description: 'Trusted TypeScript workflow module',
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowStartFlags> = {
    ...newRunFlags,
    json: Flags.boolean({
      description: 'Print the start result or structured error as JSON',
      default: false,
    }),
    'start-timeout': Flags.string({
      description: 'Maximum wait for the record, e.g. 60s or 500ms; the runner is stopped after it',
      default: '60s',
    }),
  };

  protected override compactRunDocuments(): boolean {
    return true;
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowStart);
    const runId = flags['run-id'] ?? randomUUID();
    const stateDir = this.runContext(runId, flags['state-dir']);
    // A failure before the record exists reports no run ID; the executor sets it when one exists.
    this.failureContext = { runId: null, stateDir };
    const timeoutMs = parseDuration(flags['start-timeout']);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      this.fail(
        'usage.flag',
        '--start-timeout must be a positive duration such as 60s (at most 2147483647ms).',
      );
    const launcher = spawnLauncher();
    if (launcher === undefined)
      this.fail(
        'usage.flag',
        'workflow start needs the path of the CLI script to launch its runner; run it as quiet-choir or node bin/run.js.',
      );
    // The runner validates every other flag; start only needs the grace to stop it.
    const grace = Number(flags['kill-grace-ms'] ?? 3000);
    const killGraceMs = Number.isSafeInteger(grace) && grace > 0 ? grace : 3000;
    const table: ArgvFlagTable = { ...BaseCommand.baseFlags, ...WorkflowStart.flags };
    const child = buildStartChildArgv(this.argv, table, { runId, stateDir });
    const prefix = [...launcher, 'workflow', 'execute'];
    const stdinInput =
      child.stdinInputIndex === null
        ? undefined
        : {
            value: await readWorkflowInput('-', this.signal),
            argvIndex: prefix.length + child.stdinInputIndex,
          };
    const result = await new StartWorkflowExecutor({
      signal: this.signal,
      commandLauncher: this.commandLauncher,
      processSupervisor: this.processSupervisor,
    }).execute({
      kind: 'workflow.start',
      runId,
      stateDir,
      cwd: process.cwd(),
      argv: [...prefix, ...child.args],
      ...(stdinInput === undefined ? {} : { stdinInput }),
      timeoutMs,
      killGraceMs,
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      if (result.launch) this.logToStderr(`Log: ${result.launch.log}`);
      this.failResult(result);
    }
    // The runner owns its run now; report it even if a signal arrives at this point.
    this.outputSavedCompletion(
      result,
      [
        `Started run ${result.runId} (runner PID ${String(result.pid)}, status ${result.status}).`,
        `Log: ${result.log}`,
        `Result: ${result.result}`,
        ...formatNextCommands(result.next),
      ].join('\n'),
    );
  }
}

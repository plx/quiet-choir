import { randomUUID } from 'node:crypto';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { parseDuration } from '../../cli/duration.js';
import { executeFlags, type WorkflowExecuteFlags } from '../../cli/execute-flags.js';
import { readWorkflowInput } from '../../cli/input.js';
import { spawnLauncher } from '../../cli/launcher.js';
import { formatNextCommands, formatWorkflowDiagnostic } from '../../cli/presentation.js';
import {
  buildStartChildArgv,
  foregroundExecuteArgs,
  type ArgvFlagTable,
} from '../../cli/start-argv.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { requestedEventsStdout } from '../../cli/workflow-errors.js';
import { workflowFailure } from '../../workflow/loader/failure.js';
import { StartWorkflowExecutor } from '../../workflow/loader/start.js';
import { workflowArgv } from '../../workflow/runtime/commands.js';

interface WorkflowStartArgs {
  readonly file: string | undefined;
}

/**
 * Execute flags that start refuses (ADR 0056), with the reason. They stay in start's flag table,
 * hidden and without `dependsOn`, so oclif parses them and start can point at the foreground
 * command instead of failing with a generic unknown-flag error.
 */
const refusedForStart = {
  'dry-run':
    'a dry run keeps temporary checkpoints and removes its state, so no record remains for a detached runner to own',
  'stub-steps': 'it only applies to a --dry-run, which start does not run',
  full: "it only shapes execute's foreground result document; start prints its own start result",
} as const;

type RefusedFlag = keyof typeof refusedForStart;

interface WorkflowStartFlags extends Omit<WorkflowExecuteFlags, RefusedFlag> {
  readonly 'start-timeout': string;
  readonly 'dry-run': boolean | undefined;
  readonly 'stub-steps': string[] | undefined;
  readonly full: boolean | undefined;
}

const acceptedFlags = Object.fromEntries(
  Object.entries(executeFlags).filter(([name]) => !(name in refusedForStart)),
) as Interfaces.FlagInput<Omit<WorkflowExecuteFlags, RefusedFlag>>;

const refusedDescription = 'Refused by workflow start; run workflow execute in the foreground';

export default class WorkflowStart extends WorkflowCommand {
  public static override readonly summary =
    'Start or resume a workflow run in the background and return once its runner owns it';

  public static override readonly description = `Launches \`workflow execute FILE … --json\` as a detached runner (its own session, stdin from /dev/null) and returns as soon as the run's record exists and is owned by that runner, or the runner fails first. With --resume --run-id ID (FILE optional, as for execute) it resumes an existing run instead and returns once the runner has recorded its own execution in the record, or reports the runner's refusal (for example run.locked, run.orphans or run.incompatible) with the run's ID; a missing run is refused with run.not_found before anything is launched. --kill-orphans and --accept-code-change work with --resume as for execute, and the start timeout covers their recovery and checks. --dry-run, --stub-steps and --full are refused with usage.flag and a next entry naming the foreground workflow execute command. The runner's stdout (its final JSON document) and stderr go to <state-dir>/<run-id>/launch/<n>.result.json and <n>.log, created owner-only for the smallest free n, and start records the runner's PID and host in <n>.runner.json. Without --run-id a run ID is generated and printed. A failure before the record exists reports the runner's own error (for example load.typecheck, exit 4) with no run ID; workflow list reports its leftover launch directory once the runner has exited, and workflow rm ID removes it. When the runner does not take the run within --start-timeout (default 60s), start stops the runner (SIGTERM, then SIGKILL after --kill-grace-ms plus 2s) and exits 124 (start.timeout); a runner that exits without a record or a readable document is start.exited (exit 70). An interrupted start stops the runner too, so it never leaves an unreported runner.`;

  public static override readonly args: Interfaces.ArgInput<WorkflowStartArgs> = {
    file: Args.string({
      description: 'Trusted TypeScript workflow module; optional with --resume --run-id',
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowStartFlags> = {
    ...acceptedFlags,
    'dry-run': Flags.boolean({ description: refusedDescription, hidden: true }),
    'stub-steps': Flags.string({ description: refusedDescription, hidden: true, multiple: true }),
    full: Flags.boolean({ description: refusedDescription, hidden: true }),
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
    if (requestedEventsStdout(this.argv))
      this.fail(
        'usage.flag',
        "workflow start's runner writes its stdout to the launch result file; give --events a file path",
      );
    const { args, flags } = await this.parse(WorkflowStart);
    const table: ArgvFlagTable = { ...BaseCommand.baseFlags, ...WorkflowStart.flags };
    // Before any I/O (stdin input included): point a refused flag at the foreground command.
    const refused = (Object.keys(refusedForStart) as RefusedFlag[]).find(
      (name) => flags[name] !== undefined && flags[name] !== false,
    );
    if (refused !== undefined)
      this.failResult(
        workflowFailure(
          'usage.flag',
          `workflow start does not accept --${refused}: ${refusedForStart[refused]}. Run workflow execute in the foreground instead${
            refused === 'full'
              ? ', or read a started run with workflow inspect RUN --json --full'
              : ''
          }.`,
          {
            next: [
              {
                why: `Run the same command in the foreground with workflow execute, which accepts --${refused}.`,
                argv: workflowArgv(
                  this.commandLauncher,
                  'execute',
                  ...foregroundExecuteArgs(this.argv, table),
                ),
              },
            ],
          },
        ),
      );
    if (flags.resume && flags['run-id'] === undefined)
      this.fail('usage.resume_requires_run_id', '--resume requires --run-id.');
    if (args.file === undefined && !flags.resume)
      this.fail('usage.flag', 'A workflow file is required unless --resume --run-id is used.');
    const runId = flags['run-id'] ?? randomUUID();
    const stateDir = this.runContext(runId, flags['state-dir']);
    // A failure before the record exists reports no run ID; the executor sets it when one exists.
    // A resume's missing run is refused before spawning, also without a run ID.
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
      ...(flags.resume ? { resume: true } : {}),
      cwd: process.cwd(),
      argv: [...prefix, ...child.args],
      ...(stdinInput === undefined ? {} : { stdinInput }),
      timeoutMs,
      killGraceMs,
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics)
        this.logToStderr(formatWorkflowDiagnostic(diagnostic, process.cwd()));
      if (result.launch) this.logToStderr(`Log: ${result.launch.log}`);
      this.failResult(result);
    }
    // The runner owns its run now; report it even if a signal arrives at this point.
    this.outputSavedCompletion(
      result,
      [
        `${flags.resume ? 'Resumed' : 'Started'} run ${result.runId} (runner PID ${String(result.pid)}, status ${result.status}).`,
        `Log: ${result.log}`,
        `Result: ${result.result}`,
        ...formatNextCommands(result.next),
      ].join('\n'),
    );
  }
}

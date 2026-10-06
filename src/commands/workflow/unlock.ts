import { resolve } from 'node:path';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

/** A cleared lock's holders, as the text output describes them. */
function holders(lock: {
  readonly owner: { readonly pid: number; readonly host: string; readonly state: string } | null;
  readonly recovery: {
    readonly pid: number;
    readonly host: string;
    readonly state: string;
  } | null;
}): string {
  return `${
    lock.owner
      ? `owner PID ${String(lock.owner.pid)} on ${lock.owner.host}, ${lock.owner.state}`
      : 'no readable owner'
  }${
    lock.recovery
      ? `; recoverer PID ${String(lock.recovery.pid)} on ${lock.recovery.host}, ${lock.recovery.state}`
      : ''
  }`;
}

export default class WorkflowUnlock extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{
    readonly runId: string | undefined;
  }> = {
    runId: Args.string({
      description: 'Run whose abandoned lock should be cleared (omit with --worktree-admin)',
      required: false,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly 'worktree-admin': string | undefined;
    readonly 'force-remote': boolean | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Runs container; defaults to environment, legacy discovery, then project state',
    }),
    'worktree-admin': Flags.string({
      description:
        "Clear the worktree administration lock of the Git repository containing PATH (a checkout, a linked worktree or its common Git dir) instead of a run's lock",
      helpValue: 'PATH',
    }),
    'force-remote': Flags.boolean({
      description:
        'Assert that a foreign recorded host is this machine under an old name or is permanently gone, so its owner, recoverer and children are judged by local PID observations',
    }),
    json: Flags.boolean({ description: 'Print the unlock result as JSON' }),
  };
  public static override readonly summary =
    "Clear an abandoned run lock or a repository's worktree administration lock without importing workflow code";
  public static override readonly description =
    "Give a RUN to clear its run lock, or --worktree-admin PATH (without RUN or --state-dir) to clear the worktree administration lock of PATH's Git repository. Refuses (exit 3) while any lock owner or recoverer is alive or unverifiable, while a recorded child process is alive or unverifiable, or while a lock belongs to a foreign host without --force-remote. Removes locks only by the tombstone rename and never signals a process.";
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowUnlock);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const admin = flags['worktree-admin'];
    if (admin !== undefined) {
      if (args.runId !== undefined)
        this.fail('usage.flag', 'Give either RUN or --worktree-admin PATH, not both.');
      if (flags['state-dir'] !== undefined)
        this.fail(
          'usage.flag',
          '--state-dir selects runs; the worktree administration lock belongs to the repository at --worktree-admin PATH.',
        );
      await this.#worktreeAdmin(executor, resolve(admin), flags['force-remote'] ?? false);
      return;
    }
    if (args.runId === undefined)
      this.fail('usage.flag', 'Give the RUN whose lock to clear, or --worktree-admin PATH.');
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const result = await executor.execute({
      kind: 'workflow.unlock',
      runId: args.runId,
      stateDir,
      forceRemote: flags['force-remote'] ?? false,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind === 'workflow.unlock.result')
      this.output(
        result,
        result.locks.length === 0
          ? `Run ${result.runId} is not locked.`
          : result.locks
              .flatMap((lock) => [
                `${lock.action === 'removed' ? 'Removed' : 'Already gone:'} ${lock.kind} lock ${lock.path} (${holders(lock)}).`,
                ...(lock.warning === undefined ? [] : [`Warning: ${lock.warning}`]),
              ])
              .join('\n'),
      );
  }

  async #worktreeAdmin(
    executor: WorkflowExecutor,
    path: string,
    forceRemote: boolean,
  ): Promise<void> {
    const result = await executor.execute({
      kind: 'workflow.unlock.worktree-admin',
      path,
      forceRemote,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind !== 'workflow.unlock.worktree-admin.result') return;
    const { lock } = result;
    this.output(
      result,
      lock === null
        ? `Worktree administration lock ${result.lockPath} is not held.`
        : [
            `${lock.action === 'removed' ? 'Removed' : 'Already gone:'} worktree administration lock ${lock.path} (${holders(lock)}).`,
            ...(lock.warning === undefined ? [] : [`Warning: ${lock.warning}`]),
          ].join('\n'),
    );
  }
}

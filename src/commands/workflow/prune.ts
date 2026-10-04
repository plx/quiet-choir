import { resolve } from 'node:path';
import { Flags, type Interfaces } from '@oclif/core';
import { parseDuration } from '../../cli/duration.js';
import { formatBytes } from '../../cli/inspection-view.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import { defaultPruneStatuses, type PruneStatus } from '../../workflow/loader/prune-selection.js';
import { resolveStateDir } from '../../workflow/runtime/paths.js';

interface WorkflowPruneFlags {
  readonly 'older-than': string | undefined;
  readonly status: string[] | undefined;
  readonly 'missing-cwd': boolean | undefined;
  readonly all: boolean | undefined;
  readonly refs: boolean | undefined;
  readonly 'dry-run': boolean | undefined;
  readonly json: boolean | undefined;
  readonly 'state-dir': string | undefined;
}

const isPruneStatus = (value: string): value is PruneStatus =>
  (defaultPruneStatuses as readonly string[]).includes(value);

export default class WorkflowPrune extends WorkflowCommand {
  public static override readonly flags: Interfaces.FlagInput<WorkflowPruneFlags> = {
    'older-than': Flags.string({
      description:
        'Only runs last updated longer ago than this duration, such as 7d, 12h or 30m (ms, s, m, h, d)',
    }),
    status: Flags.string({
      description:
        'Only runs with these observed statuses: completed, failed, cancelled (comma-separated or repeated; default all three)',
      multiple: true,
    }),
    'missing-cwd': Flags.boolean({
      description: 'Only runs whose recorded working directory no longer exists',
    }),
    all: Flags.boolean({
      description: 'Scan every registered XDG project plus the current project, as list --all does',
      exclusive: ['state-dir'],
    }),
    refs: Flags.boolean({
      description:
        'Also delete each removed run’s pinned Git refs; their commits may be lost after Git garbage collection',
    }),
    'dry-run': Flags.boolean({
      description:
        'List what would be removed and why runs stay, taking no lock and changing nothing',
    }),
    json: Flags.boolean({ description: 'Print the prune result as JSON' }),
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
  };
  public static override readonly summary =
    'Remove finished runs by age, status or missing cwd, each through workflow rm';
  public static override readonly description =
    'Selects runs whose observed status is completed, failed or cancelled (or those given to --status), and that match every other filter given, then removes each through the guarded workflow rm path, oldest first, without --force. Needs at least one of --older-than, --status or --missing-cwd (exit 2, usage.flag): there is no delete-everything mode. A matching run stays, listed in skipped with its reason, while it is running, stale or suspended, has a waiting step or a queued answer delivery, or is held by a lock owner, recoverer or live orphan; a refusal or failure while removing one run is reported the same way and the rest continue. Exits 0 whenever the runs containers could be read. Also sweeps abandoned rm tombstones in each scanned container. --dry-run takes no lock and changes nothing.';

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowPrune);
    const olderThan = flags['older-than'];
    const statusValues = (flags.status ?? []).flatMap((value) =>
      value.split(',').map((entry) => entry.trim()),
    );
    if (olderThan === undefined && flags.status === undefined && !flags['missing-cwd'])
      this.fail(
        'usage.flag',
        'workflow prune needs at least one of --older-than, --status or --missing-cwd; it has no delete-everything mode.',
      );
    const olderThanMs = olderThan === undefined ? null : parseDuration(olderThan);
    if (olderThanMs !== null && (!Number.isFinite(olderThanMs) || olderThanMs < 0))
      this.fail(
        'usage.flag',
        '--older-than must be a duration such as 7d, 12h, 30m, 90s or 500ms.',
      );
    const invalid = statusValues.filter((value) => !isPruneStatus(value));
    if (flags.status !== undefined && (invalid.length || !statusValues.length))
      this.fail(
        'usage.flag',
        `--status takes only finished statuses (${defaultPruneStatuses.join(', ')}); got ${invalid.map((value) => JSON.stringify(value)).join(', ') || 'nothing'}.`,
      );
    const statuses =
      flags.status === undefined
        ? defaultPruneStatuses
        : [...new Set(statusValues.filter(isPruneStatus))];
    const stateDir = resolveStateDir(
      flags['state-dir'] === undefined ? {} : { stateDir: flags['state-dir'] },
    );
    this.failureContext = { runId: null, stateDir };
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.prune',
      stateDir,
      additionalStateDirs:
        flags['state-dir'] === undefined && process.env['QUIET_CHOIR_STATE_DIR'] === undefined
          ? [resolve('.quiet-choir/runs')]
          : [],
      all: flags.all ?? false,
      olderThanMs,
      statuses,
      missingCwd: flags['missing-cwd'] ?? false,
      refs: flags.refs ?? false,
      dryRun: flags['dry-run'] ?? false,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind !== 'workflow.prune.result') return;
    const count = (n: number) => `${String(n)} run${n === 1 ? '' : 's'}`;
    const lines = [
      `${result.dryRun ? 'Would remove' : 'Removed'} ${count(result.removed.length)} (${formatBytes(result.bytes)}); skipped ${String(result.skipped.length)}.`,
      ...result.removed.map(
        (run) =>
          `${result.dryRun ? 'Would remove' : 'Removed'} ${run.runId} ${run.status} ${run.updatedAt} ${formatBytes(run.bytes)} ${run.cwd}${
            run.keptRefs.length ? ` (kept ${String(run.keptRefs.length)} pinned refs)` : ''
          }`,
      ),
      ...result.skipped.map(
        (run) =>
          `Skipped ${run.runId} ${run.status} ${run.updatedAt} ${run.bytes === null ? 'unknown size' : formatBytes(run.bytes)} ${run.cwd} (${run.reason}): ${run.message}`,
      ),
      ...result.tombstones.map(
        (path) => `${result.dryRun ? 'Sweepable tombstone' : 'Swept tombstone'}: ${path}`,
      ),
      ...result.removed.flatMap((run) =>
        run.warnings.map((warning) => `Warning: ${run.runId}: ${warning}`),
      ),
      ...result.warnings.map((warning) => `Warning: ${warning}`),
    ];
    // Runs already removed stand even when a signal arrived afterwards.
    if (result.removed.length && !result.dryRun)
      this.outputSavedCompletion(result, lines.join('\n'));
    else this.output(result, lines.join('\n'));
  }
}

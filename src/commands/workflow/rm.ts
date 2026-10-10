import { Args, Flags, type Interfaces } from '@oclif/core';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatBytes } from '../../cli/inspection-view.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

export default class WorkflowRm extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<{ readonly runId: string }> = {
    runId: Args.string({ description: 'Run to remove', required: true }),
  };
  public static override readonly flags: Interfaces.FlagInput<{
    readonly 'state-dir': string | undefined;
    readonly force: boolean | undefined;
    readonly refs: boolean | undefined;
    readonly 'dry-run': boolean | undefined;
    readonly unreadable: boolean | undefined;
    readonly json: boolean | undefined;
  }> = {
    'state-dir': Flags.directory({
      description: 'Runs container; defaults to environment, legacy discovery, then project state',
    }),
    force: Flags.boolean({
      description:
        'Also remove a running or suspended run, or one with a waiting step; never overrides a held lock',
    }),
    refs: Flags.boolean({
      description:
        'Also delete this run’s pinned Git refs; their commits may be lost after Git garbage collection',
    }),
    'dry-run': Flags.boolean({
      description:
        'Report the verdict and what would be removed, taking no lock and changing nothing',
    }),
    unreadable: Flags.boolean({
      description:
        'Also remove a run whose record file is present but damaged, without reading it; leaves its worktree caches and refs',
    }),
    json: Flags.boolean({ description: 'Print the removal result as JSON' }),
  };
  public static override readonly summary =
    'Remove one saved run and its caches without importing workflow code';
  public static override readonly description =
    'Deletes the run directory (record, journal, attempts/ transcripts, artifacts, launch/, inbox), its legacy flat files and its worktree caches; pinned refs only with --refs. Refuses (exit 3, run.locked) while any lock owner or recoverer is alive, unverifiable or on a foreign host, even with --force; (exit 3, run.orphans) while a dead owner’s recorded child is alive or unverifiable; and, without --force, (exit 3, run.active) for a running or suspended run or one with a waiting step. A cache Git cannot remove while its repository exists stops the removal before the run is deleted (exit 74, workflow.storage): caches Git already removed stay removed, no ref is deleted, and the record stays for workflow clean. An ID with no record whose directory holds only the launch/ of a start that failed before its record is a leftover launch directory: rm removes it under the same guard (launchOnly in the result; --refs changes nothing), and refuses it (exit 3, run.active), even with --force, while the start’s runner is alive, unverifiable or remote, or, for a launch without a runner record, its files are younger than an hour. A run whose record file is present but whose content is damaged (invalid JSON or schema, a journal gap, a format-7 marker without its directory, run.json without journal.jsonl) is refused (exit 3, run.unreadable) with the --unreadable command in error.details.next; with --unreadable rm removes it without reading it, under the same lock and liveness refusals, and refuses (exit 3, run.active), even with --force, while a launch in its launch/ may still be in flight. Its worktree caches and pinned refs are not removed (a warning says how to find them), and a record unreadable for access or I/O reasons is still refused. --dry-run exits 0 with the verdict whenever the run or leftover exists.';
  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowRm);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: this.signal,
      processSupervisor: this.processSupervisor,
    });
    const result = await executor.execute({
      kind: 'workflow.rm',
      runId: args.runId,
      stateDir,
      force: flags.force ?? false,
      refs: flags.refs ?? false,
      dryRun: flags['dry-run'] ?? false,
      unreadable: flags.unreadable ?? false,
    });
    if (!result.ok) this.failResult(result);
    if (result.kind !== 'workflow.rm.result') return;
    const caches = result.caches.map(
      (cache) => `${cache.path}${cache.method === 'direct' ? ' (repository gone)' : ''}`,
    );
    const lines = result.dryRun
      ? [
          result.verdict === 'remove'
            ? result.launchOnly
              ? `Would remove the leftover launch directory of ${result.runId} (${formatBytes(result.bytes)}).`
              : result.unreadable
                ? `Would remove the unreadable run ${result.runId} (${formatBytes(result.bytes)}).`
                : `Would remove ${result.runId} (${formatBytes(result.bytes)}).`
            : `Would refuse to remove ${result.runId} (${result.verdict.code}): ${result.verdict.message}`,
          ...result.paths.map((path) => `Path: ${path}`),
          ...caches.map((cache) => `Cache: ${cache}`),
          ...result.refsRemoved.map((ref) => `Ref: ${ref}`),
          ...result.keptRefs.map((ref) => `Kept ref: ${ref}`),
          ...result.tombstones.map((name) => `Tombstone: ${name}`),
        ]
      : result.launchOnly
        ? [
            `Removed the leftover launch directory of ${result.runId} (${formatBytes(result.bytes)}).`,
          ]
        : result.unreadable
          ? [
              `Removed the unreadable run ${result.runId} (${formatBytes(result.bytes)}); its worktree caches and refs, if any, were not removed.`,
            ]
          : [
              `Removed ${result.runId} (${formatBytes(result.bytes)}), ${String(result.caches.length)} worktree caches and ${String(result.refsRemoved.length)} pinned refs.`,
              ...(result.keptRefs.length
                ? [
                    `Kept ${String(result.keptRefs.length)} pinned refs under refs/quiet-choir/${result.runId}/; git for-each-ref lists them (rm --refs would have deleted them).`,
                  ]
                : []),
            ];
    const human = [...lines, ...result.warnings.map((warning) => `Warning: ${warning}`)].join('\n');
    // A removal that passed its commit point stands even when a signal arrived afterwards.
    if (result.removed) this.outputSavedCompletion(result, human);
    else this.output(result, human);
  }
}

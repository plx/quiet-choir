import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { formatArgv, workflowArgv, type CommandLauncher } from '../runtime/commands.js';
import type { ProcessRunner } from '../runtime/exec-model.js';
import { jsonValue } from '../runtime/json.js';
import { answerCandidates } from '../runtime/inbox.js';
import { scanInterruptedRemovals } from '../runtime/interrupted-removal.js';
import { inspectRunOwnership, isErrno } from '../runtime/lock.js';
import type { JsonValue } from '../runtime/model.js';
import {
  defaultStateDir,
  projectRoots,
  registeredProjects,
  resolveStateDir,
  runDirectory,
} from '../runtime/paths.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { ownershipHold, removalRefusal } from '../runtime/removal-decision.js';
import { RunRefusedError, type CliErrorCode } from '../runtime/run-errors.js';
import {
  deadTombstones,
  finishInterruptedRemoval,
  removeRun,
  sweepTombstones,
  type RemovedCache,
} from '../runtime/run-removal.js';
import { listRuns, type InspectionStatus, type RunSummary } from './inspection.js';
import { pruneRoots, type PruneRoot } from './prune-roots.js';
import {
  pruneDecision,
  type PruneCandidate,
  type PruneProtection,
  type PruneStatus,
} from './prune-selection.js';

/**
 * Plain-data request to remove the finished runs that match every filter, each through the
 * guarded `workflow rm` removal (`workflow prune`, ADR 0050). Prune never forces a removal.
 * @internal
 */
export interface PruneRunsOptions {
  /** The resolved runs container; scanned first. */
  readonly stateDir: string;
  /** More runs containers to scan, such as the project's legacy `.quiet-choir/runs`. */
  readonly additionalStateDirs?: readonly string[];
  /** Also scan every registered XDG project, as `workflow list --all` does. */
  readonly all: boolean;
  /** Only runs whose `updatedAt` is strictly older than this many milliseconds; null for any age. */
  readonly olderThanMs: number | null;
  /** Observed statuses to consider: a non-empty subset of the terminal ones. */
  readonly statuses: readonly PruneStatus[];
  /**
   * Only runs whose recorded cwd is missing. With `all`, also remove the stale XDG project roots
   * afterwards (ADR 0051).
   */
  readonly missingCwd: boolean;
  /** Also delete each removed run's pinned Git refs. */
  readonly refs: boolean;
  /** Report what would be removed, taking no lock and changing nothing. */
  readonly dryRun: boolean;
}

/** One run prune removed or, in a dry run, would remove. @internal */
export interface PrunedRun {
  readonly runId: string;
  readonly stateDir: string;
  readonly status: InspectionStatus;
  readonly updatedAt: string;
  readonly cwd: string;
  /** On-disk bytes of the run's files in its runs container, as `workflow rm` measured them. */
  readonly bytes: number;
  readonly paths: readonly string[];
  readonly caches: readonly RemovedCache[];
  readonly refsRemoved: readonly string[];
  readonly keptRefs: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Why a run that matched the filters stays: a selection protection (`active`, `locked`,
 * `orphans`, `waiting`, `queued-answer`) or a removal-time outcome: `changed` (the record changed
 * or was replaced after selection), `gone` (another removal won), `refused` (another `run.*`
 * refusal) or `storage` (a cache Git could not remove, or another error of that one removal).
 * @internal
 */
export type PruneSkipReason =
  PruneProtection['reason'] | 'changed' | 'gone' | 'refused' | 'storage';

/** A run that matched the filters but was not removed. @internal */
export interface PruneSkippedRun {
  readonly runId: string;
  readonly stateDir: string;
  readonly status: InspectionStatus;
  readonly updatedAt: string;
  readonly cwd: string;
  /** As `workflow list` measured it; null when unmeasurable. */
  readonly bytes: number | null;
  readonly reason: PruneSkipReason;
  /**
   * The CLI code `workflow rm` refused (or would refuse) this run with, `workflow.storage` for a
   * storage outcome, or null when rm itself would remove it (`queued-answer`).
   */
  readonly code: CliErrorCode | null;
  readonly message: string;
  readonly details: JsonValue;
}

/** What `workflow prune` did or, under `dryRun`, would do. @internal */
export interface PruneResult {
  readonly dryRun: boolean;
  /** Every scanned runs container, in scan order. */
  readonly stateDirs: readonly string[];
  readonly filters: {
    readonly olderThanMs: number | null;
    readonly statuses: readonly PruneStatus[];
    readonly missingCwd: boolean;
    readonly all: boolean;
    readonly refs: boolean;
  };
  /** Removed runs, oldest first; in a dry run, the runs a prune would remove now. */
  readonly removed: readonly PrunedRun[];
  /** Matching runs that stay, with the reason; runs that do not match are not listed. */
  readonly skipped: readonly PruneSkippedRun[];
  /** Sum of `removed[].bytes`. */
  readonly bytes: number;
  /** Absolute paths of abandoned rm tombstones swept (or, in a dry run, sweepable). */
  readonly tombstones: readonly string[];
  /**
   * Absolute `<stateDir>/<runId>` paths of the interrupted flat-run removals prune finished (or, in
   * a dry run, would finish), in scan order (ADR 0061). They are not runs and match no filter.
   */
  readonly unfinishedRemovals: readonly string[];
  /**
   * Stale XDG project roots removed or kept, by root path; always empty unless both `missingCwd`
   * and `all` are set (ADR 0051).
   */
  readonly roots: readonly PruneRoot[];
  readonly warnings: readonly string[];
}

/** The outcome of {@link pruneRuns}: done, or stopped by the signal between or inside removals. @internal */
export type PruneOutcome =
  | { readonly kind: 'done'; readonly result: PruneResult }
  | {
      readonly kind: 'interrupted';
      /** Runs removed before the interruption; they stay removed. */
      readonly removed: readonly PrunedRun[];
      /** Project roots removed before the interruption; they stay removed. */
      readonly roots: readonly string[];
      /** Interrupted removals finished before the interruption, as in {@link PruneResult}. */
      readonly unfinishedRemovals: readonly string[];
      readonly error: unknown;
    };

/** Live collaborators kept out of the plain-data request. @internal */
export interface PruneRunsLive {
  readonly signal?: AbortSignal | undefined;
  readonly processSupervisor?: ProcessSupervisor | undefined;
  /** Program words behind the `workflow unlock` command that a `run.locked` refusal names. */
  readonly commandLauncher?: CommandLauncher | undefined;
  /** The clock for `olderThanMs`; defaults to `Date.now`. */
  readonly now?: () => number;
  /** @internal Test seam passed to each removal as `beforeLock`. */
  readonly beforeLock?: (runId: string, stateDir: string) => void | Promise<void>;
  /** @internal Test seam called before each `rmdir` of a project root removal. */
  readonly beforeRmdir?: (path: string) => void | Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A delivery the owner quarantined: `<answer path>.rejected.<uuid>.json`. */
const rejectedSuffix = /\.rejected\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/u;

/**
 * Inbox entries that a resume could still consume, in `<runId>/inbox/` and `<runId>.inbox/`. Owners
 * leave a consumed delivery in place and rename a rejected one beside it, so two kinds of entry are
 * settled and do not count: the answer file of a question the record shows resolved through the
 * inbox, and a `.rejected.<uuid>.json` file next to one of the record's answer paths. Everything
 * else counts, even an unknown leftover, and an unreadable inbox or record counts as one more.
 */
async function queuedAnswers(stateDir: string, runId: string, warnings: string[]): Promise<number> {
  const entries: string[] = [];
  let unreadable = 0;
  for (const inbox of [
    join(runDirectory(stateDir, runId), 'inbox'),
    join(stateDir, `${runId}.inbox`),
  ])
    try {
      entries.push(...(await readdir(inbox)).map((name) => join(inbox, name)));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      unreadable += 1;
      warnings.push(`Could not read ${inbox}, so prune keeps ${runId}: ${message(error)}`);
    }
  if (!entries.length) return unreadable;
  let record;
  try {
    record = await readRequiredRun({ runId, stateDir });
  } catch (error) {
    warnings.push(
      `Could not read ${runId} to judge its inbox, so prune keeps it: ${message(error)}`,
    );
    return unreadable + entries.length;
  }
  const answers = new Set<string>();
  const consumed = new Set<string>();
  for (const [stepId, step] of Object.entries(record.steps)) {
    if (!step.question) continue;
    let paths: string[];
    try {
      paths = answerCandidates(stateDir, runId, stepId);
    } catch {
      continue;
    }
    for (const path of paths) {
      answers.add(path);
      if (step.question.resolution?.via === 'inbox') consumed.add(path);
    }
  }
  const settled = (path: string): boolean =>
    consumed.has(path) ||
    (rejectedSuffix.test(path) && answers.has(path.replace(rejectedSuffix, '')));
  return unreadable + entries.filter((path) => !settled(path)).length;
}

/** Whether the recorded cwd is missing; null when stat fails for another reason. */
async function cwdMissing(run: RunSummary, warnings: string[]): Promise<boolean | null> {
  try {
    await stat(run.cwd);
    return false;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return true;
    warnings.push(
      `Could not check the cwd ${run.cwd} of ${run.id}, so prune keeps it: ${message(error)}`,
    );
    return null;
  }
}

interface Row {
  readonly summary: RunSummary;
  readonly stateDir: string;
  readonly candidate: PruneCandidate;
}

/** Oldest `updatedAt` first, then by runs container and run ID. */
function compareAge(
  a: { readonly updatedAt: string; readonly stateDir: string; readonly runId: string },
  b: { readonly updatedAt: string; readonly stateDir: string; readonly runId: string },
): number {
  for (const key of ['updatedAt', 'stateDir', 'runId'] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  return 0;
}

/** The skipped entry of a protected run, with rm's own explanation for a lock or orphans. */
function protectedEntry(
  row: Row,
  protection: PruneProtection,
  launcher?: CommandLauncher,
): PruneSkippedRun {
  const { id: runId } = row.summary;
  const { stateDir } = row;
  const rmArgv = workflowArgv(launcher, 'rm', runId, '--state-dir', stateDir);
  const base = skippedBase(row);
  switch (protection.reason) {
    case 'locked':
    case 'orphans': {
      const refusal = removalRefusal(runId, stateDir, protection.hold, launcher);
      return {
        ...base,
        reason: protection.reason,
        code: refusal.code,
        message: refusal.message,
        details: jsonValue(refusal.details),
      };
    }
    case 'active':
      return {
        ...base,
        reason: 'active',
        code: 'run.active',
        message: `Run ${runId} is ${protection.status}; prune never removes a running, stale or suspended run. If nothing needs it, remove it deliberately with ${formatArgv([...rmArgv, '--force'])}.`,
        details: { status: protection.status },
      };
    case 'waiting':
      return {
        ...base,
        reason: 'waiting',
        code: 'run.active',
        message: `Run ${runId} still has waiting steps (${protection.waiting.join(', ')}); a pending wait, answer or resume may still need it. If nothing does, remove it deliberately with ${formatArgv([...rmArgv, '--force'])}.`,
        details: { waiting: [...protection.waiting] },
      };
    case 'queued-answer':
      return {
        ...base,
        reason: 'queued-answer',
        code: null,
        message: `Run ${runId} has ${String(protection.queuedAnswers)} queued answer deliveries in its inbox; a resume may still consume them. Resume it, or remove it deliberately with ${formatArgv(rmArgv)}.`,
        details: { queuedAnswers: protection.queuedAnswers },
      };
  }
}

function skippedBase(row: Row): Omit<PruneSkippedRun, 'reason' | 'code' | 'message' | 'details'> {
  return {
    runId: row.summary.id,
    stateDir: row.stateDir,
    status: row.summary.status,
    updatedAt: row.summary.updatedAt,
    cwd: row.summary.cwd,
    bytes: row.summary.bytes ?? null,
  };
}

/** The skip reason of a `run.*` code that refused one removal. */
function refusalReason(code: CliErrorCode): PruneSkipReason {
  switch (code) {
    case 'run.exists':
      return 'changed';
    case 'run.not_found':
      return 'gone';
    case 'run.locked':
      return 'locked';
    case 'run.orphans':
      return 'orphans';
    case 'run.active':
      return 'active';
    default:
      return 'refused';
  }
}

/** The codes with which a finish refuses a leftover that ownership holds or that changed. */
const quietRefusals: ReadonlySet<CliErrorCode> = new Set([
  'run.locked',
  'run.orphans',
  'run.exists',
  'run.not_found',
]);

/**
 * Finish (or, in a dry run, list) the interrupted flat-run removals in every scanned container
 * (ADR 0061). A dry run lists the leftovers ownership does not hold; a real run finishes each one
 * through `finishInterruptedRemoval`, which judges ownership and re-checks under the run lock. A
 * leftover that is held or changed (usually a run being created) is skipped silently, and any other
 * failure becomes a warning. A signal stops it between leftovers, or inside one, with `error` set.
 * `attributed` holds every path of the listed leftovers, for the project-root judgement.
 */
async function sweepInterruptedRemovals(
  stateDirs: readonly string[],
  dryRun: boolean,
  live: PruneRunsLive,
  warnings: string[],
): Promise<{
  readonly paths: string[];
  readonly attributed: string[];
  readonly error?: unknown;
}> {
  const { signal } = live;
  const paths: string[] = [];
  const attributed: string[] = [];
  for (const directory of stateDirs) {
    const scan = await scanInterruptedRemovals(directory);
    warnings.push(...scan.warnings);
    for (const removal of scan.removals) {
      if (signal?.aborted) return { paths, attributed, error: signal.reason };
      const { runId, stateDir } = removal;
      if (dryRun) {
        const ownership = await inspectRunOwnership({ runId, stateDir }).catch(() => null);
        if (ownership === null || ownershipHold(ownership)) continue;
      } else
        try {
          const beforeLock = live.beforeLock;
          await finishInterruptedRemoval(
            removal,
            {
              signal,
              processSupervisor: live.processSupervisor,
              commandLauncher: live.commandLauncher,
              ...(beforeLock === undefined
                ? {}
                : { beforeLock: () => beforeLock(runId, stateDir) }),
            },
            { force: false, refs: false, tombstones: [] },
          );
        } catch (error) {
          if (signal?.aborted) return { paths, attributed, error };
          if (!(error instanceof RunRefusedError && quietRefusals.has(error.code)))
            warnings.push(
              `Could not finish the interrupted removal of ${removal.path}: ${message(error)}`,
            );
          continue;
        }
      paths.push(removal.path);
      attributed.push(...removal.paths);
    }
  }
  return { paths, attributed };
}

/**
 * Select runs with {@link pruneDecision} and remove each through `removeRun`, oldest first, one at a
 * time and each under its own guard: prune never deletes a file itself and never forces. It lists
 * every scanned runs container through `listRuns` (whose failure to read a container fails the
 * prune), sweeps abandoned rm tombstones there and finishes the interrupted flat-run removals it
 * finds there (ADR 0061, through `finishInterruptedRemoval`), then removes the selected runs with
 * `expectedUpdatedAt` pinned to the listed record. A refusal or a failure of one removal becomes a
 * skipped entry and the batch goes on. A signal stops it between removals (a removal past its
 * commit point still finishes) and reports the runs removed so far. A dry run passes `dryRun` to
 * every removal, so it takes no lock and changes nothing. With both `missingCwd` and `all`, it then
 * hands the stale XDG project roots to `pruneRoots` (ADR 0051), which skips the paths of the runs
 * removed here, so a dry run predicts the real one. @internal
 */
export async function pruneRuns(
  options: PruneRunsOptions,
  runner: ProcessRunner,
  live: PruneRunsLive = {},
): Promise<PruneOutcome> {
  const { signal } = live;
  const stateDir = resolveStateDir({ stateDir: options.stateDir });
  const discovered = options.all ? await projectRoots() : [];
  const projects = registeredProjects(discovered);
  const stateDirs = [
    ...new Set(
      [stateDir, ...(options.additionalStateDirs ?? []), ...projects.directories].map((directory) =>
        resolveStateDir({ stateDir: directory }),
      ),
    ),
  ];
  const [first, ...rest] = stateDirs;
  const listing = await listRuns({ stateDir: first ?? stateDir, additionalStateDirs: rest });
  const warnings = [...projects.warnings, ...listing.warnings];
  const nowMs = (live.now ?? Date.now)();
  const filters = {
    statuses: options.statuses,
    olderThanMs: options.olderThanMs,
    missingCwd: options.missingCwd,
  };
  const selected: Row[] = [];
  const protectedRows: [Row, PruneProtection][] = [];
  for (const summary of listing.runs) {
    const runStateDir = summary.stateDir ?? stateDir;
    const candidate: PruneCandidate = {
      runId: summary.id,
      stateDir: runStateDir,
      status: summary.status,
      updatedAt: summary.updatedAt,
      cwdMissing: options.missingCwd ? await cwdMissing(summary, warnings) : null,
      waiting: summary.steps.filter((step) => step.status === 'waiting').map((step) => step.id),
      queuedAnswers: await queuedAnswers(runStateDir, summary.id, warnings),
      hold: ownershipHold(summary.ownership),
    };
    const decision = pruneDecision(candidate, filters, nowMs);
    const row = { summary, stateDir: runStateDir, candidate };
    if (decision.kind === 'select') selected.push(row);
    else if (decision.kind === 'protect') protectedRows.push([row, decision]);
  }
  selected.sort((a, b) => compareAge(a.candidate, b.candidate));
  const tombstones = new Set<string>();
  for (const directory of stateDirs)
    for (const name of await (options.dryRun ? deadTombstones : sweepTombstones)(directory))
      tombstones.add(join(directory, name));
  const unfinished = await sweepInterruptedRemovals(stateDirs, options.dryRun, live, warnings);
  const unfinishedRemovals = unfinished.paths;
  if (unfinished.error !== undefined)
    return {
      kind: 'interrupted',
      removed: [],
      roots: [],
      unfinishedRemovals,
      error: unfinished.error,
    };
  const removed: PrunedRun[] = [];
  const skipped = protectedRows.map(([row, protection]) =>
    protectedEntry(row, protection, live.commandLauncher),
  );
  for (const row of selected) {
    if (signal?.aborted)
      return { kind: 'interrupted', removed, roots: [], unfinishedRemovals, error: signal.reason };
    const { summary } = row;
    try {
      const beforeLock = live.beforeLock;
      const outcome = await removeRun(
        {
          runId: summary.id,
          stateDir: row.stateDir,
          force: false,
          refs: options.refs,
          dryRun: options.dryRun,
          expectedUpdatedAt: summary.updatedAt,
        },
        runner,
        {
          signal,
          processSupervisor: live.processSupervisor,
          commandLauncher: live.commandLauncher,
          ...(beforeLock === undefined
            ? {}
            : { beforeLock: () => beforeLock(summary.id, row.stateDir) }),
        },
      );
      if (outcome.kind === 'blocked') {
        skipped.push({
          ...skippedBase(row),
          reason: 'storage',
          code: 'workflow.storage',
          message: outcome.message,
          details: {
            caches: [...outcome.caches],
            removedCaches: [...outcome.removed],
            warnings: [...outcome.warnings],
          },
        });
        continue;
      }
      const { result } = outcome;
      for (const name of result.tombstones) tombstones.add(join(row.stateDir, name));
      if (result.verdict !== 'remove') {
        skipped.push({
          ...skippedBase(row),
          reason: refusalReason(result.verdict.code),
          code: result.verdict.code,
          message: result.verdict.message,
          details: null,
        });
        continue;
      }
      removed.push({
        runId: summary.id,
        stateDir: row.stateDir,
        status: summary.status,
        updatedAt: summary.updatedAt,
        cwd: summary.cwd,
        bytes: result.bytes,
        paths: result.paths,
        caches: result.caches,
        refsRemoved: result.refsRemoved,
        keptRefs: result.keptRefs,
        warnings: result.warnings,
      });
    } catch (error) {
      if (signal?.aborted)
        return { kind: 'interrupted', removed, roots: [], unfinishedRemovals, error };
      skipped.push(
        error instanceof RunRefusedError
          ? {
              ...skippedBase(row),
              reason: refusalReason(error.code),
              code: error.code,
              message: error.message,
              details: error.details,
            }
          : {
              ...skippedBase(row),
              reason: 'storage',
              code: 'workflow.storage',
              message: message(error),
              details: null,
            },
      );
    }
  }
  let roots: PruneRoot[] = [];
  if (options.missingCwd && options.all) {
    const gone = new Set(removed.map((run) => `${run.stateDir}\0${run.runId}`));
    const outcome = await pruneRoots(
      {
        roots: discovered,
        current: dirname(defaultStateDir()),
        held: listing.runs
          .map((summary) => ({ runId: summary.id, stateDir: summary.stateDir ?? stateDir }))
          .filter((run) => !gone.has(`${run.stateDir}\0${run.runId}`)),
        attributed: new Set([
          ...removed.flatMap((run) => [...run.paths, ...run.caches.map((cache) => cache.path)]),
          ...tombstones,
          ...unfinished.attributed,
        ]),
        dryRun: options.dryRun,
      },
      { signal, beforeRmdir: live.beforeRmdir },
    );
    if (outcome.kind === 'interrupted')
      return {
        kind: 'interrupted',
        removed,
        roots: outcome.roots.filter((root) => root.removed).map((root) => root.root),
        unfinishedRemovals,
        error: outcome.error,
      };
    roots = outcome.roots;
    warnings.push(...outcome.warnings);
  }
  return {
    kind: 'done',
    result: {
      dryRun: options.dryRun,
      stateDirs,
      filters: {
        olderThanMs: options.olderThanMs,
        statuses: [...options.statuses],
        missingCwd: options.missingCwd,
        all: options.all,
        refs: options.refs,
      },
      removed,
      skipped: skipped.sort(compareAge),
      bytes: removed.reduce((total, run) => total + run.bytes, 0),
      tombstones: [...tombstones],
      unfinishedRemovals,
      roots,
      warnings,
    },
  };
}

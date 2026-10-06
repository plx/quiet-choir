import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { runBytes } from '../runtime/run-size.js';
import type { WorktreeStep } from '../runtime/worktree-schema.js';
import type { ExecSummary, ExecDiagnostics } from '../runtime/exec-model.js';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../runtime/json.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { resolveStateDir, projectStateDirectories } from '../runtime/paths.js';
import {
  inspectRunOwnership,
  listRunIds,
  recordSchemaDrift,
  recordSchemaWarning,
  type ReadRunOptions,
  type RunOwnership,
  type RunRecord,
  type StepRecord,
} from '../runtime/store.js';
import { summarizeUsage } from '../runtime/usage-summary.js';
import { latestRateLimits, type RateLimitSummary } from '../runtime/rate-limit.js';
import type { RunBudgetStop } from '../runtime/run-budget.js';
import { recordWarnings } from '../runtime/record-warnings.js';
import { classifyRecovery } from '../runtime/recovery-decision.js';
import { brandError, isBranded } from '../runtime/error-brand.js';
import { RunRefusedError, type CliErrorCode } from '../runtime/run-errors.js';
import type { RequestSummary, RunEvent, UsageSummary } from '../runtime/observability-model.js';
import type { ErrorKind, JsonValue } from '../runtime/model.js';
import type { ChildRecord } from '../runtime/child-model.js';
import type { MapStepError } from '../runtime/fan-out.js';
import type { CodeChange } from '../runtime/replay-model.js';
import type { CommandLauncher } from '../runtime/commands.js';
import type { WorktreeAdminLockView } from '../runtime/worktree-admin-lock.js';
import { runNextCommands, type NextCommand } from './next-commands.js';
import { rootCauseSummary, stepErrorKind, type RootCauseSummary } from './failure-kind.js';

/** Inspection states are derived; stale never overwrites the checkpoint status. @internal */
export type InspectionStatus = RunRecord['status'] | 'stale';

/** One agent call in a run summary. @internal */
export interface AgentRow {
  /** Step ID. */
  readonly id: string;
  /** Last saved lifecycle state of the step. */
  readonly status: StepRecord['status'];
  /** Selected harness. */
  readonly harness: string;
  /** Requested model; null means native configuration. Never the effective model. */
  readonly model: string | null;
  /** Requested effort of the latest attempt, possibly `inherited`, or null when not recorded. */
  readonly effort: string | null;
  /** Resolved capability profile, or null. */
  readonly profile: string | null;
  /** Elapsed time of the latest attempt, or null when unknown. */
  readonly elapsedMs: number | null;
  /** Sum of reported costs of this step's attempts; null when none reported a cost. */
  readonly costUsd: number | null;
  /**
   * Tool calls the latest attempt's adapter counted; absent for older records and adapters that
   * report no count, which keeps the bounded summary compact.
   */
  readonly toolUses?: number;
  /**
   * The step's warnings, such as `no-tool-use` or permission denials; absent when none. Bounded:
   * at most `maxAgentRowWarnings` warnings, each cut to `maxAgentRowWarningChars`, plus a final
   * `+K more warnings` entry when some were dropped. A `no-tool-use` warning is always kept. The
   * full list is in `inspect --full` or the step record.
   */
  readonly warnings?: readonly string[];
}

/** Agent calls rolled up by their requested harness, model, effort and profile. @internal */
export interface AgentGroup {
  /** Selected harness. */
  readonly harness: string;
  /** Requested model; null means native configuration. */
  readonly model: string | null;
  /** Requested effort, or null when not recorded. */
  readonly effort: string | null;
  /** Resolved capability profile, or null. */
  readonly profile: string | null;
  /** Agent steps in this group. */
  readonly steps: number;
  /** Sum of reported costs in this group; null when none reported a cost. */
  readonly costUsd: number | null;
}

/** Most recent agent rows kept in a summary, whatever the run size. @internal */
export const maxRecentAgents = 50;

/** Warnings kept on one compact agent row; the rest are counted, not copied. @internal */
export const maxAgentRowWarnings = 3;

/** Characters kept of each warning on a compact agent row. @internal */
export const maxAgentRowWarningChars = 200;

/** Compact plain-data projection, shared by text, JSON summary, watch, and list. @internal */
export interface RunSummary {
  readonly children: readonly (Omit<ChildRecord, 'settled'> & {
    /**
     * A settled frame's outcome, without the output value or owned IDs so summaries stay bounded;
     * `--full` shows the whole frame record.
     */
    readonly settled?: { readonly ok: true } | { readonly ok: false; readonly error: MapStepError };
    readonly id: string;
    readonly steps: number;
    readonly usage: UsageSummary;
    readonly phases: readonly string[];
  })[];
  readonly cwd: string;
  readonly stateDir?: string;
  /**
   * Runnable follow-ups for a failed, stale or suspended run, set by `inspectRun` beside
   * `stateDir`; empty for other statuses and for runs without a stored entrypoint.
   */
  readonly next?: readonly NextCommand[];
  readonly harnesses: NonNullable<RunRecord['harnesses']>;
  readonly id: string;
  readonly workflow: { readonly name: string; readonly version: string };
  readonly status: InspectionStatus;
  readonly recordedStatus: RunRecord['status'];
  readonly nextWakeAt: number | null;
  /** Why the latest execution was interrupted into a resumable suspension, or null. */
  readonly interruptedBy: NonNullable<RunRecord['interruptedBy']> | null;
  readonly execution: number | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly lastActivityAt: string;
  readonly lastActivityAgeMs: number;
  readonly ownership: RunOwnership;
  readonly phase: {
    readonly title: string;
    readonly total: number | null;
    readonly completed: number;
    readonly running: number;
  } | null;
  readonly counts: Record<StepRecord['status'], number> & { total: number };
  readonly steps: readonly {
    readonly id: string;
    readonly seq: number | null;
    readonly kind: StepRecord['kind'];
    readonly meta: StepRecord['meta'] | null;
    readonly status: StepRecord['status'];
    readonly phase: string | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly elapsedMs: number | null;
    readonly attempts: number;
    readonly request: RequestSummary | null;
    readonly exec: ExecSummary | null;
    readonly execError: ExecDiagnostics | null;
    readonly worktree:
      (WorktreeStep & { readonly directoryState: 'present' | 'missing' | 'removed' }) | null;
    readonly merge: StepRecord['merge'] | null;
    readonly error: string | null;
    /** Kind of the step's last attempt failure; null without a failed attempt. */
    readonly errorKind: ErrorKind | null;
    readonly rootCause: boolean;
  }[];
  readonly rootCause: RootCauseSummary | null;
  readonly error: string | null;
  readonly errorStack: string | null;
  /** The workflow's output once the recorded status is completed; null otherwise. */
  readonly output: JsonValue;
  /**
   * Agent calls (claude, codex and agent steps, excluding fork-reused ones). `model` is the
   * requested model and never assumed effective; `recent` holds at most the last 50 calls in
   * first-use order and `byRequest` covers all of them.
   */
  readonly agents: {
    readonly total: number;
    readonly byRequest: readonly AgentGroup[];
    readonly recent: readonly AgentRow[];
  };
  readonly usage: UsageSummary;
  /**
   * The latest subscription rate-limit windows each harness reported, by harness name (#156).
   * Only Claude reports them today. Each entry comes from the attempt with a valid
   * `diagnostics.rateLimit` that settled last, failed attempts included and fork-reused steps
   * excluded; `resetsAt` is Unix epoch seconds as reported. The key is absent when no attempt
   * reported windows, so a run without them serializes as before.
   */
  readonly rateLimits?: Readonly<Record<string, RateLimitSummary>>;
  /**
   * The latest execution's run-cap refusal (`budgetStop`) as saved: the refused step, the metric,
   * its limit and observed value, and for `maxWindowUtilization` the harness, window and reset. The
   * key is absent when the run has none, so a run without one serializes as before.
   */
  readonly budgetStop?: RunBudgetStop;
  /** The last 5 `log`, `phase` and `wait.tolerated` (tolerated poll error) entries, as stored. */
  readonly recent: readonly RunEvent[];
  /** The latest accepted code changes, at most 5, as stored; a map entry names its settled map. */
  readonly codeChanges: readonly CodeChange[];
  /**
   * Saved policy, replay, harness, worktree and wait warnings, the ownership warning, and a
   * record-schema warning when this build cannot fully read the record (a newer `schemaRevision`
   * or top-level fields it does not know).
   */
  readonly warnings: readonly string[];
  /**
   * On-disk bytes of the run's files in its runs container (`runBytes`): everything under
   * `<runId>/` plus the legacy flat files, excluding worktree caches. Set only by `listRuns`, and
   * null there when the size could not be measured; inspect and watch never compute it.
   */
  readonly bytes?: number | null;
}

/** Bounded list row: the fields a script needs to find and triage runs. @internal */
export interface RunListRow {
  readonly id: string;
  readonly workflow: RunSummary['workflow'];
  readonly status: InspectionStatus;
  readonly recordedStatus: RunRecord['status'];
  readonly counts: RunSummary['counts'];
  readonly updatedAt: string;
  readonly ownership: RunOwnership;
  readonly nextWakeAt: number | null;
  readonly cwd: string;
  readonly stateDir?: string;
  readonly warnings: readonly string[];
  /** As on {@link RunSummary.bytes}: present on every `listRuns` row, null when unmeasurable. */
  readonly bytes?: number | null;
  readonly usage: Pick<
    UsageSummary,
    | 'attempts'
    | 'costUsd'
    | 'inputTokens'
    | 'outputTokens'
    | 'unknownTokenAttempts'
    | 'unknownCostAttempts'
  >;
}

/** Project a full summary onto its compact list row. @internal */
export function toRunListRow(summary: RunSummary): RunListRow {
  const { usage } = summary;
  return {
    id: summary.id,
    workflow: summary.workflow,
    status: summary.status,
    recordedStatus: summary.recordedStatus,
    counts: summary.counts,
    updatedAt: summary.updatedAt,
    ownership: summary.ownership,
    nextWakeAt: summary.nextWakeAt,
    cwd: summary.cwd,
    ...(summary.stateDir === undefined ? {} : { stateDir: summary.stateDir }),
    warnings: summary.warnings,
    ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
    usage: {
      attempts: usage.attempts,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      unknownTokenAttempts: usage.unknownTokenAttempts,
      unknownCostAttempts: usage.unknownCostAttempts,
    },
  };
}

function stepElapsed(step: StepRecord, now: number): number | null {
  return step.status === 'running' && step.startedAt
    ? Math.max(0, now - Date.parse(step.startedAt))
    : (step.durationMs ?? null);
}

/**
 * Bound a step's warnings for the compact summary: keep any `no-tool-use` warning, fill the other
 * slots in record order, cut each to the character cap and count the dropped ones.
 */
function boundedWarnings(warnings: readonly string[]): string[] {
  const priority = (warning: string): boolean => warning.startsWith('no-tool-use:');
  const kept = new Set<number>();
  for (const wantPriority of [true, false]) {
    warnings.forEach((warning, index) => {
      if (kept.size < maxAgentRowWarnings && priority(warning) === wantPriority) kept.add(index);
    });
  }
  const rows = warnings
    .filter((_, index) => kept.has(index))
    .map((warning) =>
      warning.length > maxAgentRowWarningChars
        ? `${warning.slice(0, maxAgentRowWarningChars - 1)}…`
        : warning,
    );
  const dropped = warnings.length - kept.size;
  return dropped > 0 ? [...rows, `+${String(dropped)} more warnings`] : rows;
}

/** The latest attempt's reported tool count and the step's warnings, each only when present. */
function optionalAgentFields(step: StepRecord): Pick<AgentRow, 'toolUses' | 'warnings'> {
  const value = step.attemptHistory?.at(-1)?.diagnostics?.['toolUses'];
  return {
    ...(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? { toolUses: value }
      : {}),
    ...(step.warnings?.length ? { warnings: boundedWarnings(step.warnings) } : {}),
  };
}

/** Agent calls only: fork-reused steps are excluded, as usage excludes them. */
function summarizeAgents(
  run: RunRecord,
  entries: readonly (readonly [string, StepRecord])[],
  now: number,
): RunSummary['agents'] {
  const cost = (steps: Record<string, StepRecord>): number | null =>
    summarizeUsage({ ...run, steps }).costUsd;
  const agents = entries
    .filter(
      ([, step]) =>
        (step.kind === 'claude' || step.kind === 'codex' || step.kind === 'agent') &&
        !step.reusedFrom,
    )
    .map(([id, step]) => {
      const attempt = step.attemptHistory?.at(-1);
      return {
        id,
        step,
        harness:
          step.request?.harness ?? (step.kind === 'agent' ? step.harness : undefined) ?? step.kind,
        model: step.request?.model ?? null,
        effort: attempt?.requested?.effort ?? attempt?.effort ?? null,
        profile: step.request?.profile ?? attempt?.profile ?? null,
      };
    });
  const groups = new Map<
    string,
    { head: (typeof agents)[number]; steps: Record<string, StepRecord> }
  >();
  for (const agent of agents) {
    const key = JSON.stringify([agent.harness, agent.model, agent.effort, agent.profile]);
    const group = groups.get(key) ?? { head: agent, steps: {} };
    group.steps[agent.id] = agent.step;
    groups.set(key, group);
  }
  return {
    total: agents.length,
    byRequest: [...groups.values()].map(({ head, steps }) => ({
      harness: head.harness,
      model: head.model,
      effort: head.effort,
      profile: head.profile,
      steps: Object.keys(steps).length,
      costUsd: cost(steps),
    })),
    recent: agents.slice(-maxRecentAgents).map(({ id, step, harness, model, effort, profile }) => ({
      id,
      status: step.status,
      harness,
      model,
      effort,
      profile,
      elapsedMs: stepElapsed(step, now),
      costUsd: cost({ [id]: step }),
      ...optionalAgentFields(step),
    })),
  };
}

/** Full checkpoint plus its read-only, time-dependent projection. @internal */
export interface RunInspection {
  readonly run: RunRecord;
  readonly ownership: RunOwnership;
  readonly summary: RunSummary;
  /**
   * The held worktree administration lock of the run's repository. Only the executor's plain
   * inspect attaches it; `inspectRun`, `listRuns` and watches never run Git.
   */
  readonly worktreeAdminLock?: WorktreeAdminLockView;
}

/** A running run whose owner is gone: no lock, or a dead or released owner, whatever its children. */
function stale(run: RunRecord, ownership: RunOwnership): boolean {
  return run.status === 'running' && classifyRecovery(ownership) !== 'held';
}

function summarizeChildren(run: RunRecord): RunSummary['children'] {
  const frames = run.children ?? {};
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const [child, frame] of Object.entries(frames)) if (frame.parent === id) visit(child);
  };
  for (const [id, frame] of Object.entries(frames)) if (frame.parent === null) visit(id);
  for (const id of Object.keys(frames)) visit(id);
  const inside = (candidate: string | null | undefined, ancestor: string): boolean => {
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate)) {
      if (candidate === ancestor) return true;
      visited.add(candidate);
      candidate = frames[candidate]?.parent;
    }
    return false;
  };
  return ordered.flatMap((id) => {
    const frame = frames[id];
    if (!frame) return [];
    const steps = Object.fromEntries(
      Object.entries(run.steps).filter(([, step]) => inside(step.frame, id)),
    );
    const { settled, ...rest } = frame;
    return [
      {
        ...rest,
        ...(settled === undefined
          ? {}
          : {
              settled: settled.outcome.ok
                ? { ok: true as const }
                : { ok: false as const, error: settled.outcome.error },
            }),
        id,
        steps: Object.keys(steps).length,
        usage: summarizeUsage({ ...run, steps }),
        phases: [
          ...new Set([
            ...Object.values(steps).flatMap((step) => (step.phase ? [step.phase] : [])),
            ...(run.events ?? []).flatMap((event) =>
              event.type === 'phase' && event.phase && inside(event.frame, id) ? [event.phase] : [],
            ),
          ]),
        ],
      },
    ];
  });
}

/** Step totals by status, derived from the record alone. @internal */
export function countSteps(run: RunRecord): RunSummary['counts'] {
  const counts: RunSummary['counts'] = {
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    'settled-failed': 0,
    superseded: 0,
    waiting: 0,
    withdrawn: 0,
  };
  for (const step of Object.values(run.steps)) {
    counts.total++;
    counts[step.status]++;
  }
  return counts;
}

/** No source import, lock acquisition, or checkpoint mutation. @internal */
export function summarizeRun(
  run: RunRecord,
  ownership: RunOwnership,
  now = Date.now(),
): RunSummary {
  const execution = run.executions?.at(-1);
  const startedAt = execution?.startedAt ?? run.createdAt;
  const entries = Object.entries(run.steps).sort(
    ([a, x], [b, y]) => (x.seq ?? Infinity) - (y.seq ?? Infinity) || a.localeCompare(b),
  );
  const counts = countSteps(run);
  const current = entries.filter(
    ([, step]) => run.phase !== null && run.phase !== undefined && step.phase === run.phase.title,
  );
  const recent = (run.events ?? [])
    .filter(
      (event) => event.type === 'log' || event.type === 'phase' || event.type === 'wait.tolerated',
    )
    .slice(-5);
  const lastActivityAt =
    [
      run.updatedAt,
      ...(run.events ?? []).map((event) => event.at),
      ...entries.flatMap(([, step]) =>
        [step.startedAt, step.finishedAt].filter((at): at is string => !!at),
      ),
    ]
      .sort()
      .at(-1) ?? run.updatedAt;
  const rateLimits = latestRateLimits(entries);
  const drift = recordSchemaDrift(run);
  return {
    children: summarizeChildren(run),
    cwd: run.cwd,
    harnesses: run.harnesses ?? {},
    id: run.id,
    workflow: { name: run.workflow.name, version: run.workflow.version },
    status: stale(run, ownership) ? 'stale' : run.status,
    recordedStatus: run.status,
    nextWakeAt: run.nextWakeAt ?? null,
    interruptedBy: run.interruptedBy ?? null,
    execution: execution?.n ?? null,
    startedAt,
    updatedAt: run.updatedAt,
    elapsedMs: Math.max(
      0,
      (run.status === 'running' ? now : Date.parse(execution?.endedAt ?? run.updatedAt)) -
        Date.parse(startedAt),
    ),
    lastActivityAt,
    lastActivityAgeMs: Math.max(0, now - Date.parse(lastActivityAt)),
    ownership,
    phase: run.phase
      ? {
          ...run.phase,
          completed: current.filter(([, step]) => step.status === 'completed').length,
          running: current.filter(([, step]) => step.status === 'running').length,
        }
      : null,
    counts,
    steps: entries
      .filter(
        ([, step]) =>
          step.kind === 'exec' ||
          step.worktree !== undefined ||
          step.merge !== undefined ||
          ['running', 'failed', 'cancelled', 'settled-failed', 'waiting'].includes(step.status),
      )
      .map(([id, step]) => ({
        id,
        seq: step.seq ?? null,
        kind: step.kind,
        meta: step.meta ?? null,
        status: step.status,
        phase: step.phase ?? null,
        startedAt: step.startedAt ?? null,
        finishedAt: step.finishedAt ?? null,
        elapsedMs: stepElapsed(step, now),
        attempts: step.attempts,
        request: step.request ?? null,
        exec: step.exec ?? null,
        execError: step.execError ?? null,
        worktree: step.worktree
          ? {
              ...step.worktree,
              directoryState: existsSync(step.worktree.path)
                ? ('present' as const)
                : run.worktrees?.caches[digest(step.worktree.path)]?.state === 'removed'
                  ? ('removed' as const)
                  : ('missing' as const),
            }
          : null,
        merge: step.merge ?? null,
        error: step.error,
        errorKind: stepErrorKind(step),
        rootCause: run.rootCause?.stepId === id,
      })),
    rootCause: rootCauseSummary(run),
    error: run.error,
    errorStack: run.errorStack ?? null,
    output: run.status === 'completed' ? run.output : null,
    agents: summarizeAgents(run, entries, now),
    usage: summarizeUsage(run),
    ...(Object.keys(rateLimits).length > 0 ? { rateLimits } : {}),
    ...(run.budgetStop ? { budgetStop: run.budgetStop } : {}),
    recent,
    codeChanges: (run.codeChanges ?? []).slice(-5),
    warnings: [
      ...recordWarnings(run),
      ...(ownership.warning ? [ownership.warning] : []),
      ...(drift ? [recordSchemaWarning(drift)] : []),
    ],
  };
}

/** What to read, and the launcher that starts the summary's `next` commands. @internal */
export interface InspectRunOptions extends ReadRunOptions {
  readonly commandLauncher?: CommandLauncher | undefined;
}

/**
 * Read liveness after the record, then re-read on apparent owner loss to avoid a completion race.
 * A stale verdict only stands when the checkpoint is provably the same before and after the
 * ownership read; otherwise retry, bounded, against the fresh pair. @internal
 */
export async function inspectRun(options: InspectRunOptions): Promise<RunInspection> {
  const stateDir = resolveStateDir(options);
  const inspection = (run: RunRecord, ownership: RunOwnership): RunInspection => {
    const summary = summarizeRun(run, ownership);
    return {
      run,
      ownership,
      summary: {
        ...summary,
        stateDir,
        next: runNextCommands(run, summary.status, stateDir, options.commandLauncher),
      },
    };
  };
  let run = await readRequiredRun(options);
  let ownership = await inspectRunOwnership(options);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!stale(run, ownership)) return inspection(run, ownership);
    const before = digest(run);
    run = await readRequiredRun(options);
    if (run.status !== 'running' || digest(run) !== before) {
      ownership = await inspectRunOwnership(options);
      continue;
    }
    break;
  }
  return inspection(run, ownership);
}

/** Enumerate only checkpoint filenames, skip unreadable runs, and retain diagnostics. @internal */
export async function listRuns(options: {
  readonly all?: boolean;
  readonly additionalStateDirs?: readonly string[];
  readonly stateDir: string;
  readonly status?: InspectionStatus;
  readonly commandLauncher?: CommandLauncher | undefined;
}): Promise<{
  readonly stateDir: string;
  readonly runs: readonly RunSummary[];
  readonly warnings: readonly string[];
}> {
  const stateDir = resolveStateDir(options);
  const projects = options.all
    ? await projectStateDirectories()
    : { directories: [], warnings: [] };
  const roots = new Set([
    stateDir,
    ...(options.additionalStateDirs ?? []),
    ...projects.directories,
  ]);
  const runs: RunSummary[] = [];
  const warnings: string[] = [...projects.warnings];
  for (const directory of roots) {
    const runIds = await listRunIds(directory);
    // One listing per container finds every run's backups without reading it once per run.
    const entries = runIds.length ? await readdir(directory).catch((): string[] => []) : [];
    for (const runId of runIds) {
      try {
        const { summary } = await inspectRun({
          stateDir: directory,
          runId,
          commandLauncher: options.commandLauncher,
        });
        if (options.status !== undefined && summary.status !== options.status) continue;
        let bytes: number | null;
        try {
          bytes = await runBytes(directory, runId, entries);
        } catch (error) {
          bytes = null;
          warnings.push(
            `Could not measure ${runId} in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        runs.push({ ...summary, bytes });
      } catch (error) {
        warnings.push(
          `Skipped ${runId} in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { stateDir, runs, warnings };
}

/**
 * A bounded watch stopped before the run reached a terminal status: `watch.timeout` carries the
 * last observed record (still running, never touched), and `watch.record_not_created` carries no
 * record because none appeared. @internal
 */
export class WatchBoundError extends Error {
  static {
    brandError(this, 'WatchBoundError');
  }

  /** Recognize an instance from any quiet-choir module instance. */
  public static override [Symbol.hasInstance](value: unknown): value is WatchBoundError {
    return isBranded(this, value);
  }

  public constructor(
    /** Which bound expired. */
    public readonly code: Extract<CliErrorCode, `watch.${string}`>,
    /** The watched run. */
    public readonly runId: string,
    message: string,
    /** The expired bound, as `{ timeoutMs }` or `{ waitCreatedMs }`. */
    public readonly details: { readonly timeoutMs: number } | { readonly waitCreatedMs: number },
    /** The last observed record; null when none was ever read. */
    public readonly run: RunRecord | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WatchBoundError';
  }
}

/** Milliseconds a timer can wait: a safe integer from 1 to 2^31 - 1. */
function validWatchDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/** Bounds of a watch; both are opt-in and measured on a monotonic clock. @internal */
export interface WatchRunOptions extends InspectRunOptions {
  readonly intervalMs: number;
  /** Fail with `watch.timeout` when still running this long after the first successful read. */
  readonly timeoutMs?: number | undefined;
  /** Retry `run.not_found` until this long after the watch starts, before the first read only. */
  readonly waitCreatedMs?: number | undefined;
  /**
   * Whether a snapshot ends the watch; omitted means any status other than `running`. A follower
   * of a resume passes a stricter test so an earlier execution's terminal status does not end it.
   */
  readonly done?: ((value: RunInspection) => boolean) | undefined;
}

/**
 * Deliver one snapshot per stored/ownership change; elapsed time alone is not a JSONL change.
 * Each bound sleeps at most until its deadline and reads once more there, so a run that finishes
 * at the deadline is reported as finished and the watch ends within one read after it. @internal
 */
export async function watchRun(
  options: WatchRunOptions,
  onChange: (value: RunInspection) => void,
  signal?: AbortSignal,
): Promise<RunInspection> {
  if (!validWatchDuration(options.intervalMs))
    throw new Error('Watch interval must be 1ms to 2147483647ms.');
  if (options.timeoutMs !== undefined && !validWatchDuration(options.timeoutMs))
    throw new Error('Watch timeout must be 1ms to 2147483647ms.');
  if (options.waitCreatedMs !== undefined && !validWatchDuration(options.waitCreatedMs))
    throw new Error('Watch wait-created bound must be 1ms to 2147483647ms.');
  const sleep = (deadline: number | undefined): Promise<void> =>
    delay(
      deadline === undefined
        ? options.intervalMs
        : Math.max(1, Math.min(options.intervalMs, Math.ceil(deadline - performance.now()))),
      undefined,
      signal ? { signal } : {},
    );
  const { timeoutMs, waitCreatedMs } = options;
  const startedAt = performance.now();
  let finishBy: number | undefined;
  let prior: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    let current: RunInspection;
    try {
      current = await inspectRun(options);
    } catch (error) {
      // Only a record that was never seen may still be on its way; a later not_found stays one.
      if (
        waitCreatedMs === undefined ||
        prior !== undefined ||
        !(error instanceof RunRefusedError && error.code === 'run.not_found')
      )
        throw error;
      const createdBy = startedAt + waitCreatedMs;
      if (performance.now() >= createdBy)
        throw new WatchBoundError(
          'watch.record_not_created',
          options.runId,
          `Run ${options.runId} was not created within ${String(waitCreatedMs)}ms. ${error.message}`,
          { waitCreatedMs },
          null,
          { cause: error },
        );
      await sleep(createdBy);
      continue;
    }
    if (timeoutMs !== undefined) finishBy ??= performance.now() + timeoutMs;
    const key = digest({ run: current.run, ownership: current.ownership });
    if (key !== prior) {
      onChange(current);
      prior = key;
    }
    if (options.done ? options.done(current) : current.summary.status !== 'running') return current;
    if (timeoutMs !== undefined && finishBy !== undefined && performance.now() >= finishBy)
      throw new WatchBoundError(
        'watch.timeout',
        options.runId,
        current.summary.status === 'running'
          ? `Run ${options.runId} is still running after ${String(timeoutMs)}ms of watching; the watch stopped and the run keeps running.`
          : `Run ${options.runId} is ${current.summary.status} and no later execution finished within ${String(timeoutMs)}ms of watching; the watch stopped.`,
        { timeoutMs },
        current.run,
      );
    await sleep(finishBy);
  }
}

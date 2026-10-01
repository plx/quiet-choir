import { existsSync } from 'node:fs';
import type { WorktreeStep } from '../runtime/worktree-schema.js';
import type { ExecSummary, ExecDiagnostics } from '../runtime/exec-model.js';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../runtime/json.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { resolveStateDir, projectStateDirectories } from '../runtime/paths.js';
import {
  inspectRunOwnership,
  listRunIds,
  type ReadRunOptions,
  type RunOwnership,
  type RunRecord,
  type StepRecord,
} from '../runtime/store.js';
import { summarizeUsage } from '../runtime/usage-summary.js';
import { classifyRecovery } from '../runtime/recovery-decision.js';
import type { RequestSummary, RunEvent, UsageSummary } from '../runtime/observability-model.js';
import type { ChildRecord } from '../runtime/child-model.js';

/** Inspection states are derived; stale never overwrites the checkpoint status. @internal */
export type InspectionStatus = RunRecord['status'] | 'stale';

/** Compact plain-data projection, shared by text, JSON summary, watch, and list. @internal */
export interface RunSummary {
  readonly children: readonly (ChildRecord & {
    readonly id: string;
    readonly steps: number;
    readonly usage: UsageSummary;
    readonly phases: readonly string[];
  })[];
  readonly cwd: string;
  readonly stateDir?: string;
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
    readonly rootCause: boolean;
  }[];
  readonly rootCause: RunRecord['rootCause'];
  readonly error: string | null;
  readonly errorStack: string | null;
  readonly usage: UsageSummary;
  readonly recent: readonly RunEvent[];
  readonly warnings: readonly string[];
}

/** Full checkpoint plus its read-only, time-dependent projection. @internal */
export interface RunInspection {
  readonly run: RunRecord;
  readonly ownership: RunOwnership;
  readonly summary: RunSummary;
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
    return [
      {
        ...frame,
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
  const counts: RunSummary['counts'] = {
    total: entries.length,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    'settled-failed': 0,
    superseded: 0,
    waiting: 0,
    withdrawn: 0,
  };
  for (const [, step] of entries) counts[step.status]++;
  const current = entries.filter(
    ([, step]) => run.phase !== null && run.phase !== undefined && step.phase === run.phase.title,
  );
  const recent = (run.events ?? [])
    .filter((event) => event.type === 'log' || event.type === 'phase')
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
        elapsedMs:
          step.status === 'running' && step.startedAt
            ? Math.max(0, now - Date.parse(step.startedAt))
            : (step.durationMs ?? null),
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
        rootCause: run.rootCause?.stepId === id,
      })),
    rootCause: run.rootCause ?? null,
    error: run.error,
    errorStack: run.errorStack ?? null,
    usage: summarizeUsage(run),
    recent,
    warnings: [
      ...(run.policyWarnings ?? []),
      ...(run.replayWarnings ?? []),
      ...(run.harnessWarnings ?? []),
      ...(run.worktreeWarnings ?? []),
      ...(run.waitWarnings ?? []),
      ...(ownership.warning ? [ownership.warning] : []),
    ],
  };
}

/**
 * Read liveness after the record, then re-read on apparent owner loss to avoid a completion race.
 * A stale verdict only stands when the checkpoint is provably the same before and after the
 * ownership read; otherwise retry, bounded, against the fresh pair. @internal
 */
export async function inspectRun(options: ReadRunOptions): Promise<RunInspection> {
  const stateDir = resolveStateDir(options);
  const inspection = (run: RunRecord, ownership: RunOwnership): RunInspection => ({
    run,
    ownership,
    summary: { ...summarizeRun(run, ownership), stateDir },
  });
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
    for (const runId of await listRunIds(directory)) {
      try {
        const { summary } = await inspectRun({ stateDir: directory, runId });
        if (options.status === undefined || summary.status === options.status) runs.push(summary);
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

/** Deliver one snapshot per stored/ownership change; elapsed time alone is not a JSONL change. @internal */
export async function watchRun(
  options: ReadRunOptions & { readonly intervalMs: number },
  onChange: (value: RunInspection) => void,
  signal?: AbortSignal,
): Promise<RunInspection> {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > 2_147_483_647
  )
    throw new Error('Watch interval must be 1ms to 2147483647ms.');
  let prior: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const current = await inspectRun(options);
    const key = digest({ run: current.run, ownership: current.ownership });
    if (key !== prior) {
      onChange(current);
      prior = key;
    }
    if (current.summary.status !== 'running') return current;
    await delay(options.intervalMs, undefined, signal ? { signal } : {});
  }
}

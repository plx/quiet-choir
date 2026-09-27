import type { InspectionStatus, RunSummary } from '../workflow/loader/inspection.js';

/** Human units for elapsed time and call limits. @internal */
function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** A snapshot's terminal state, distinct from non-watching inspect's successful read. @internal */
export const watchExitCodes = {
  completed: 0,
  suspended: 75,
  failed: 1,
  cancelled: 130,
  stale: 3,
  running: 0,
} as const satisfies Record<InspectionStatus, number>;

/** Keep polling syntax separate from runtime timing and oclif. @internal */
export function parseWatchInterval(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/u.exec(value);
  const ms = match
    ? Number(match[1]) * (match[2] === 'm' ? 60_000 : match[2] === 's' ? 1000 : 1)
    : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647)
    throw new Error(
      'Watch interval must be 1ms to 2147483647ms, with an ms, s, or m suffix (for example 2s).',
    );
  return ms;
}

function cost(run: RunSummary): string {
  const u = run.usage;
  return `${u.costUsd === null ? 'unknown cost' : `$${u.costUsd.toFixed(4)}`}, ${u.inputTokens === null ? '?' : String(u.inputTokens)} in / ${u.outputTokens === null ? '?' : String(u.outputTokens)} out tokens${u.incompleteAttempts ? ` (partial; ${String(u.incompleteAttempts)}/${String(u.attempts)} attempts missing usage)` : ''}`;
}

function owner(run: RunSummary): string {
  const value = run.ownership.owner;
  return value
    ? `pid ${String(value.pid)} (${value.state}) on ${value.host}`
    : run.ownership.locked
      ? 'unknown (incomplete lock)'
      : 'no lock';
}

/** Render only known values: a running workflow never ends in a bare null. @internal */
export function formatRunSummary(run: RunSummary, verbose = false): string {
  const lines = [
    `Run ${run.id}: ${run.status}  ${run.workflow.name}@${run.workflow.version}`,
    `Owner: ${owner(run)}  started ${run.startedAt} (${duration(run.elapsedMs)})  last activity ${duration(run.lastActivityAgeMs)} ago`,
    ...(run.phase
      ? [
          `Phase: ${run.phase.title} ${String(run.phase.completed)}${run.phase.total === null ? '' : `/${String(run.phase.total)}`} (${String(run.phase.running)} running)`,
        ]
      : []),
    `Steps: ${String(run.counts.total)}: ${
      Object.entries(run.counts)
        .filter(([key, count]) => key !== 'total' && count > 0)
        .map(([key, count]) => `${String(count)} ${key}`)
        .join(', ') || 'none'
    }`,
  ];
  for (const [provider, value] of Object.entries(run.harnesses))
    lines.push(`Harness ${provider}: ${value.binary}@${value.version ?? 'unknown'}`);
  for (const step of run.steps) {
    const request = step.request;
    if (step.exec) {
      const command = step.exec.command;
      lines.push(
        `Command ${step.id}${'shell' in command ? ' [SHELL]' : ' [argv]'}: ${JSON.stringify(command)} (cwd ${step.exec.cwd})`,
      );
    }
    if (step.execError)
      lines.push(
        `Command exit: ${step.execError.signal ?? String(step.execError.code)}; stderr tail: ${JSON.stringify(step.execError.stderrTail)}`,
      );
    const limits = request
      ? [
          request.limits.timeoutMs === null
            ? null
            : `per-call timeout ${duration(request.limits.timeoutMs)}`,
          request.limits.maxTurns === null ? null : `${String(request.limits.maxTurns)} turns`,
          request.limits.maxBudgetUsd === null
            ? null
            : `$${String(request.limits.maxBudgetUsd)} budget`,
          request.limits.sandbox,
        ]
          .filter((value) => value !== null)
          .join(', ')
      : '';
    lines.push(
      `${step.status} ${step.id}  ${request ? `${request.provider} ${request.model ?? '(native model)'}` : step.kind}${step.elapsedMs === null ? '' : `  ${duration(step.elapsedMs)} elapsed`}${limits ? `; ${limits}` : ''}${step.rootCause ? ' [root cause]' : ''}${step.error ? `  ${step.error}` : ''}`,
    );
  }
  if (run.rootCause)
    lines.push(`Root cause (${run.rootCause.stepId ?? 'workflow'}): ${run.rootCause.error}`);
  else if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(`Usage: ${cost(run)}`);
  for (const event of run.recent)
    lines.push(
      `Recent: ${event.at}${event.phase ? ` [${event.phase}]` : ''} ${event.message ?? event.type}${event.data === null ? '' : ` ${JSON.stringify(event.data)}`}`,
    );
  for (const process of run.ownership.processes)
    lines.push(
      process.process
        ? `Process: ${process.process.binary} pid ${String(process.process.pid)} group ${String(process.process.pgid)} step ${process.process.stepId} attempt ${String(process.process.attempt)} ${process.state}`
        : `Process: ${process.file} ${process.state}: ${process.detail ?? ''}`,
    );
  for (const warning of run.warnings) lines.push(`Warning: ${warning}`);
  if (verbose && run.errorStack) lines.push(run.errorStack);
  return lines.join('\n');
}

/** One row per run; no source loading or result payload expansion. @internal */
export function formatRunList(runs: readonly RunSummary[], showProject = false): string {
  if (!runs.length) return 'No runs found.';
  return [
    `ID  WORKFLOW  STATUS  STEPS  USAGE  UPDATED  OWNER${showProject ? '  PROJECT  STATE' : ''}`,
    ...runs.map(
      (run) =>
        `${run.id}  ${run.workflow.name}@${run.workflow.version}  ${run.status}  ${String(run.counts.completed)}/${String(run.counts.total)} completed, ${String(run.counts.running)} running, ${String(run.counts.failed)} failed, ${String(run.counts.cancelled)} cancelled, ${String(run.counts['settled-failed'])} settled-failed, ${String(run.counts.superseded)} superseded, ${String(run.counts.waiting)} waiting, ${String(run.counts.withdrawn)} withdrawn  ${cost(run)}  ${run.updatedAt}  ${owner(run)}${showProject ? `  ${run.cwd}  ${run.stateDir ?? 'unknown'}` : ''}`,
    ),
  ].join('\n');
}

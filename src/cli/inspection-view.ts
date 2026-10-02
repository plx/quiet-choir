import type { InspectionStatus, RunSummary } from '../workflow/loader/inspection.js';
import type { ExecSummary } from '../workflow/runtime/exec-model.js';
import { formatNextCommands } from './presentation.js';
import { parseDuration } from './duration.js';

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

/**
 * A watch or follow bound (`--timeout`, `--wait-created`) in milliseconds, with the duration syntax
 * and range of `tick --timeout`, or null when the value is not a positive duration of at most
 * 2147483647ms. @internal
 */
export function parseWatchBound(value: string): number | null {
  const ms = parseDuration(value);
  return Number.isSafeInteger(ms) && ms >= 1 && ms <= 2_147_483_647 ? ms : null;
}

type CostUsage = Pick<
  RunSummary['usage'],
  | 'attempts'
  | 'costUsd'
  | 'inputTokens'
  | 'outputTokens'
  | 'unknownTokenAttempts'
  | 'unknownCostAttempts'
>;

/** Totals plus an honest note: missing tokens are partial, a cost-only gap says tokens are complete. */
function cost(run: { readonly usage: CostUsage }): string {
  const u = run.usage;
  const attempts = String(u.attempts);
  const note =
    u.unknownTokenAttempts > 0
      ? ` (partial; ${String(u.unknownTokenAttempts)}/${attempts} attempts without token usage${u.unknownCostAttempts > 0 ? `; cost unreported for ${String(u.unknownCostAttempts)}/${attempts}` : ''})`
      : u.unknownCostAttempts > 0
        ? ` (tokens complete; cost unreported for ${String(u.unknownCostAttempts)}/${attempts} attempts)`
        : '';
  return `${u.costUsd === null ? 'unknown cost' : `$${u.costUsd.toFixed(4)}`}, ${u.inputTokens === null ? '?' : String(u.inputTokens)} in / ${u.outputTokens === null ? '?' : String(u.outputTokens)} out tokens${note}`;
}

const maxShellLabel = 60;
const maxSubcommandLabel = 40;

/** Short command label: program basename plus a bare subcommand, or the first shell line. */
function commandLabel(command: ExecSummary['command']): string {
  if ('shell' in command) {
    const first = command.shell.split(/\r?\n/u)[0] ?? '';
    return `[SHELL] ${first.length > maxShellLabel ? `${first.slice(0, maxShellLabel - 1)}\u2026` : first}`;
  }
  const program = /[^\\/]+(?=[\\/]*$)/u.exec(command[0])?.[0] ?? command[0];
  const next = command[1];
  return next !== undefined &&
    !next.startsWith('-') &&
    !/[\s/]/u.test(next) &&
    next.length <= maxSubcommandLabel
    ? `${program} ${next}`
    : program;
}

function agentLine(row: RunSummary['agents']['recent'][number]): string {
  return `${row.status === 'completed' ? '' : `${row.status} `}${row.id}  ${row.harness} ${row.model ?? '(native model)'} effort ${row.effort ?? '-'}${row.profile === null ? '' : ` profile ${row.profile}`}${row.elapsedMs === null ? '' : `  ${duration(row.elapsedMs)}`}  ${row.costUsd === null ? 'unknown cost' : `$${row.costUsd.toFixed(4)}`}`;
}

/** Statuses whose steps already print in full in the step list. */
const listedStatuses: readonly string[] = [
  'running',
  'failed',
  'cancelled',
  'settled-failed',
  'waiting',
];
const maxCompletedAgentLines = 20;

function owner(run: RunSummary): string {
  const value = run.ownership.owner;
  return value
    ? `pid ${String(value.pid)} (${value.state}) on ${value.host}`
    : run.ownership.locked
      ? 'unknown (incomplete lock)'
      : 'no lock';
}

function lockLine(lock: RunSummary['ownership']['locks'][number]): string {
  const holder = (value: { pid: number; host: string; state: string }): string =>
    `pid ${String(value.pid)} (${value.state}) on ${value.host}`;
  return `Lock ${lock.kind} ${lock.path}: ${lock.owner ? `owner ${holder(lock.owner)}` : 'owner unreadable'}${lock.recovery ? `; recovery ${holder(lock.recovery)}` : ''}${lock.warning ? `; warning: ${lock.warning}` : ''}`;
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
  for (const [harness, value] of Object.entries(run.harnesses)) {
    lines.push(`Harness ${harness}: ${value.binary}@${value.version ?? 'unknown'}`);
    if (value.environment)
      lines.push(
        `  Host variables: ${value.environment.variables.join(', ') || 'none'}; scrubbed: ${value.environment.scrubbed.join(', ') || 'none'}`,
      );
  }
  for (const step of run.steps) {
    const request = step.request;
    if (step.worktree) {
      const w = step.worktree;
      lines.push(
        `Worktree ${step.id}: base ${w.base}, commit ${w.commit ?? 'unchanged'}; ${w.directoryState} ${w.path}`,
      );
      for (const file of w.files) lines.push(`  ${file.status} ${JSON.stringify(file.path)}`);
    }
    if (step.merge)
      lines.push(
        `Integration ${step.id}: base ${step.merge.base}, target ${step.merge.ref}, commit ${step.merge.result?.commit ?? 'pending'}${step.merge.result?.conflicts.length ? `; ${String(step.merge.result.conflicts.length)} conflicts` : ''}`,
      );
    if (step.exec && !verbose && !step.worktree && !step.merge && step.status === 'completed') {
      lines.push(
        `${step.status} ${step.id}  ${commandLabel(step.exec.command)}${step.elapsedMs === null ? '' : `  ${duration(step.elapsedMs)}`}${step.rootCause ? ' [root cause]' : ''}`,
      );
      continue;
    }
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
          request.isolation ? `${request.isolation} configuration` : null,
          request.instructions === 'none' ? 'no native instructions' : null,
        ]
          .filter((value) => value !== null)
          .join(', ')
      : '';
    const label =
      typeof step.meta?.['integration'] === 'string'
        ? [step.meta['integration'], step.meta['op']]
            .filter((part) => typeof part === 'string')
            .join('.')
        : step.kind;
    lines.push(
      `${step.status} ${step.id}  ${request ? `${request.harness} ${request.model ?? '(native model)'}` : label}${step.elapsedMs === null ? '' : `  ${duration(step.elapsedMs)} elapsed`}${limits ? `; ${limits}` : ''}${step.rootCause ? ' [root cause]' : ''}${step.error ? `  ${step.error}` : ''}`,
    );
  }
  if (run.agents.total > 0) {
    lines.push(`Agents: ${String(run.agents.total)} steps`);
    for (const group of run.agents.byRequest)
      lines.push(
        `  ${group.harness} ${group.model ?? '(native model)'} effort ${group.effort ?? '-'} profile ${group.profile ?? '-'}: ${String(group.steps)} steps, ${group.costUsd === null ? 'unknown cost' : `$${group.costUsd.toFixed(4)}`}`,
      );
    const settled = run.agents.recent.filter((row) => !listedStatuses.includes(row.status));
    for (const row of verbose ? settled : settled.slice(-maxCompletedAgentLines))
      lines.push(agentLine(row));
  }
  if (run.interruptedBy)
    lines.push(`Interrupted at ${run.interruptedBy.at}: ${run.interruptedBy.reason} (resumable)`);
  if (run.rootCause)
    lines.push(`Root cause (${run.rootCause.stepId ?? 'workflow'}): ${run.rootCause.error}`);
  else if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(...formatNextCommands(run.next));
  lines.push(`Usage: ${cost(run)}`);
  if (run.children.length) {
    lines.push('Workflow tree (steps and usage include descendants):');
    lines.push(`  ${run.workflow.name}@${run.workflow.version}: ${run.status}`);
    for (const child of run.children)
      lines.push(
        `${'  '.repeat(Math.min(child.depth + 1, 32))}${child.label}: ${child.workflow.name}@${child.workflow.version} ${child.status}; ${String(child.steps)} steps; ${child.usage.costUsd === null ? 'unknown cost' : `$${child.usage.costUsd.toFixed(4)} reported`}; ${String(child.usage.unknownCostAttempts)} unknown cost${child.phases.length ? `; phases: ${child.phases.join(', ')}` : ''} [${child.id}]`,
      );
  }
  const usage = run.usage;
  const metric = (value: number | null): string => (value === null ? '?' : String(value));
  lines.push(
    `  Attempts: ${String(usage.attempts)}; ${String(usage.unknownUsageAttempts)} unknown usage; ${String(usage.unknownCostAttempts)} unknown cost; ${
      Object.entries(usage.outcomes)
        .filter(([, count]) => count > 0)
        .map(([outcome, count]) => `${String(count)} ${outcome}`)
        .join(', ') || 'none'
    }`,
  );
  lines.push(
    `  Token categories: ${metric(usage.tokens.uncachedInput)} uncached, ${metric(usage.tokens.cacheRead)} cache read, ${metric(usage.tokens.cacheWrite)} cache write, ${metric(usage.tokens.output)} output (${metric(usage.tokens.reasoning)} reasoning already included)`,
  );
  for (const [name, group] of Object.entries(usage.byHarness))
    lines.push(
      `  Harness ${name}: ${String(group.attempts)} attempts, ${group.costUsd === null ? 'unknown cost' : `$${group.costUsd.toFixed(4)} reported`}, ${String(group.unknownCostAttempts)} unknown cost`,
    );
  for (const [name, group] of Object.entries(usage.byIntegration))
    lines.push(
      `  Integration ${name}: ${String(group.attempts)} attempts, ${metric(group.costUsd)} reported USD`,
    );
  for (const [name, group] of Object.entries(usage.byModel))
    lines.push(
      `  Model ${name}: ${metric(group.inputTokens)} in / ${metric(group.outputTokens)} out, ${group.costUsd === null ? 'unknown cost' : `$${group.costUsd.toFixed(4)} reported`}`,
    );
  for (const warning of usage.warnings) lines.push(`  ${warning}`);
  for (const event of run.recent)
    lines.push(
      `Recent: ${event.at}${event.phase ? ` [${event.phase}]` : ''} ${event.message ?? event.type}${event.data === null ? '' : ` ${JSON.stringify(event.data)}`}`,
    );
  for (const lock of run.ownership.locks) lines.push(lockLine(lock));
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

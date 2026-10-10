import type { JsonValue } from '../runtime/model.js';
import type { RunEvent } from '../runtime/observability-model.js';
import { windowSuspensionMessage } from '../runtime/rate-limit.js';
import { stepEventError } from '../runtime/step-event-error.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../runtime/record.js';
import {
  eventMessage,
  formatEventFields,
  validToolUses,
  warningsMessage,
  type EventLineFields,
} from './event-line.js';
import { attemptErrorKind, rootCauseErrorKind, stepErrorKind } from './failure-kind.js';
import type { ErrorKind } from '../runtime/model.js';

/**
 * Where a follower starts: `end` treats the first record it reads as already printed, `all`
 * prints everything in that record, and `afterExecution` prints only what executions after `n`
 * recorded, on every read. @internal
 */
export type EventFollowStart = 'end' | 'all' | { readonly afterExecution: number };

/**
 * What a follower has already accounted for: the identity keys of every line derivable from the
 * last record it read, printed or deliberately skipped. Pruned to that record on each read, so it
 * stays proportional to the record. @internal
 */
export interface EventFollowCursor {
  readonly seen: ReadonlySet<string>;
}

interface Candidate {
  readonly key: string;
  readonly fields: EventLineFields;
  /** Body execution that produced the entry; undefined when the record cannot tell. */
  readonly execution: number | undefined;
  /** Sort position among entries with the same time: run.started first, terminal run last. */
  readonly rank: number;
}

const runTerminal = new Set<RunEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.suspended',
]);
const agentKinds = new Set<StepRecord['kind']>(['agent', 'claude', 'codex']);

/** Sort object keys recursively, as the runtime's canonical JSON does for live event data. */
function canonical(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined)
      Object.defineProperty(result, key, {
        value: canonical(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return result;
}

function time(at: string): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The execution running at `at`: the latest one that started at or before it. */
function executionAt(record: RunRecord, at: string): number | undefined {
  const moment = time(at);
  let found: number | undefined;
  for (const execution of record.executions ?? [])
    if (time(execution.startedAt) <= moment) found = execution.n;
  return found;
}

/** The message `--events` writes for a run event; omitted when the record cannot supply it. */
function runMessage(record: RunRecord, event: RunEvent): string | undefined {
  const latest = record.executions?.at(-1)?.n;
  switch (event.type) {
    case 'run.started':
      return 'Run started.';
    case 'run.completed':
      return 'Run completed.';
    case 'run.suspended':
      // Only the latest execution's interruption is recorded; an older one is unknowable.
      if (event.execution !== latest) return undefined;
      if (record.interruptedBy) return `Run interrupted; resumable: ${record.interruptedBy.reason}`;
      // The gate's stop of the latest execution, while the run is still suspended by it.
      return record.status === 'suspended' && record.budgetStop?.metric === 'maxWindowUtilization'
        ? windowSuspensionMessage(record.budgetStop, record.nextWakeAt ?? null)
        : 'Run suspended for external conditions.';
    default:
      return eventMessage(event);
  }
}

/**
 * The recorded kind a `run.failed` event's line carries, or undefined (the pair is omitted) when
 * the event names no root effect or the record cannot supply it. The latest execution reads the
 * run's root cause, as the live event did. An earlier execution's root cause may have been
 * overwritten or cleared by a later resume, so it takes the kind of the root step's last failed
 * attempt recorded in that execution, which is the classification the live line carried.
 */
function runFailedKind(record: RunRecord, event: RunEvent): ErrorKind | null | undefined {
  const stepId = event.stepId;
  if (event.type !== 'run.failed' || stepId === null) return undefined;
  const latest = record.executions?.at(-1)?.n;
  if (event.execution === latest && record.rootCause?.stepId === stepId)
    return rootCauseErrorKind(record);
  const attempt = record.steps[stepId]?.attemptHistory
    ?.filter((entry) => entry.status === 'failed' && entry.execution === event.execution)
    .at(-1);
  return attempt === undefined ? undefined : attemptErrorKind(attempt);
}

function runEventCandidates(record: RunRecord): Candidate[] {
  const occurrences = new Map<string, number>();
  const executions = new Map((record.executions ?? []).map((entry) => [entry.n, entry]));
  const latest = record.executions?.at(-1)?.n;
  return (record.events ?? []).map((event) => {
    const base = JSON.stringify([
      event.execution,
      event.at,
      event.type,
      event.message,
      event.data,
      event.phase,
      event.frame ?? null,
      event.stepId,
    ]);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const terminal = runTerminal.has(event.type);
    const execution = executions.get(event.execution);
    const ms =
      terminal && execution?.endedAt
        ? Math.max(0, time(execution.endedAt) - time(execution.startedAt))
        : undefined;
    return {
      key: `run\u0000${base}\u0000${String(occurrence)}`,
      execution: event.execution,
      rank: event.type === 'run.started' ? 0 : terminal ? (event.execution === latest ? 3 : 2) : 1,
      fields: {
        t: event.at,
        run: record.id,
        ev: event.type,
        step: event.stepId,
        errorKind: runFailedKind(record, event),
        ms,
        phase: event.phase,
        msg: runMessage(record, event),
      },
    };
  });
}

const cleanupWarning = 'Could not remove successful transcript';

/**
 * Whether a completed attempt's transcript cleanup is still pending. With `transcripts:
 * 'on-failure'` the runner saves the completion, then discards the transcript and saves again,
 * adding a warning when the discard fails; it emits `step.completed` only after that second save.
 * Until it lands (the receipt still retained and no cleanup warning) while the attempt's execution
 * is the running one, the line's warnings are not final, so the follower holds it back. A stale
 * run's owner is gone and the cleanup will never land, so nothing is pending then.
 */
function cleanupPending(
  record: RunRecord,
  step: StepRecord,
  attempt: AttemptRecord,
  stale: boolean,
): boolean {
  if (stale || record.status !== 'running' || attempt.transcript?.retained !== true) return false;
  if (attempt.policy.transcripts !== 'on-failure') return false;
  // A later execution (a resume after a crash between the saves) never finishes this cleanup.
  const latest = record.executions?.at(-1);
  if (latest === undefined || latest.n !== attempt.execution || latest.endedAt !== null)
    return false;
  return !(step.warnings ?? []).some((warning) => warning.startsWith(cleanupWarning));
}

function stepCandidates(
  record: RunRecord,
  id: string,
  step: StepRecord,
  stale: boolean,
): Candidate[] {
  // A fork copies reused records; `--events` drops them as step.reused, so the follower does too.
  if (step.reusedFrom) return [];
  const harness = agentKinds.has(step.kind) ? (step.harness ?? step.kind) : undefined;
  const common = { run: record.id, step: id, harness, phase: step.phase };
  const result: Candidate[] = [];
  const history: readonly AttemptRecord[] = step.attemptHistory ?? [];
  const toolUsesOf = (attempt: AttemptRecord): { toolUses?: number } => {
    // Only agent attempts report a count; live, only agent.finished supplies one. The attempt's own
    // request says it was an agent call, so a step later redefined as another kind keeps its count.
    const value =
      attempt.request?.harness === undefined ? undefined : attempt.diagnostics?.['toolUses'];
    return validToolUses(value) ? { toolUses: value } : {};
  };
  history.forEach((attempt, index) => {
    if (attempt.finishedAt === null) return;
    const latest = index === history.length - 1;
    if (attempt.status === 'completed') {
      // Produced on a later read, under the same key, once its cleanup warning is final.
      if (latest && step.status === 'completed' && cleanupPending(record, step, attempt, stale))
        return;
      result.push({
        key: `attempt\u0000${id}\u0000${String(attempt.attempt)}\u0000completed`,
        execution: attempt.execution,
        rank: 1,
        fields: {
          ...common,
          t: attempt.finishedAt,
          ev: 'step.completed',
          ms: attempt.durationMs ?? undefined,
          costUsd: attempt.usage?.costUsd,
          ...toolUsesOf(attempt),
          // step.warnings is reset per attempt, so it belongs only to the step's latest attempt.
          // Only agent steps carry them live (on agent.finished), so only they do here.
          msg:
            harness !== undefined && latest && step.status === 'completed'
              ? warningsMessage(step.warnings)
              : undefined,
        },
      });
    } else if (attempt.status === 'failed') {
      // The runner writes only step.settled for the final attempt of a settled failure.
      const settled = step.status === 'settled-failed' && latest;
      result.push({
        key: `attempt\u0000${id}\u0000${String(attempt.attempt)}\u0000${settled ? 'settled' : 'failed'}`,
        execution: attempt.execution,
        rank: 1,
        fields: {
          ...common,
          t: attempt.finishedAt,
          ev: settled ? 'step.settled' : 'step.failed',
          attempt: attempt.attempt,
          // The kind this attempt recorded, which can differ from the step's last one.
          errorKind: settled ? undefined : attemptErrorKind(attempt),
          ms: attempt.durationMs ?? undefined,
          ...toolUsesOf(attempt),
          msg: stepEventError(attempt.error),
        },
      });
    }
    // Cancelled and interrupted attempts write nothing, as --events drops step.cancelled.
  });
  // Waits, questions and older records settle without attempt history.
  const finishedAt = step.finishedAt;
  if (!history.length && finishedAt) {
    const ev =
      step.status === 'completed'
        ? 'step.completed'
        : step.status === 'settled-failed'
          ? 'step.settled'
          : step.status === 'failed'
            ? 'step.failed'
            : undefined;
    if (ev)
      result.push({
        key: `step\u0000${id}\u0000${ev}\u0000${finishedAt}`,
        execution: executionAt(record, finishedAt),
        rank: 1,
        fields: {
          ...common,
          t: finishedAt,
          ev,
          attempt: step.attempts,
          errorKind: ev === 'step.failed' ? stepErrorKind(step) : undefined,
          ms: step.durationMs ?? undefined,
          msg: ev === 'step.completed' ? undefined : stepEventError(step.error),
        },
      });
  }
  const notifiedAt = step.wait?.notifiedAt;
  if (step.question && typeof notifiedAt === 'number' && Number.isFinite(notifiedAt)) {
    const t = new Date(notifiedAt).toISOString();
    result.push({
      key: `wait\u0000${id}\u0000${String(notifiedAt)}`,
      execution: executionAt(record, t),
      rank: 1,
      fields: {
        ...common,
        harness: undefined,
        t,
        ev: 'wait.opened',
        msg: eventMessage({
          type: 'wait.opened',
          data: { question: canonical(step.question.request as unknown as JsonValue) },
        }),
      },
    });
  }
  return result;
}

/**
 * Derive `--events` lines from a persisted run record, for a follower that never imports the
 * workflow. Sources: every `record.events` entry (run lifecycle, phase, log, and `wait.tolerated`
 * for each tolerated poll error); every settled step
 * attempt (`step.completed`, `step.failed`, and `step.settled` for the final attempt of a settled
 * failure, the last two with the attempt's recorded error as `msg`, and `step.failed` with that
 * attempt's recorded `errorKind`, null when it has none); a `run.failed` entry that names a root
 * effect carries the root cause's kind in the latest execution, or the kind of that step's last
 * failed attempt in an earlier execution, and no kind when the record has neither; and every
 * question that notified (`wait.opened`). Completed and failed attempts also carry the attempt's
 * recorded `diagnostics.toolUses` when its own recorded request names a harness, whatever kind the
 * step has now, and a `step.completed` line carries the step's warnings as its
 * `msg` only for the step's latest attempt, because the record keeps warnings per step, not per
 * attempt. That latest `step.completed` line is held back while its `transcripts: 'on-failure'`
 * cleanup is pending in the running execution (the receipt still retained and no cleanup warning
 * yet), and produced on the read after the cleanup save, as the runner emits it only then, so a
 * cleanup warning is never lost; it is also released once `options.stale` says the run's owner is
 * gone, as the cleanup can then never land. Fork-reused steps and cancelled or
 * interrupted attempts write nothing, and fields the record cannot supply are omitted. Lines are
 * deduplicated by identity, not position, so eviction past the 500-event cap neither repeats nor
 * hides newer lines. Each call returns the lines not yet accounted for in `cursor` (null on the
 * first read), sorted by time with the latest execution's terminal run line last, and the cursor
 * for the next call. @internal
 */
export function recordEventLines(
  record: RunRecord,
  cursor: EventFollowCursor | null,
  start: EventFollowStart,
  options: { readonly stale?: boolean } = {},
): { readonly lines: readonly string[]; readonly cursor: EventFollowCursor } {
  const candidates = [
    ...runEventCandidates(record),
    ...Object.entries(record.steps).flatMap(([id, step]) =>
      stepCandidates(record, id, step, options.stale === true),
    ),
  ];
  const after = typeof start === 'object' ? start.afterExecution : undefined;
  const print =
    cursor === null && start === 'end'
      ? []
      : candidates
          .map((candidate, order) => ({ candidate, order }))
          .filter(
            ({ candidate }) =>
              !cursor?.seen.has(candidate.key) &&
              (after === undefined ||
                (candidate.execution !== undefined && candidate.execution > after)),
          )
          .sort(
            (a, b) =>
              Number(a.candidate.rank === 3) - Number(b.candidate.rank === 3) ||
              time(a.candidate.fields.t) - time(b.candidate.fields.t) ||
              a.candidate.rank - b.candidate.rank ||
              a.order - b.order,
          );
  return {
    lines: print.map(({ candidate }) => formatEventFields(candidate.fields)),
    cursor: { seen: new Set(candidates.map((candidate) => candidate.key)) },
  };
}

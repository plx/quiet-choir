import type { JsonValue } from '../runtime/model.js';

/** Hard cap on the UTF-8 byte length of one event line, without its newline. @internal */
export const EVENT_LINE_MAX_BYTES = 512;

/** Encoded byte budget of `msg` before the hard cap applies, so a typical line stays near 300. @internal */
export const EVENT_MESSAGE_BUDGET_BYTES = 200;

/** The event types `--events` writes; every other `WorkflowEvent` type is dropped. @internal */
export const eventLineTypes = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.suspended',
  'step.completed',
  'step.failed',
  'step.settled',
  'wait.opened',
  'wait.tolerated',
  'phase',
  'log',
] as const;

/** One written event type. @internal */
export type EventLineType = (typeof eventLineTypes)[number];

const lineTypes: ReadonlySet<string> = new Set(eventLineTypes);

/** Whether an event type is one the stream writes. @internal */
export function isEventLineType(type: string): type is EventLineType {
  return lineTypes.has(type);
}

/**
 * One line of the `--events` stream and of `workflow events`, in this key order. Absent fields are
 * omitted, never null.
 * @internal
 */
export interface EventLine {
  /** ISO time of the event (`WorkflowEvent.at`, or the recorded time a follower derives it from). */
  readonly t: string;
  /** Run ID. */
  readonly run: string;
  /** Event type. */
  readonly ev: EventLineType;
  /** Full durable step ID; `run.failed` can name its root effect. */
  readonly step?: string;
  /** Persisted attempt count, on `step.failed` and `step.settled` only. */
  readonly attempt?: number;
  /** The event's harness, or the one last seen on an `agent.*` event for this step. */
  readonly harness?: string;
  /**
   * Duration in milliseconds. `--events` measures it in its own process since the step's or the
   * execution's start; a record follower uses the recorded attempt or execution duration.
   */
  readonly ms?: number;
  /** Reported cost of a completed agent step. */
  readonly costUsd?: number;
  /** Phase at the call site. */
  readonly phase?: string;
  /**
   * Truncated message: the run error, phase title, log text plus data, the open question, or the
   * tolerated poll error with its count.
   */
  readonly msg?: string;
}

/**
 * The raw values of one line before normalization and bounding. Both the live `--events` sink and
 * the record follower map their sources onto these fields and format them with
 * {@link formatEventFields}, so the two streams share one shape and one truncation rule. Empty,
 * null and non-finite values are omitted. @internal
 */
export interface EventLineFields {
  readonly t: string;
  readonly run: string;
  readonly ev: EventLineType;
  readonly step?: string | null | undefined;
  /** Kept only on `step.failed` and `step.settled`. */
  readonly attempt?: number | undefined;
  readonly harness?: string | undefined;
  readonly ms?: number | undefined;
  readonly costUsd?: number | null | undefined;
  readonly phase?: string | null | undefined;
  /** The untruncated message; see {@link eventMessage}. */
  readonly msg?: string | undefined;
}

const ellipsis = '…';

function encodedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** Cut at a code point so the JSON-encoded text plus a trailing ellipsis fits `max` bytes. */
function truncateEnd(text: string, max: number): string {
  if (encodedBytes(text) <= max) return text;
  const budget = max - encodedBytes(ellipsis);
  if (budget < 0) return '';
  let used = 0;
  let kept = '';
  for (const point of text) {
    const size = encodedBytes(point);
    if (used + size > budget) break;
    used += size;
    kept += point;
  }
  return kept + ellipsis;
}

/** Keep both ends of an identifier, joined by an ellipsis, within `max` encoded bytes. */
function truncateMiddle(text: string, max: number): string {
  if (encodedBytes(text) <= max) return text;
  const budget = max - encodedBytes(ellipsis);
  if (budget < 0) return '';
  const points = Array.from(text);
  const headBudget = Math.ceil(budget / 2);
  let head = 0;
  let used = 0;
  while (head < points.length) {
    const size = encodedBytes(points[head] ?? '');
    if (used + size > headBudget) break;
    used += size;
    head++;
  }
  let tail = points.length;
  while (tail > head) {
    const size = encodedBytes(points[tail - 1] ?? '');
    if (used + size > budget) break;
    used += size;
    tail--;
  }
  return `${points.slice(0, head).join('')}${ellipsis}${points.slice(tail).join('')}`;
}

/** Shrink `msg`, then `step` and `phase`, then `run`, until the line fits the hard cap. */
function fit(line: Record<string, unknown>): string {
  let text = JSON.stringify(line);
  for (const [key, cut] of [
    ['msg', truncateEnd],
    ['step', truncateMiddle],
    ['phase', truncateMiddle],
    ['run', truncateMiddle],
  ] as const) {
    const excess = Buffer.byteLength(text) - EVENT_LINE_MAX_BYTES;
    if (excess <= 0) return text;
    const value = line[key];
    if (typeof value !== 'string' || !value) continue;
    // Each cut removes at least `excess` encoded bytes; an undefined value drops the key.
    line[key] = cut(value, Math.max(0, encodedBytes(value) - excess)) || undefined;
    text = JSON.stringify(line);
  }
  return text;
}

/**
 * The untruncated `msg` of an event: the compact JSON of `question` in a `wait.opened` payload,
 * the message plus the compact JSON of non-null data for `log`, `tolerated N/LIMIT: message` (with
 * ` [code]` after LIMIT when the error had a code) for `wait.tolerated`, and the message otherwise.
 * A `wait.tolerated` entry whose data lacks the counts falls back to its message.
 * @internal
 */
export function eventMessage(event: {
  readonly type: string;
  readonly message?: string | null | undefined;
  readonly data?: JsonValue | undefined;
}): string | undefined {
  if (event.type === 'wait.opened') {
    const data = event.data;
    const question =
      data !== null && typeof data === 'object' && !Array.isArray(data) ? data['question'] : null;
    return question === null || question === undefined ? undefined : JSON.stringify(question);
  }
  const text = event.message ?? '';
  if (event.type === 'wait.tolerated') {
    const data = event.data;
    if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data))
      return text;
    const { consecutive, tolerate, code } = data;
    if (typeof consecutive !== 'number' || typeof tolerate !== 'number') return text;
    const suffix = typeof code === 'string' && code ? ` [${code}]` : '';
    return `tolerated ${String(consecutive)}/${String(tolerate)}${suffix}: ${text}`;
  }
  if (event.type === 'log' && event.data !== undefined && event.data !== null)
    return `${text} ${JSON.stringify(event.data)}`;
  return text;
}

/**
 * Build one compact JSON line (without its newline) from raw fields: the ordered object
 * `{t, run, ev, step, attempt, harness, ms, costUsd, phase, msg}` with absent values omitted,
 * `msg` cut to {@link EVENT_MESSAGE_BUDGET_BYTES}, and the whole line fitted to
 * {@link EVENT_LINE_MAX_BYTES} UTF-8 bytes. This is the only formatter of event lines. @internal
 */
export function formatEventFields(fields: EventLineFields): string {
  const { step, attempt, harness, ms, costUsd, msg } = fields;
  const phase = typeof fields.phase === 'string' && fields.phase ? fields.phase : undefined;
  const line: Record<string, unknown> = {
    t: fields.t,
    run: fields.run,
    ev: fields.ev,
    ...(step === null || step === undefined || step === '' ? {} : { step }),
    ...((fields.ev === 'step.failed' || fields.ev === 'step.settled') && attempt !== undefined
      ? { attempt }
      : {}),
    ...(harness === undefined ? {} : { harness }),
    ...(ms === undefined || !Number.isFinite(ms) ? {} : { ms }),
    ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(phase === undefined ? {} : { phase }),
    ...(msg ? { msg: truncateEnd(msg, EVENT_MESSAGE_BUDGET_BYTES) } : {}),
  };
  return fit(line);
}

import { closeSync, openSync, writeSync } from 'node:fs';
import type { ExecutionLogger } from '../../application/execution.js';
import type { WorkflowEvent } from '../runtime/runner.js';
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
  'phase',
  'log',
] as const;

/** One written event type. @internal */
export type EventLineType = (typeof eventLineTypes)[number];

/**
 * One line of the `--events` stream, in this key order. Absent fields are omitted, never null.
 * @internal
 */
export interface EventLine {
  /** ISO time of the event (`WorkflowEvent.at`). */
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
  /** Milliseconds since the step's or the execution's start seen by this process. */
  readonly ms?: number;
  /** Reported cost of a completed agent step. */
  readonly costUsd?: number;
  /** Phase at the call site. */
  readonly phase?: string;
  /** Truncated message: the run error, phase title, log text plus data, or the open question. */
  readonly msg?: string;
}

const written = new Set<string>(eventLineTypes);
const stepTerminal = new Set(['step.completed', 'step.failed', 'step.settled', 'step.cancelled']);
const runTerminal = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.suspended']);
const ellipsis = '…';

interface StepMemory {
  startedAt?: number;
  harness?: string;
}

/**
 * Per-process tracking for the derived `harness` and `ms` fields. Entries are deleted on terminal
 * step and run events, so a long run keeps only its in-flight steps. @internal
 */
export class EventLineMemory {
  readonly #runs = new Map<string, { startedAt?: number; steps: Map<string, StepMemory> }>();

  #run(runId: string): { startedAt?: number; steps: Map<string, StepMemory> } {
    let run = this.#runs.get(runId);
    if (!run) {
      run = { steps: new Map() };
      this.#runs.set(runId, run);
    }
    return run;
  }

  #step(runId: string, stepId: string): StepMemory {
    const steps = this.#run(runId).steps;
    let step = steps.get(stepId);
    if (!step) {
      step = {};
      steps.set(stepId, step);
    }
    return step;
  }

  /** Record what later lines derive from, and return the derived fields for this event. */
  public observe(event: WorkflowEvent): { harness?: string; ms?: number } {
    const at = Date.parse(event.at);
    const runId = event.runId;
    if (event.type === 'run.started') {
      const run = this.#run(runId);
      if (Number.isFinite(at)) run.startedAt = at;
      else delete run.startedAt;
      return {};
    }
    if (runTerminal.has(event.type)) {
      const startedAt = this.#runs.get(runId)?.startedAt;
      this.#runs.delete(runId);
      return startedAt === undefined || !Number.isFinite(at)
        ? {}
        : { ms: Math.max(0, at - startedAt) };
    }
    const stepId = event.stepId;
    if (stepId === null) return {};
    if (event.type === 'step.started') {
      const step = this.#step(runId, stepId);
      if (Number.isFinite(at)) step.startedAt = at;
      else delete step.startedAt;
    }
    if (event.harness !== undefined && event.type.startsWith('agent.'))
      this.#step(runId, stepId).harness = event.harness;
    const known = this.#runs.get(runId)?.steps.get(stepId);
    const harness = event.harness ?? known?.harness;
    const startedAt = known?.startedAt;
    if (stepTerminal.has(event.type) || event.type === 'step.replayed') {
      const steps = this.#runs.get(runId)?.steps;
      steps?.delete(stepId);
      if (steps?.size === 0 && this.#runs.get(runId)?.startedAt === undefined)
        this.#runs.delete(runId);
    }
    return {
      ...(harness === undefined ? {} : { harness }),
      ...(stepTerminal.has(event.type) && startedAt !== undefined && Number.isFinite(at)
        ? { ms: Math.max(0, at - startedAt) }
        : {}),
    };
  }

  /** Tracked runs and steps, for tests of the bound. */
  public get size(): { readonly runs: number; readonly steps: number } {
    let steps = 0;
    for (const run of this.#runs.values()) steps += run.steps.size;
    return { runs: this.#runs.size, steps };
  }
}

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

function compact(value: JsonValue): string {
  return JSON.stringify(value);
}

function message(event: WorkflowEvent): string | undefined {
  if (event.type === 'wait.opened') {
    const data = event.data;
    const question =
      data !== null && typeof data === 'object' && !Array.isArray(data) ? data['question'] : null;
    return question === null || question === undefined ? undefined : compact(question);
  }
  const text = event.message ?? '';
  if (event.type === 'log' && event.data !== undefined && event.data !== null)
    return `${text} ${compact(event.data)}`;
  return text;
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
 * Format one `WorkflowEvent` as a compact JSON line (without its newline), or return null for an
 * event the stream does not carry: any type outside {@link eventLineTypes}, and every replay echo
 * (`replayed: true`, `step.replayed`, `step.reused`), because an earlier execution already wrote
 * that transition. `memory` must see every event, written or not, to derive `harness` and `ms`.
 * The line is at most {@link EVENT_LINE_MAX_BYTES} UTF-8 bytes. @internal
 */
export function formatEventLine(event: WorkflowEvent, memory: EventLineMemory): string | null {
  const derived = memory.observe(event);
  if (event.replayed === true || !written.has(event.type)) return null;
  const costUsd = event.usage?.costUsd;
  const phase = typeof event.phase === 'string' && event.phase ? event.phase : undefined;
  const msg = message(event);
  const line: Record<string, unknown> = {
    t: event.at,
    run: event.runId,
    ev: event.type,
    ...(event.stepId === null || event.stepId === '' ? {} : { step: event.stepId }),
    ...(event.type === 'step.failed' || event.type === 'step.settled'
      ? { attempt: event.attempt }
      : {}),
    ...(derived.harness === undefined ? {} : { harness: derived.harness }),
    ...(derived.ms === undefined ? {} : { ms: derived.ms }),
    ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(phase === undefined ? {} : { phase }),
    ...(msg ? { msg: truncateEnd(msg, EVENT_MESSAGE_BUDGET_BYTES) } : {}),
  };
  return fit(line);
}

/**
 * Where event lines go: a file path (opened for append, created owner-only), or a writer such as
 * the CLI's reserved stdout. A writer reports asynchronous failures through `onError`. @internal
 */
export type EventLogTarget =
  | { readonly path: string }
  | { readonly write: (line: string, onError: (error: unknown) => void) => void };

/**
 * Best-effort `--events` sink: one flushed write per line, no fsync. An open or write failure logs
 * one warning and disables the sink; it never changes the run outcome. @internal
 */
export class WorkflowEventLog {
  readonly #memory = new EventLineMemory();
  #fd: number | undefined;
  #disabled = false;

  public constructor(
    private readonly options: {
      readonly target: EventLogTarget;
      readonly logger: ExecutionLogger;
    },
  ) {}

  /** Open a file target for append (mode 0600 when created); a writer target needs no opening. */
  public open(): void {
    const target = this.options.target;
    if (this.#disabled || !('path' in target) || this.#fd !== undefined) return;
    try {
      this.#fd = openSync(target.path, 'a', 0o600);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Write the event's line, if it has one. Never throws. */
  public observe(event: WorkflowEvent): void {
    if (this.#disabled) return;
    try {
      const line = formatEventLine(event, this.#memory);
      if (line === null) return;
      const target = this.options.target;
      if ('write' in target) {
        target.write(`${line}\n`, (error) => {
          this.#fail(error);
        });
        return;
      }
      if (this.#fd === undefined) return;
      const bytes = Buffer.from(`${line}\n`);
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(this.#fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Close the file. Idempotent; a close failure is ignored because every line was already written. */
  public close(): void {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      /* The lines were already written with writeSync. */
    }
  }

  #fail(error: unknown): void {
    if (this.#disabled) return;
    this.#disabled = true;
    this.close();
    try {
      this.options.logger.log(
        'warn',
        `Events: ${error instanceof Error ? error.message : String(error)}; further events are not written.`,
      );
    } catch {
      /* Event diagnostics must not affect the workflow outcome. */
    }
  }
}

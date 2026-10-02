import { closeSync, openSync, writeSync } from 'node:fs';
import type { ExecutionLogger } from '../../application/execution.js';
import type { WorkflowEvent } from '../runtime/runner.js';
import { eventMessage, formatEventFields, isEventLineType } from './event-line.js';

export {
  EVENT_LINE_MAX_BYTES,
  EVENT_MESSAGE_BUDGET_BYTES,
  eventLineTypes,
  type EventLine,
  type EventLineType,
} from './event-line.js';

const stepTerminal = new Set(['step.completed', 'step.failed', 'step.settled', 'step.cancelled']);
const runTerminal = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.suspended']);

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

/**
 * Format one `WorkflowEvent` as a compact JSON line (without its newline), or return null for an
 * event the stream does not carry: any type outside `eventLineTypes`, and every replay echo
 * (`replayed: true`, `step.replayed`, `step.reused`), because an earlier execution already wrote
 * that transition. `memory` must see every event, written or not, to derive `harness` and `ms`.
 * The line is at most `EVENT_LINE_MAX_BYTES` UTF-8 bytes. @internal
 */
export function formatEventLine(event: WorkflowEvent, memory: EventLineMemory): string | null {
  const derived = memory.observe(event);
  const type = event.type;
  if (event.replayed === true || !isEventLineType(type)) return null;
  return formatEventFields({
    t: event.at,
    run: event.runId,
    ev: type,
    step: event.stepId,
    attempt: event.attempt,
    harness: derived.harness,
    ms: derived.ms,
    costUsd: event.usage?.costUsd,
    phase: event.phase,
    msg: eventMessage(event),
  });
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

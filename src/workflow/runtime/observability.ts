import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { digest, jsonValue } from './json.js';
import { environmentSummary } from './agent-environment.js';
import { resolveIsolation } from './agent-isolation.js';
import type { JsonValue, HarnessRequestInput } from './model.js';
import type { AttemptPolicy } from './policy.js';
import type { RunRecord } from './store.js';
import type {
  ExecutionRecord,
  PhaseInfo,
  PhaseOptions,
  RequestSummary,
  RunEvent,
} from './observability-model.js';

/** Payload retention before the event-journal work; compact signature counts survive eviction. @internal */
export const MAX_RUN_EVENTS = 500;

/** Capture a stack/cause chain without retaining live Error objects. @internal */
export function errorStack(error: unknown): string | null {
  const seen = new Set<unknown>();
  const stacks: string[] = [];
  while (error instanceof Error && !seen.has(error) && seen.size < 32) {
    seen.add(error);
    if (error.stack) stacks.push(error.stack);
    error = error.cause;
  }
  return stacks.length ? stacks.join('\nCaused by: ').slice(0, 65_536) : null;
}

/** Summarize the request after profile, policy, and harness defaults are resolved. @internal */
export function requestSummary(
  request: HarnessRequestInput,
  execution: AttemptPolicy,
): RequestSummary {
  const options = request.options;
  return {
    isolation: resolveIsolation(options).isolation,
    environment: environmentSummary(options.env),
    provider: request.provider,
    model: execution.requestedModel,
    profile: execution.profile ?? null,
    limits: {
      timeoutMs: execution.policy.timeoutMs ?? null,
      maxTurns: request.provider === 'claude' ? (execution.policy.maxTurns ?? null) : null,
      maxBudgetUsd: request.provider === 'claude' ? (execution.policy.maxBudgetUsd ?? null) : null,
      sandbox: request.provider === 'codex' ? (request.options.sandbox ?? null) : null,
      killGraceMs: execution.policy.killGraceMs ?? null,
    },
    tools:
      request.provider === 'claude' && request.options.tools ? [...request.options.tools] : null,
    cwd: request.cwd,
    structured: request.outputSchema !== null,
    promptSha256: createHash('sha256').update(options.prompt).digest('hex'),
    promptPreview: options.prompt.slice(0, 200),
  };
}

interface PhaseFrame {
  phase: PhaseInfo | null;
}

/** Own asynchronous saves for synchronous observational APIs without making them durable effects. @internal */
export class RunObservations {
  public readonly execution: ExecutionRecord;
  readonly #record: RunRecord;
  readonly #save: () => Promise<void>;
  readonly #notify: (event: RunEvent, replayed: boolean) => void;
  readonly #storage = new AsyncLocalStorage<PhaseFrame>();
  readonly #root: PhaseFrame = { phase: null };
  readonly #active = new Set<PhaseFrame>();
  readonly #prior: Record<string, number>;
  readonly #counts: Record<string, number> = {};
  readonly #pending = new Set<Promise<void>>();
  #scheduled: { readonly callbacks: (() => void)[] } | undefined;
  #error: Error | undefined;

  public constructor(
    record: RunRecord,
    save: () => Promise<void>,
    notify: (event: RunEvent, replayed: boolean) => void,
  ) {
    this.#record = record;
    this.#save = save;
    this.#notify = notify;
    this.#prior = { ...record.eventCounts };
    this.execution = {
      n: (record.executions?.at(-1)?.n ?? 0) + 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'running',
      error: null,
      errorStack: null,
    };
    (record.executions ??= []).push(this.execution);
    record.events ??= [];
    record.eventCounts ??= {};
    record.phase = null;
    record.errorStack = null;
  }

  public get phase(): PhaseInfo | null {
    return (this.#storage.getStore() ?? this.#root).phase;
  }

  public run<T>(body: () => T): T {
    return this.#storage.run(this.#root, body);
  }

  public lifecycle(
    type: Extract<RunEvent['type'], `run.${string}`>,
    error: unknown = null,
  ): RunEvent {
    if (type !== 'run.started') {
      this.execution.endedAt = new Date().toISOString();
      this.execution.outcome =
        type === 'run.completed'
          ? 'completed'
          : type === 'run.cancelled'
            ? 'cancelled'
            : type === 'run.suspended'
              ? 'suspended'
              : 'failed';
      this.execution.error =
        type === 'run.completed' || type === 'run.suspended'
          ? null
          : error instanceof Error
            ? error.message
            : String(error);
      this.execution.errorStack = errorStack(error);
      this.#record.errorStack = this.execution.errorStack;
    }
    const event: RunEvent = {
      at: new Date().toISOString(),
      execution: this.execution.n,
      type,
      phase: this.phase?.title ?? null,
      total: this.phase?.total ?? null,
      message: this.execution.error,
      data: null,
      stepId: type === 'run.failed' ? (this.#record.rootCause?.stepId ?? null) : null,
    };
    this.#append(event);
    return event;
  }

  public setPhase(title: string, options?: PhaseOptions): void {
    const phase = this.checkPhase(title, options);
    (this.#storage.getStore() ?? this.#root).phase = phase;
    this.#updatePhase();
    this.#event('phase', title, null);
  }

  /** Validates a phase before any body launches, so only authoring errors are reported. */
  public checkPhase(title: string, options?: PhaseOptions): PhaseInfo {
    if (typeof title !== 'string' || !title.trim())
      throw new Error('Phase title must be nonempty.');
    const total = options?.total ?? null;
    if (total !== null && (!Number.isSafeInteger(total) || total < 0))
      throw new Error('Phase total must be a nonnegative safe integer.');
    return { title, total };
  }

  public async scoped<T>(phase: PhaseInfo, body: () => Promise<T>): Promise<T> {
    const frame: PhaseFrame = { phase };
    this.#active.add(frame);
    this.#updatePhase();
    try {
      return await this.#storage.run(frame, () => {
        this.#event('phase', phase.title, null);
        return body();
      });
    } finally {
      this.#active.delete(frame);
      this.#updatePhase();
      this.#schedule();
    }
  }

  public log(message: string, data: JsonValue | undefined): void {
    if (typeof message !== 'string') throw new Error('Log message must be a string.');
    this.#event('log', message, data === undefined ? null : jsonValue(data));
  }

  public async flush(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
    if (this.#error !== undefined) throw this.#error;
  }

  #updatePhase(): void {
    this.#record.phase = [...this.#active].at(-1)?.phase ?? this.#root.phase;
  }

  #event(type: 'phase' | 'log', message: string, data: JsonValue): void {
    const phase = this.phase;
    const key = digest({ type, message, data, phase });
    const n = (this.#counts[key] ?? 0) + 1;
    this.#counts[key] = n;
    const replayed = n <= (this.#prior[key] ?? 0);
    const event: RunEvent = {
      at: new Date().toISOString(),
      execution: this.execution.n,
      type,
      phase: phase?.title ?? null,
      total: phase?.total ?? null,
      message,
      data,
      stepId: null,
    };
    if (!replayed) {
      (this.#record.eventCounts ??= {})[key] = n;
      this.#append(event);
    }
    this.#schedule(() => {
      this.#notify(event, replayed);
    });
  }

  #append(event: RunEvent): void {
    const events = (this.#record.events ??= []);
    events.push(event);
    if (events.length > MAX_RUN_EVENTS) events.splice(0, events.length - MAX_RUN_EVENTS);
  }

  #schedule(after?: () => void): void {
    if (this.#scheduled) {
      if (after) this.#scheduled.callbacks.push(after);
      return;
    }
    const batch = { callbacks: after ? [after] : [] };
    this.#scheduled = batch;
    // Synchronous bursts share one snapshot; every notification still follows a committed save.
    const pending = Promise.resolve()
      .then(() => {
        this.#scheduled = undefined;
        return this.#save();
      })
      .then(
        () => {
          for (const callback of batch.callbacks) {
            try {
              callback();
            } catch {
              /* Observers cannot invalidate persisted observations. */
            }
          }
        },
        (error: unknown) => {
          this.#error ??=
            error instanceof Error ? error : new Error(String(error), { cause: error });
        },
      );
    this.#pending.add(pending);
    void pending.then(() => {
      this.#pending.delete(pending);
    });
  }
}

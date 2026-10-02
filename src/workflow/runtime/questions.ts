import { randomUUID } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { RunActivity } from './activity.js';
import { CancelledError } from './fan-out.js';
import { answerCandidates } from './inbox.js';
import { digest, jsonValue } from './json.js';
import { stepIdentity } from './identity.js';
import { answerEnvelopeSchema, validateAnswerAuthor } from './question-schema.js';
import type { AskOptions } from './question-model.js';
import type { JsonValue } from './model.js';
import type { RunRecord, StepRecord } from './store.js';
import { clockNow, MAX_EPOCH_MS, SHORT_WAIT_MS, systemClock } from './clock.js';
import { waitNote, waitRequest } from './wait-schema.js';
import {
  commandPollIdentity,
  defaultObserveTimeoutMs,
  isCommandPoll,
  observePoll,
  type AnyPollSource,
  type PollObservation,
} from './poll-command.js';
import type { PollContext, WaitRecord, WaitSources, WorkflowClock } from './wait-model.js';

type Outcome =
  | { by: 'signal'; value: JsonValue; at: number; actor: string | null }
  | { by: 'poll'; value: JsonValue; at: number; checks: number }
  | { by: 'deadline'; at: number; note: JsonValue };
const outcomeSchema: z.ZodType<Outcome> = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('signal'),
    value: z.json(),
    at: z.number().int().nonnegative(),
    actor: z.string().nullable(),
  }),
  z.object({
    by: z.literal('poll'),
    value: z.json(),
    at: z.number().int().nonnegative(),
    checks: z.number().int().nonnegative(),
  }),
  z.object({ by: z.literal('deadline'), at: z.number().int().nonnegative(), note: z.json() }),
]);
/**
 * Real-time grace for an observation to settle after its signal aborts, mirroring the runner's
 * transcriptSettleMs. It bounds process-local settling, so it never uses the workflow clock: a
 * manual fake clock would otherwise hang close().
 */
const observerSettleMs = 2000;
/** Extra real time close() allows beyond the observer grace before it abandons a stalled scan. */
const closeMarginMs = 250;
/** Why an in-flight observation's signal was aborted. */
type Interruption = 'deadline' | 'observeTimeoutMs' | 'run cancelled' | 'run closing';
interface Inflight {
  readonly interrupt: (reason: Interruption) => void;
}
type Observed =
  | { readonly kind: 'settled'; readonly observation: Promise<unknown> }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'observeTimeoutMs' };

/** Freeze a cloned JSON value in place so an observer cannot mutate what it was handed. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Wait real time for a promise to settle; true when it settled within the bound. */
async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, milliseconds, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Waiter {
  readonly sources: WaitSources;
  readonly signal: AbortSignal;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: unknown) => void;
  readonly dispose: () => void;
}
interface QuestionDependencies {
  readonly record: RunRecord;
  readonly stateDir: string;
  readonly activity: RunActivity;
  readonly clock?: WorkflowClock;
  readonly waitMode?: 'suspend' | 'block';
  readonly skipTimers?: boolean;
  readonly save: () => Promise<void>;
  readonly beforeLive: (id: string, step: StepRecord) => Promise<void>;
  readonly nextSeq: () => number;
  /**
   * Take the run's launch stamp for `id`: the settlement counter when the body requested it. A
   * live question or wait records it as `launchStamp`, so the healed-step check need not fall back
   * to `seq` order for it.
   */
  readonly launchStamp: (id: string) => number;
  /** Record a nonfatal run warning, such as an abandoned poll observation. */
  readonly warn: (message: string) => void;
  /** Run one poll observation for the wait `id`; rehearsal may replace it with a stub. */
  readonly observe?: (id: string, source: AnyPollSource, context: PollContext) => PollObservation;
  /** Whether an error is an authoring violation that must fail the run; never tolerated. */
  readonly isFatal?: (error: unknown) => boolean;
  /** Run a poll error-policy callback under the same guard as an observer. */
  readonly guard?: <R>(action: () => R) => R;
  readonly emit: (
    type: 'step.waiting' | 'step.completed' | 'step.replayed' | 'wait.opened',
    id: string,
    step: StepRecord,
  ) => void;
  readonly fail: (error: unknown) => void;
}

/** Owns parked promises, read-only observations, and the only inbox consumer. @internal */
export class RunQuestions {
  readonly #deps: QuestionDependencies;
  readonly #clock: WorkflowClock;
  readonly #waiters = new Map<string, Waiter>();
  readonly #registered = new Set<string>();
  readonly #timer = new AbortController();
  #pump: Promise<void> | undefined;
  #scan: Promise<void> | undefined;
  #inflight: Inflight | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  /** Set once close() returns; an abandoned scan must not touch the record after that. */
  #released = false;
  #draining = false;

  public constructor(deps: QuestionDependencies) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }
  public get pending(): boolean {
    return this.#waiters.size > 0;
  }
  public get nextWakeAt(): number | null {
    const times = [...this.#waiters.keys()].flatMap((id) => {
      const step = this.#deps.record.steps[id];
      return step?.status === 'waiting' && step.wait
        ? [step.wait.deadline, step.wait.nextCheckAt].filter(
            (time): time is number => time !== null,
          )
        : [];
    });
    return times.length ? Math.min(...times) : null;
  }
  public get shouldSuspend(): boolean {
    if (!this.pending) return false;
    if (this.#draining) return true;
    if (this.#deps.waitMode === 'block') return false;
    if (this.#deps.skipTimers) return true;
    const next = this.nextWakeAt;
    return next === null || next - clockNow(this.#clock) > SHORT_WAIT_MS;
  }
  public waiting(id: string): boolean {
    if (!this.#registered.has(id)) return false;
    if (this.#closed) return true;
    if (!this.#waiters.has(id)) return false;
    if (this.#draining) return true;
    // A short timer remains owned through immediate continuations, even after the body returns.
    // Only externally parked work can be excluded from the normal operation drain.
    const progress = this.#deps.record.steps[id]?.wait;
    const due = [progress?.deadline, progress?.nextCheckAt].filter(
      (at): at is number => at != null,
    );
    return !due.some((at) => at - clockNow(this.#clock) <= SHORT_WAIT_MS);
  }
  /** Preserve existing question IDs, fingerprints, and raw answer values. */
  public register<T>(
    id: string,
    options: AskOptions<T>,
    phase: string | null,
    signal: AbortSignal,
  ): Promise<{ answer: Promise<T> }> {
    return this.#register(id, { signal: options }, phase, signal, 'ask') as Promise<{
      answer: Promise<T>;
    }>;
  }
  public wait(
    id: string,
    sources: WaitSources,
    phase: string | null,
    signal: AbortSignal,
  ): Promise<{ answer: Promise<Outcome> }> {
    return this.#register(id, sources, phase, signal, 'wait') as Promise<{
      answer: Promise<Outcome>;
    }>;
  }
  async #register(
    id: string,
    sources: WaitSources,
    phase: string | null,
    signal: AbortSignal,
    kind: 'ask' | 'wait',
  ): Promise<{ answer: Promise<JsonValue> }> {
    const { record, activity, save, emit } = this.#deps;
    const launchStamp = this.#deps.launchStamp(id);
    const finish = activity.begin();
    try {
      signal.throwIfAborted();
      // A command poll's identity includes its prepared command, which needs the canonical cwd.
      const command =
        sources.poll !== undefined && isCommandPoll(sources.poll)
          ? await commandPollIdentity(sources.poll, record.cwd)
          : undefined;
      const { request, question } = waitRequest(sources, command);
      const identity = stepIdentity(
        kind === 'ask'
          ? { kind: 'ask', ...(jsonValue(question) as Record<string, JsonValue>) }
          : {
              kind: 'wait',
              request: jsonValue(request),
              signal: question ? jsonValue(question) : null,
            },
      );
      const fingerprint = digest(identity);
      const prior = Object.hasOwn(record.steps, id) ? record.steps[id] : undefined;
      if (prior && (prior.kind !== kind || prior.fingerprint !== fingerprint))
        throw new Error(
          `Step ${id}: ${kind === 'ask' ? 'question' : 'wait'} changed; use a new ID for a different decision, dependency, or deadline.`,
        );
      if (prior?.status === 'completed') {
        const answer = this.#replay(sources, prior);
        emit('step.replayed', id, prior);
        return { answer: Promise.resolve(answer) };
      }
      if (prior && prior.status !== 'waiting')
        throw new Error(`Step ${id}: wait is ${prior.status}; use a new wait ID.`);
      const now = clockNow(this.#clock);
      if (request.timeoutMs !== null && request.timeoutMs > MAX_EPOCH_MS - now)
        throw new Error(`Step ${id}: wait timeout overflows its absolute deadline.`);
      const openedAt = prior?.question ? Date.parse(prior.question.askedAt) : now;
      const step: StepRecord = prior ?? {
        kind,
        status: 'waiting',
        fingerprint,
        identity,
        seq: this.#deps.nextSeq(),
        attempts: 1,
        attemptHistory: [],
        output: null,
        error: null,
        wakeAt: null,
        phase,
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
        durationMs: null,
        request: null,
        errorStack: null,
        ...(question
          ? {
              question: {
                request: question,
                askedAt: new Date(now).toISOString(),
                resolution: null,
                rejections: [],
              },
            }
          : {}),
      };
      step.wait ??= {
        request,
        openedAt,
        deadline:
          request.timeoutMs === null ? request.deadline : now + Math.ceil(request.timeoutMs),
        nextCheckAt: request.poll ? now : null,
        checks: 0,
        note: null,
        notifiedAt: null,
      };
      step.error = null;
      step.launchStamp = launchStamp;
      await this.#deps.beforeLive(id, step);
      Object.defineProperty(record.steps, id, {
        value: step,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const notify = question !== undefined && step.wait.notifiedAt === null;
      if (notify) step.wait.notifiedAt = now;
      await save();
      signal.throwIfAborted();
      const answer = new Promise<JsonValue>((resolve, reject) => {
        const abort = (): void => {
          this.#waiters.delete(id);
          signal.removeEventListener('abort', abort);
          this.#updateWake();
          activity.touch();
          reject(
            signal.reason instanceof CancelledError
              ? signal.reason
              : new CancelledError(null, signal.reason),
          );
        };
        this.#waiters.set(id, {
          sources,
          signal,
          resolve,
          reject,
          dispose: () => {
            signal.removeEventListener('abort', abort);
          },
        });
        signal.addEventListener('abort', abort, { once: true });
      });
      void answer.catch(() => undefined);
      emit('step.waiting', id, step);
      if (notify) emit('wait.opened', id, step);
      await this.scan();
      this.#registered.add(id);
      this.#startPump();
      return { answer };
    } finally {
      finish();
    }
  }
  #replay(sources: WaitSources, step: StepRecord): JsonValue {
    if (step.kind === 'ask')
      return jsonValue(
        sources.signal?.schema.parse(structuredClone(step.output)),
        'Question answer',
        { canonical: false },
      );
    const outcome = outcomeSchema.parse(structuredClone(step.output));
    if (outcome.by === 'signal') {
      if (!sources.signal) throw new Error('Saved wait outcome requires its signal source.');
      return {
        ...outcome,
        value: jsonValue(sources.signal.schema.parse(outcome.value), 'Signal answer', {
          canonical: false,
        }),
      };
    }
    if (outcome.by === 'poll') {
      if (!sources.poll) throw new Error('Saved wait outcome requires its poll source.');
      return {
        ...outcome,
        value: jsonValue(sources.poll.schema.parse(outcome.value), 'Poll result', {
          canonical: false,
        }),
      };
    }
    if (sources.deadline === undefined && sources.timeoutMs === undefined)
      throw new Error('Saved wait outcome requires its deadline source.');
    return outcome;
  }
  #updateWake(): void {
    this.#deps.record.nextWakeAt = this.nextWakeAt;
  }
  #startPump(): void {
    if (this.#closed || this.#draining || this.#pump || !this.pending) return;
    const pumping = this.#runPump();
    this.#pump = pumping;
    void pumping
      .catch((error: unknown) => {
        if (!this.#closed && !this.#draining) this.#deps.fail(error);
      })
      .finally(() => {
        if (this.#pump === pumping) this.#pump = undefined;
        if (!this.#closed && this.pending && !this.#timer.signal.aborted) this.#startPump();
      });
  }
  async #runPump(): Promise<void> {
    while (!this.#closed && !this.#draining && this.pending) {
      const wake = this.nextWakeAt;
      const milliseconds =
        wake === null ? 200 : Math.max(1, Math.min(200, wake - clockNow(this.#clock)));
      await this.#clock.sleep(milliseconds, this.#timer.signal);
      await this.scan();
    }
  }
  public scan(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#draining) return this.#scan ?? Promise.resolve();
    this.#scan ??= this.#ingest().finally(() => {
      this.#scan = undefined;
    });
    return this.#scan;
  }
  async #ingest(): Promise<void> {
    const { record, activity } = this.#deps;
    const finish = activity.begin();
    try {
      for (const [id, waiter] of this.#waiters) {
        if (this.#draining) break;
        const step = record.steps[id];
        if (!step?.wait || step.status !== 'waiting') continue;
        try {
          await this.#check(id, step, waiter);
        } catch (error) {
          if (this.#released) return;
          this.#waiters.delete(id);
          waiter.dispose();
          step.error = error instanceof Error ? error.message : String(error);
          waiter.reject(error);
          activity.touch();
        }
      }
      if (!this.#released) this.#updateWake();
    } finally {
      finish();
    }
  }
  async #signal(
    id: string,
    step: StepRecord,
    waiter: Waiter,
  ): Promise<{ outcome: Outcome; at: string; by: string } | undefined> {
    if (!step.question || !waiter.sources.signal) return undefined;
    const { record, stateDir, save } = this.#deps;
    let delivery: { path: string; text: string } | undefined;
    for (const path of answerCandidates(stateDir, record.id, id)) {
      try {
        delivery = {
          path,
          text: (await stat(path)).size > 1_048_576 ? '' : await readFile(path, 'utf8'),
        };
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (!delivery || this.#closed) return undefined;
    const { path, text } = delivery;
    try {
      const envelope = answerEnvelopeSchema.parse(jsonValue(JSON.parse(text)));
      if (envelope.questionFingerprint !== step.fingerprint)
        throw new Error('Answer question fingerprint does not match the waiting question.');
      validateAnswerAuthor(step.question.request.audience, envelope.by);
      const value = jsonValue(
        waiter.sources.signal.schema.parse(envelope.value),
        `Question ${id} answer`,
        { canonical: false },
      );
      const at = Date.parse(envelope.at);
      if (
        step.wait?.deadline !== null &&
        step.wait?.deadline !== undefined &&
        at > step.wait.deadline
      )
        throw new Error('Answer was delivered after the wait deadline.');
      return {
        outcome: { by: 'signal', value, at, actor: envelope.by },
        at: envelope.at,
        by: envelope.by,
      };
    } catch (error) {
      const rejected = `${path}.rejected.${randomUUID()}.json`;
      await rename(path, rejected);
      step.question.rejections.push({
        at: new Date(clockNow(this.#clock)).toISOString(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        file: basename(rejected),
      });
      step.question.rejections = step.question.rejections.slice(-20);
      await save();
      return undefined;
    }
  }
  /** Read #closed afresh after an await; close() can set it while a check is suspended. */
  #isClosed(): boolean {
    return this.#closed;
  }
  async #check(id: string, step: StepRecord, waiter: Waiter): Promise<void> {
    const progress = step.wait;
    if (!progress) return;
    let signal = await this.#signal(id, step, waiter);
    if (this.#isClosed()) return;
    if (signal) {
      await this.#complete(id, step, waiter, signal.outcome, signal);
      return;
    }
    const now = clockNow(this.#clock);
    const expired =
      progress.deadline !== null &&
      (now >= progress.deadline ||
        (this.#deps.skipTimers === true && !waiter.sources.poll && !waiter.sources.signal));
    const poll = waiter.sources.poll;
    if (poll && (expired || progress.nextCheckAt === null || now >= progress.nextCheckAt)) {
      waiter.signal.throwIfAborted();
      // Read before counting this check: observers see what earlier checks persisted.
      const previous = Object.freeze({
        note: deepFreeze(structuredClone(progress.note)),
        checks: progress.checks,
        openedAt: progress.openedAt,
      });
      progress.checks++;
      const observed = await this.#observe(id, poll, progress.deadline, waiter, previous);
      if (this.#isClosed() || observed.kind === 'closed') return;
      if (observed.kind === 'cancelled')
        throw waiter.signal.reason instanceof CancelledError
          ? waiter.signal.reason
          : new CancelledError(null, waiter.signal.reason);
      if (observed.kind === 'deadline') {
        // The deadline passed during the observation: the same result as between checks.
        const at = clockNow(this.#clock);
        await this.#complete(id, step, waiter, { by: 'deadline', at, note: progress.note });
        return;
      }
      let result: Awaited<PollObservation>;
      try {
        // An expiry fails like a thrown observer, so the same onError policy applies to it.
        if (observed.kind === 'observeTimeoutMs') throw this.#observeTimeout(id, poll);
        result = (await observed.observation) as typeof result;
      } catch (error) {
        await this.#tolerate(id, step, waiter, poll, progress, error);
        return;
      }
      if (this.#isClosed()) return;
      if (
        (result as unknown) === null ||
        typeof result !== 'object' ||
        typeof result.done !== 'boolean'
      )
        throw new Error(
          `Wait ${id}: ${isCommandPoll(poll) ? 'done' : 'observe'} must return {done:true,value} or {done:false,note?}.`,
        );
      // A successful observation resets the consecutive error count.
      delete progress.lastError;
      signal = await this.#signal(id, step, waiter);
      if (this.#isClosed()) return;
      if (signal) {
        await this.#complete(id, step, waiter, signal.outcome, signal);
        return;
      }
      const at = clockNow(this.#clock);
      if (result.done) {
        const value = jsonValue(poll.schema.parse(result.value), `Wait ${id} terminal result`, {
          canonical: false,
        });
        await this.#complete(id, step, waiter, { by: 'poll', value, at, checks: progress.checks });
        return;
      }
      progress.note = waitNote(result.note);
      if (progress.deadline !== null && at >= progress.deadline) {
        await this.#complete(id, step, waiter, { by: 'deadline', at, note: progress.note });
        return;
      }
      progress.nextCheckAt = Math.min(MAX_EPOCH_MS, at + Math.ceil(this.#interval(progress)));
      this.#updateWake();
      await this.#deps.save();
    } else if (expired) {
      await this.#complete(id, step, waiter, { by: 'deadline', at: now, note: progress.note });
    }
  }
  /** The poll's normal spacing after the current check. */
  #interval(progress: WaitRecord): number {
    const every = progress.request.poll?.every;
    if (!every) throw new Error('Poll progress is missing its stored interval.');
    return Math.min(every.maxMs, every.initialMs * every.factor ** (progress.checks - 1));
  }
  /**
   * Apply the poll's onError policy to a rejected observation or an observeTimeoutMs expiry. It
   * returns once the error is recorded and the next check scheduled, or the wait completed by
   * signal or deadline; otherwise it throws, failing the wait. Run cancellation, closing, and
   * context-operation violations are never tolerated. The note is left untouched.
   */
  async #tolerate(
    id: string,
    step: StepRecord,
    waiter: Waiter,
    poll: AnyPollSource,
    progress: WaitRecord,
    error: unknown,
  ): Promise<void> {
    const policy = poll.onError;
    if (
      !policy ||
      this.#isClosed() ||
      waiter.signal.aborted ||
      error instanceof CancelledError ||
      this.#deps.isFatal?.(error) === true
    )
      throw error;
    const guard = this.#deps.guard ?? (<R>(action: () => R): R => action());
    const { classify, retryAfterMs } = policy;
    if (classify) {
      const kind = guard(() => classify(error)) as unknown;
      if (kind === 'fatal') throw error;
      if (kind !== 'transient')
        throw new Error(`Wait ${id}: onError.classify must return 'transient' or 'fatal'.`);
    }
    const consecutive = (progress.lastError?.consecutive ?? 0) + 1;
    // The error past the tolerance fails the wait with its own message.
    if (consecutive > policy.tolerate) throw error;
    const lastError = {
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      consecutive,
      at: clockNow(this.#clock),
    };
    // Keep the usual precedence: signal, then poll, then deadline.
    const signal = await this.#signal(id, step, waiter);
    if (this.#isClosed()) return;
    if (signal) {
      progress.lastError = lastError;
      await this.#complete(id, step, waiter, signal.outcome, signal);
      return;
    }
    const at = clockNow(this.#clock);
    if (progress.deadline !== null && at >= progress.deadline) {
      progress.lastError = lastError;
      await this.#complete(id, step, waiter, { by: 'deadline', at, note: progress.note });
      return;
    }
    let delay = this.#interval(progress);
    if (retryAfterMs) {
      const requested = guard(() => retryAfterMs(error)) as unknown;
      if (requested !== null) {
        if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0)
          throw new Error(
            `Wait ${id}: onError.retryAfterMs must return null or a finite number of at least 0.`,
          );
        delay = requested;
      }
    }
    progress.lastError = lastError;
    progress.nextCheckAt = Math.min(MAX_EPOCH_MS, at + Math.ceil(delay));
    this.#updateWake();
    await this.#deps.save();
  }
  /**
   * Run one observation under its own signal, which aborts when the run scope aborts, when the
   * time limit passes (the wait deadline, or observeTimeoutMs), or when the run closes. After an
   * abort the observer gets a bounded real-time grace to settle; one that ignores its signal is
   * abandoned with a run warning, and its promise keeps a handler so it never surfaces unhandled.
   */
  async #observe(
    id: string,
    poll: AnyPollSource,
    deadline: number | null,
    waiter: Waiter,
    previous: PollContext['previous'],
  ): Promise<Observed> {
    const controller = new AbortController();
    const timer = new AbortController();
    let interrupted: Interruption | undefined;
    let resolveInterruption!: (reason: Interruption) => void;
    const interruption = new Promise<Interruption>((resolve) => {
      resolveInterruption = resolve;
    });
    const interrupt = (reason: Interruption, cause: unknown): void => {
      if (interrupted) return;
      interrupted = reason;
      controller.abort(cause);
      resolveInterruption(reason);
    };
    const forward = (): void => {
      interrupt('run cancelled', waiter.signal.reason);
    };
    this.#inflight = {
      interrupt: (reason) => {
        interrupt(reason, new Error(`Wait ${id}: the run is closing; poll observation aborted.`));
      },
    };
    waiter.signal.addEventListener('abort', forward, { once: true });
    const started = clockNow(this.#clock);
    const limitMs = poll.observeTimeoutMs ?? defaultObserveTimeoutMs;
    const context: PollContext = {
      reportUsage: () => {
        throw new Error('Usage reporting is only available inside an active local step callback.');
      },
      cwd: this.#deps.record.cwd,
      signal: controller.signal,
      idempotencyKey: `${this.#deps.record.id}/${id}`,
      attempt: 1,
      // The run's observe dependency binds the real one to its process runners.
      exec: unavailableExec(id),
      previous,
    };
    const observation = (async () =>
      this.#deps.observe ? this.#deps.observe(id, poll, context) : observePoll(poll, context))();
    void observation.catch(() => undefined);
    const settled = observation.then(
      () => 'settled' as const,
      () => 'settled' as const,
    );
    const limit = this.#limit(started, deadline, limitMs, timer.signal).then(
      () => 'limit' as const,
      // An aborted limit timer never decides the race.
      () => new Promise<never>(() => undefined),
    );
    try {
      const winner = await Promise.race([settled, interruption, limit]);
      if (winner === 'settled') return { kind: 'settled', observation };
      timer.abort();
      if (winner === 'limit') {
        // Once the clock reaches the deadline the deadline wins, even over observeTimeoutMs.
        const late = deadline !== null && clockNow(this.#clock) >= deadline;
        interrupt(
          late ? 'deadline' : 'observeTimeoutMs',
          late
            ? new Error(`Wait ${id}: the deadline passed during the poll observation.`)
            : this.#observeTimeout(id, poll),
        );
      }
      const reason = interrupted ?? 'run closing';
      if (!(await settlesWithin(observation, observerSettleMs)))
        this.#deps.warn(
          `Poll observer for wait ${id} did not settle within ${String(observerSettleMs)}ms after its signal was aborted (${reason}); abandoned.`,
        );
      // An honoring observer's outcome after cancellation keeps its existing handling.
      else if (reason === 'run cancelled') return { kind: 'settled', observation };
      if (reason === 'run cancelled') return { kind: 'cancelled' };
      if (reason === 'run closing') return { kind: 'closed' };
      return { kind: reason };
    } finally {
      timer.abort();
      waiter.signal.removeEventListener('abort', forward);
      this.#inflight = undefined;
    }
  }
  /**
   * Resolve when the observation's time limit passes, measured with the workflow clock: the earlier
   * of the deadline (when still ahead) and observeTimeoutMs from the start of the observation.
   */
  async #limit(
    started: number,
    deadline: number | null,
    limitMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Arm the clock timer only after one real macrotask: an observation that settles promptly never
    // touches it, so an automatic test clock (whose sleep advances time at once) does not move.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bound = deadline !== null && deadline > started ? deadline : null;
    for (;;) {
      signal.throwIfAborted();
      const now = clockNow(this.#clock);
      if (bound !== null && now >= bound) return;
      if (now - started >= limitMs) return;
      // Loop rather than trust one sleep: a timer may fire marginally before the clock agrees.
      const remaining = Math.min(
        limitMs - (now - started),
        bound === null ? Number.POSITIVE_INFINITY : bound - now,
      );
      await this.#clock.sleep(Math.max(1, remaining), signal);
    }
  }
  #observeTimeout(id: string, poll: AnyPollSource): Error {
    const limit =
      poll.observeTimeoutMs === undefined
        ? `${String(defaultObserveTimeoutMs)}ms, the default`
        : `${String(poll.observeTimeoutMs)}ms`;
    return Object.assign(
      new Error(`Wait ${id}: poll observation did not settle within observeTimeoutMs (${limit}).`),
      { code: 'QUIET_CHOIR_POLL_OBSERVE_TIMEOUT' },
    );
  }
  async #complete(
    id: string,
    step: StepRecord,
    waiter: Waiter,
    outcome: Outcome,
    signal?: { at: string; by: string },
  ): Promise<void> {
    if (this.#closed) return;
    const output =
      step.kind === 'ask' && outcome.by === 'signal'
        ? outcome.value
        : jsonValue(outcome, 'Wait outcome', { canonical: false });
    step.output = output;
    step.status = 'completed';
    step.finishedAt = new Date(clockNow(this.#clock)).toISOString();
    if (step.wait) step.wait.nextCheckAt = null;
    if (step.question && signal)
      step.question.resolution = { via: 'inbox', at: signal.at, by: signal.by };
    this.#updateWake();
    await this.#deps.save();
    this.#waiters.delete(id);
    waiter.dispose();
    this.#deps.emit('step.completed', id, step);
    waiter.resolve(structuredClone(output));
    this.#deps.activity.touch();
  }
  public withdraw(): void {
    for (const step of Object.values(this.#deps.record.steps)) {
      if (step.status === 'waiting') {
        step.status = 'withdrawn';
        step.finishedAt = new Date(clockNow(this.#clock)).toISOString();
      }
    }
    this.#updateWake();
  }
  /** Stop scheduling observations while preserving already-active work during failure drain. */
  public drain(): void {
    this.#draining = true;
    this.#timer.abort();
    this.#deps.activity.touch();
  }
  /** Stop polling and drain the scan, abandoning an observer that ignores its signal. */
  public close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }
  async #close(): Promise<void> {
    this.#closed = true;
    this.#timer.abort();
    this.#inflight?.interrupt('run closing');
    let backstop: ReturnType<typeof setTimeout> | undefined;
    try {
      // #check bounds an aborted observation to the grace itself; this only covers other stalls.
      const drained = await Promise.race([
        Promise.allSettled([this.#scan, this.#pump]).then(() => true),
        new Promise<boolean>((resolve) => {
          backstop = setTimeout(resolve, observerSettleMs + closeMarginMs, false);
        }),
      ]);
      if (!drained)
        this.#deps.warn(
          `Wait scan did not settle within ${String(observerSettleMs + closeMarginMs)}ms of the run closing; abandoned.`,
        );
    } finally {
      clearTimeout(backstop);
      this.#released = true;
      this.#updateWake();
      for (const waiter of this.#waiters.values()) waiter.dispose();
      this.#waiters.clear();
      // Keep abandoned IDs parked in OperationTracker through failure finalization.
    }
  }
}

/** `context.exec` of an observer run without a process-owning runtime, such as a bare test. */
function unavailableExec(id: string): PollContext['exec'] {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error(`Wait ${id}: context.exec is not available to this poll observer.`));
  return Object.assign(refuse, { json: refuse }) as PollContext['exec'];
}

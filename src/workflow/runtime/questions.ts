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
import type { JsonValue, StepContext } from './model.js';
import type { RunRecord, StepRecord } from './store.js';
import { clockNow, MAX_EPOCH_MS, SHORT_WAIT_MS, systemClock } from './clock.js';
import { waitNote, waitRequest } from './wait-schema.js';
import type { PollSource, WaitSources, WorkflowClock } from './wait-model.js';

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
  /** Run one poll observation for the wait `id`; rehearsal may replace it with a stub. */
  readonly observe?: (
    id: string,
    source: PollSource<unknown>,
    context: StepContext,
  ) => ReturnType<PollSource<unknown>['observe']>;
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
  #closed = false;
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
    const finish = activity.begin();
    try {
      signal.throwIfAborted();
      const { request, question } = waitRequest(sources);
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
          this.#waiters.delete(id);
          waiter.dispose();
          step.error = error instanceof Error ? error.message : String(error);
          waiter.reject(error);
          activity.touch();
        }
      }
      this.#updateWake();
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
  async #check(id: string, step: StepRecord, waiter: Waiter): Promise<void> {
    const progress = step.wait;
    if (!progress) return;
    let signal = await this.#signal(id, step, waiter);
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
      const context: StepContext = {
        reportUsage: () => {
          throw new Error(
            'Usage reporting is only available inside an active local step callback.',
          );
        },
        cwd: this.#deps.record.cwd,
        signal: waiter.signal,
        idempotencyKey: `${this.#deps.record.id}/${id}`,
        attempt: 1,
      };
      waiter.signal.throwIfAborted();
      progress.checks++;
      const result = await (this.#deps.observe
        ? this.#deps.observe(id, poll, context)
        : poll.observe(context));
      if (
        (result as unknown) === null ||
        typeof result !== 'object' ||
        typeof result.done !== 'boolean'
      )
        throw new Error(`Wait ${id}: observe must return {done:true,value} or {done:false,note?}.`);
      signal = await this.#signal(id, step, waiter);
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
      const every = progress.request.poll?.every;
      if (!every) throw new Error('Poll progress is missing its stored interval.');
      const interval = Math.min(
        every.maxMs,
        every.initialMs * every.factor ** (progress.checks - 1),
      );
      progress.nextCheckAt = Math.min(MAX_EPOCH_MS, at + Math.ceil(interval));
      this.#updateWake();
      await this.#deps.save();
    } else if (expired) {
      await this.#complete(id, step, waiter, { by: 'deadline', at: now, note: progress.note });
    }
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
  public async close(): Promise<void> {
    this.#closed = true;
    this.#timer.abort();
    try {
      await this.#scan;
      await this.#pump?.catch(() => undefined);
    } finally {
      this.#updateWake();
      for (const waiter of this.#waiters.values()) waiter.dispose();
      this.#waiters.clear();
      // Keep abandoned IDs parked in OperationTracker through failure finalization.
    }
  }
}

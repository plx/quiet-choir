import { randomUUID } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { RunActivity } from './activity.js';
import { CancelledError } from './fan-out.js';
import { AnswerError, answerCandidates, schemaMismatch, syntheticInvalid } from './inbox.js';
import { digest, jsonValue } from './json.js';
import { stepIdentity } from './identity.js';
import { answerEnvelopeSchema, envelopeBinding, validateAnswerAuthor } from './question-schema.js';
import type { AnswerIssue, AskOptions } from './question-model.js';
import type { JsonValue } from './model.js';
import type { RunRecord, StepMapItem, StepRecord } from './store.js';
import { clockNow, MAX_EPOCH_MS, SHORT_WAIT_MS, systemClock } from './clock.js';
import { waitNote, waitRequest } from './wait-schema.js';
import {
  commandPollIdentity,
  defaultObserveTimeoutMs,
  isCommandPoll,
  observePoll,
  parsePollNote,
  type AnyPollSource,
  type PollObservation,
} from './poll-command.js';
import type { PollContext, WaitRecord, WaitSources, WorkflowClock } from './wait-model.js';

/**
 * Appended to a "wait changed" refusal when the poll's callback source is its only difference. The
 * digest covers the source text as the loader printed it, so another loader changes it without an
 * edit; see docs/waits.md and ADR 0059.
 */
const CALLBACK_SOURCE_HINT =
  " Only the poll's observe (a command poll's done) source text differs; it is hashed as the loader printed it, so resuming under a different loader or transform changes it without an edit. Resume under the loader that started the run, fork the run, or use a new wait ID.";

/**
 * Whether restoring the prior wait's recorded `observe` digest into the new request reproduces the
 * prior fingerprint, so the callback's printed source is the only difference. It rebuilds the
 * identity exactly as the live check does and compares whole fingerprints, so no field is listed.
 * A built-in helper's poll never gets the hint: its digest is a versioned identity, not printed
 * source text, so a difference there is not a loader effect.
 */
function onlyCallbackSourceChanged(
  prior: StepRecord,
  request: ReturnType<typeof waitRequest>['request'],
  question: ReturnType<typeof waitRequest>['question'],
  observeFromHelper: boolean,
): boolean {
  if (observeFromHelper) return false;
  const priorPoll = prior.kind === 'wait' ? prior.wait?.request.poll : undefined;
  if (!priorPoll || !request.poll || priorPoll.observe === request.poll.observe) return false;
  const restored = stepIdentity({
    kind: 'wait',
    request: jsonValue({ ...request, poll: { ...request.poll, observe: priorPoll.observe } }),
    signal: question ? jsonValue(question) : null,
  });
  return digest(restored) === prior.fingerprint;
}

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
/**
 * Under rehearsal, the most checks one poll gets in this process. They run back to back in one
 * scan on a virtual clock; a poll still nonterminal after them parks and the rehearsal suspends.
 */
const REHEARSAL_POLL_CHECKS = 5;
/** Why an in-flight observation's signal was aborted. */
type Interruption =
  'deadline' | 'observeTimeoutMs' | 'run cancelled' | 'run closing' | 'run failing';
interface Inflight {
  readonly interrupt: (reason: Interruption) => void;
}
/**
 * One poll observation's result, as the run's observe dependency returns it. `commit` keeps what
 * the observation recorded for export (its inner commands) on the wait's record; RunQuestions calls
 * it only for the observation whose `done: true` result completes the wait, right before the
 * completion save, so a discarded, abandoned, timed-out, drained or closed observation never
 * writes.
 */
export interface ObservedPoll {
  readonly result: Awaited<PollObservation>;
  readonly commit?: () => void;
}
type Observed =
  | { readonly kind: 'settled'; readonly observation: Promise<ObservedPoll> }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'closed' }
  /** Aborted because a body failure started draining the run; nothing is recorded. */
  | { readonly kind: 'drained' }
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
/** What a tolerated poll error reports in its `wait.tolerated` run event. */
interface ToleratedError {
  /** Consecutive tolerated errors, this one included. */
  readonly consecutive: number;
  /** The poll's `onError.tolerate` limit. */
  readonly tolerate: number;
  /** The error message, as `lastError` keeps it. */
  readonly message: string;
  /** When the error was observed, in epoch milliseconds, as `lastError.at` keeps it. */
  readonly at: number;
  /** The error's string `code` property, when it has one. */
  readonly code?: string;
}
/** The string `code` property of an error, such as ENOENT, or undefined. */
function errorCode(error: unknown): string | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
    return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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
  /**
   * The named-map items enclosing the current call, in their persisted form, or undefined outside
   * every map item. A live question or wait records them as `mapItems` for fork prefix reuse.
   */
  readonly mapItems: () => StepMapItem[] | undefined;
  /** Record a nonfatal run warning, such as an abandoned poll observation. */
  readonly warn: (message: string) => void;
  /** Run one poll observation for the wait `id`; rehearsal may replace it with a stub. */
  readonly observe?: (
    id: string,
    source: AnyPollSource,
    context: PollContext,
  ) => Promise<ObservedPoll>;
  /** Whether an error is an authoring violation that must fail the run; never tolerated. */
  readonly isFatal?: (error: unknown) => boolean;
  /**
   * Run a poll error-policy callback or noteSchema parse under the same guard as an observer, so
   * a nested context operation fails the wait.
   */
  readonly guard?: <R>(action: () => R) => R;
  /**
   * Append a `wait.tolerated` run event for the wait `id` to the record in memory, committed by the
   * caller's next save, and return the callback that notifies it live once that save resolves.
   */
  readonly tolerated: (id: string, step: StepRecord, details: ToleratedError) => () => void;
  /**
   * Under rehearsal, report once per wait that its poll was still nonterminal after `checks`
   * rehearsed checks, the limit, so it parks without further checks.
   */
  readonly rehearsalLimit?: (id: string, checks: number) => void;
  readonly emit: (
    type: 'step.waiting' | 'step.completed' | 'step.replayed' | 'wait.opened',
    id: string,
    step: StepRecord,
  ) => void;
  readonly fail: (error: unknown) => void;
}

/** Bounds of a persisted rejection's issues; question-schema.ts enforces the same limits. */
const MAX_REJECTION_ISSUES = 20;
const MAX_ISSUE_CODE = 100;
const MAX_ISSUE_PATH = 32;
const MAX_ISSUE_PATH_KEY = 256;
const MAX_ISSUE_MESSAGE = 1024;

/** Stringify a numeric path segment JSON cannot hold losslessly (NaN, Infinity, -0). */
function pathNumber(part: number | string): number | string {
  if (typeof part === 'string' || (Number.isFinite(part) && !Object.is(part, -0))) return part;
  return Object.is(part, -0) ? '-0' : String(part);
}

/** Truncate structured issues so a recorded rejection always re-parses. */
function boundedIssues(issues: readonly AnswerIssue[]): AnswerIssue[] {
  return issues.slice(0, MAX_REJECTION_ISSUES).map((issue) => ({
    code: issue.code.slice(0, MAX_ISSUE_CODE) || 'invalid',
    path: issue.path
      .slice(0, MAX_ISSUE_PATH)
      .map((part) =>
        typeof part === 'string' ? part.slice(0, MAX_ISSUE_PATH_KEY) : pathNumber(part),
      ),
    message: issue.message.slice(0, MAX_ISSUE_MESSAGE),
  }));
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
  /** Under rehearsal, the poll checks each wait started in this process (not `progress.checks`). */
  readonly #rehearsedChecks = new Map<string, number>();
  /** Waits whose rehearsal limit was already reported. */
  readonly #limitReported = new Set<string>();

  public constructor(deps: QuestionDependencies) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }
  public get pending(): boolean {
    return this.#waiters.size > 0;
  }
  public get nextWakeAt(): number | null {
    return this.#wakeAt(() => true);
  }
  /** The earliest deadline or next check among the waiting waiters that `include` selects. */
  #wakeAt(include: (id: string) => boolean): number | null {
    const times = [...this.#waiters.keys()].filter(include).flatMap((id) => {
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
    // An exhausted rehearsed poll is never checked again, so even block mode would wait forever.
    if ([...this.#waiters.keys()].some((id) => this.#exhausted(id))) return true;
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
    if (this.#exhausted(id)) return true;
    // A short timer remains owned through immediate continuations, even after the body returns.
    // Only externally parked work can be excluded from the normal operation drain.
    const progress = this.#deps.record.steps[id]?.wait;
    const due = [progress?.deadline, progress?.nextCheckAt].filter(
      (at): at is number => at != null,
    );
    return !due.some((at) => at - clockNow(this.#clock) <= SHORT_WAIT_MS);
  }
  /** Whether the waiter is a poll under rehearsal, whose checks run on a virtual clock. */
  #rehearsed(waiter: Waiter): boolean {
    return this.#deps.skipTimers === true && waiter.sources.poll !== undefined;
  }
  /** Rehearsed checks the wait `id` started in this process. */
  #rehearsedCount(id: string): number {
    return this.#rehearsedChecks.get(id) ?? 0;
  }
  /** Whether `id` is a rehearsed poll that reached the limit; it is never observed again. */
  #exhausted(id: string): boolean {
    const waiter = this.#waiters.get(id);
    return (
      waiter !== undefined &&
      this.#rehearsed(waiter) &&
      this.#rehearsedCount(id) >= REHEARSAL_POLL_CHECKS
    );
  }
  /** Whether any waiter can still be checked; an exhausted rehearsed poll needs no pump. */
  #checkable(): boolean {
    return [...this.#waiters.keys()].some((id) => !this.#exhausted(id));
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
    const mapItems = this.#deps.mapItems();
    const finish = activity.begin();
    try {
      signal.throwIfAborted();
      // A command poll's identity includes its prepared command, which needs the canonical cwd.
      const command =
        sources.poll !== undefined && isCommandPoll(sources.poll)
          ? await commandPollIdentity(sources.poll, record.cwd)
          : undefined;
      const { request, question, observeFromHelper } = waitRequest(sources, command);
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
          `Step ${id}: ${kind === 'ask' ? 'question' : 'wait'} changed; use a new ID for a different decision, dependency, or deadline.` +
            (kind === 'wait' &&
            onlyCallbackSourceChanged(prior, request, question, observeFromHelper)
              ? CALLBACK_SOURCE_HINT
              : ''),
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
      if (mapItems === undefined) delete step.mapItems;
      else step.mapItems = mapItems;
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
    // Under rehearsal an exhausted poll is parked: the pump would only rescan it without a check.
    if (this.#closed || this.#draining || this.#pump || !this.pending || !this.#checkable()) return;
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
    while (!this.#closed && !this.#draining && this.pending && this.#checkable()) {
      // A parked exhausted rehearsed poll is never checked again, so it never wakes the pump.
      const wake = this.#wakeAt((id) => !this.#exhausted(id));
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
          if (this.#rehearsed(waiter)) await this.#rehearse(id, step, waiter);
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
  /**
   * Under rehearsal, keep checking a poll back to back, on the virtual clock, until it completes or
   * reaches the limit, all inside the caller's activity span so quiescence cannot suspend the run
   * between checks. A poll still waiting at the limit is reported once and then parks.
   */
  async #rehearse(id: string, step: StepRecord, waiter: Waiter): Promise<void> {
    while (this.#stillWaiting(id, step, waiter) && !this.#exhausted(id)) {
      const before = this.#rehearsedCount(id);
      await this.#check(id, step, waiter);
      // Every pass must start an observation; otherwise the poll cannot advance here.
      if (this.#rehearsedCount(id) === before) break;
    }
    if (
      this.#stillWaiting(id, step, waiter) &&
      this.#exhausted(id) &&
      !this.#limitReported.has(id)
    ) {
      this.#limitReported.add(id);
      this.#deps.rehearsalLimit?.(id, this.#rehearsedCount(id));
    }
  }
  /** Whether the wait is still registered and waiting, with the run neither draining nor closed. */
  #stillWaiting(id: string, step: StepRecord, waiter: Waiter): boolean {
    return (
      !this.#draining &&
      !this.#closed &&
      this.#waiters.get(id) === waiter &&
      step.status === 'waiting'
    );
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
      if (envelopeBinding(envelope, record) === 'mismatch')
        throw new Error('Answer was addressed to an earlier run with this ID.');
      try {
        validateAnswerAuthor(step.question.request.audience, envelope.by);
      } catch (error) {
        throw syntheticInvalid('answer_author', error);
      }
      // safeParse reports a schema mismatch as data; a refinement that throws still escapes to
      // the catch below as a plain-text rejection.
      const parsed = waiter.sources.signal.schema.safeParse(envelope.value);
      if (!parsed.success) throw schemaMismatch(parsed.error.issues);
      const value = jsonValue(parsed.data, `Question ${id} answer`, { canonical: false });
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
      const issues = error instanceof AnswerError ? boundedIssues(error.issues) : [];
      step.question.rejections.push({
        at: new Date(clockNow(this.#clock)).toISOString(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        ...(issues.length ? { issues } : {}),
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
    const poll = waiter.sources.poll;
    // A rehearsed poll that reached the limit parks: no later scan observes it again.
    if (poll && this.#exhausted(id)) return;
    const rehearsed = this.#rehearsed(waiter);
    const clocked = clockNow(this.#clock);
    // Under rehearsal a check runs on a virtual clock, at the moment a live pump would wake for it:
    // the next check, or the deadline when that comes first. No real interval is slept.
    const now = rehearsed
      ? Math.max(
          clocked,
          Math.min(progress.nextCheckAt ?? clocked, progress.deadline ?? Number.POSITIVE_INFINITY),
        )
      : clocked;
    // Under rehearsal the workflow clock is shifted by this offset, so the observation's elapsed
    // time still counts after the check's virtual start.
    const offset = rehearsed ? now - clocked : 0;
    /** The time after an await, on the same shifted clock the observation's deadline uses. */
    const later = (): number => clockNow(this.#clock) + offset;
    const expired =
      progress.deadline !== null &&
      (now >= progress.deadline ||
        (this.#deps.skipTimers === true && !waiter.sources.poll && !waiter.sources.signal));
    if (poll && (expired || progress.nextCheckAt === null || now >= progress.nextCheckAt)) {
      // A failure drain stops new observations; this one stays due and runs again on resume.
      if (this.#draining) return;
      waiter.signal.throwIfAborted();
      // Read before counting this check: observers see what earlier checks persisted. A saved note
      // that fails noteSchema fails the wait here, before the observer runs and without counting.
      const previous = Object.freeze({
        note: deepFreeze(
          structuredClone(this.#guard(() => parsePollNote(id, poll, progress.note, 'saved'))),
        ) as JsonValue,
        checks: progress.checks,
        openedAt: progress.openedAt,
      });
      progress.checks++;
      if (rehearsed) this.#rehearsedChecks.set(id, this.#rehearsedCount(id) + 1);
      // Under rehearsal the observation's deadline is measured on the check's virtual clock.
      const observed = await this.#observe(id, poll, progress.deadline, waiter, previous, offset);
      // A drain-aborted observation records nothing, like a closed one: no check result, error or
      // lastError, and nextCheckAt stays due, so it reruns on resume. It never reaches #tolerate.
      if (this.#isClosed() || observed.kind === 'closed' || observed.kind === 'drained') return;
      if (observed.kind === 'cancelled')
        throw waiter.signal.reason instanceof CancelledError
          ? waiter.signal.reason
          : new CancelledError(null, waiter.signal.reason);
      if (observed.kind === 'deadline') {
        // The deadline passed during the observation: the same result as between checks.
        const at = later();
        await this.#complete(id, step, waiter, { by: 'deadline', at, note: progress.note });
        return;
      }
      let result: Awaited<PollObservation>;
      let commit: (() => void) | undefined;
      try {
        // An expiry fails like a thrown observer, so the same onError policy applies to it.
        if (observed.kind === 'observeTimeoutMs') throw this.#observeTimeout(id, poll);
        ({ result, commit } = await observed.observation);
      } catch (error) {
        await this.#tolerate(id, step, waiter, poll, progress, error, offset);
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
      const at = later();
      if (result.done) {
        const value = jsonValue(poll.schema.parse(result.value), `Wait ${id} terminal result`, {
          canonical: false,
        });
        // Only the accepted observation keeps its records; the completion save persists them.
        commit?.();
        await this.#complete(id, step, waiter, { by: 'poll', value, at, checks: progress.checks });
        return;
      }
      progress.note = waitNote(
        this.#guard(() => parsePollNote(id, poll, result.note ?? null, 'returned')),
      );
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
  /** Run a synchronous poll callback under the nested-operation guard when the runner supplies one. */
  #guard<R>(action: () => R): R {
    return this.#deps.guard ? this.#deps.guard(action) : action();
  }

  /**
   * Apply the poll's onError policy to a rejected observation or an observeTimeoutMs expiry. It
   * returns once the error is recorded and the next check scheduled, or the wait completed by
   * signal or deadline; otherwise it throws, failing the wait. Run cancellation, closing, and
   * context-operation violations are never tolerated. The note is left untouched. Each tolerated
   * error appends one `wait.tolerated` run event together with `lastError`, so both commit in the
   * same save, and notifies it only after that save; every throwing path runs before the append,
   * so an error that fails the wait records no event. Under rehearsal `offset` shifts the workflow
   * clock to the check's virtual time, so `lastError.at`, the deadline test and the next check keep
   * the observation's elapsed time on that clock.
   */
  async #tolerate(
    id: string,
    step: StepRecord,
    waiter: Waiter,
    poll: AnyPollSource,
    progress: WaitRecord,
    error: unknown,
    offset: number,
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
    const guard = <R>(action: () => R): R => this.#guard(action);
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
      at: clockNow(this.#clock) + offset,
    };
    const code = errorCode(error);
    // Record the error and its run event in one synchronous step; the caller's save commits both.
    const record = (): (() => void) => {
      progress.lastError = lastError;
      return this.#deps.tolerated(id, step, {
        consecutive,
        tolerate: policy.tolerate,
        message: lastError.message,
        at: lastError.at,
        ...(code === undefined ? {} : { code }),
      });
    };
    // Keep the usual precedence: signal, then poll, then deadline.
    const signal = await this.#signal(id, step, waiter);
    if (this.#isClosed()) return;
    if (signal) {
      await this.#complete(id, step, waiter, signal.outcome, signal, record());
      return;
    }
    // Under rehearsal the offset puts the deadline test and the retry on the check's virtual clock.
    const at = clockNow(this.#clock) + offset;
    if (progress.deadline !== null && at >= progress.deadline) {
      const announce = record();
      await this.#complete(
        id,
        step,
        waiter,
        { by: 'deadline', at, note: progress.note },
        undefined,
        announce,
      );
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
    const announce = record();
    progress.nextCheckAt = Math.min(MAX_EPOCH_MS, at + Math.ceil(delay));
    this.#updateWake();
    await this.#deps.save();
    announce();
  }
  /**
   * Run one observation under its own signal, which aborts when the run scope aborts, when the
   * time limit passes (the wait deadline, or observeTimeoutMs), when a body failure starts draining
   * the run, or when the run closes. After an abort the observer gets a bounded real-time grace to
   * settle; one that ignores its signal is abandoned with a run warning, and its promise keeps a
   * handler so it never surfaces unhandled. Under rehearsal `offset` shifts the workflow clock to
   * the check's virtual time for the deadline; observeTimeoutMs still counts real elapsed time.
   */
  async #observe(
    id: string,
    poll: AnyPollSource,
    deadline: number | null,
    waiter: Waiter,
    previous: PollContext['previous'],
    offset: number,
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
        interrupt(
          reason,
          new Error(
            `Wait ${id}: the run is ${reason === 'run failing' ? 'failing' : 'closing'}; poll observation aborted.`,
          ),
        );
      },
    };
    waiter.signal.addEventListener('abort', forward, { once: true });
    const started = clockNow(this.#clock) + offset;
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
    const observation = (async (): Promise<ObservedPoll> =>
      this.#deps.observe
        ? this.#deps.observe(id, poll, context)
        : { result: await observePoll(poll, context) })();
    void observation.catch(() => undefined);
    const settled = observation.then(
      () => 'settled' as const,
      () => 'settled' as const,
    );
    const limit = this.#limit(started, deadline, limitMs, offset, timer.signal).then(
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
        const late = deadline !== null && clockNow(this.#clock) + offset >= deadline;
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
      // Even an honoring observer's outcome is discarded: it was cut short, not a real result.
      if (reason === 'run failing') return { kind: 'drained' };
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
   * `started` and the deadline are on the workflow clock shifted by `offset` (a rehearsed check's
   * virtual time); the shift cancels out of the elapsed time, which stays real.
   */
  async #limit(
    started: number,
    deadline: number | null,
    limitMs: number,
    offset: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Arm the clock timer only after one real macrotask: an observation that settles promptly never
    // touches it, so an automatic test clock (whose sleep advances time at once) does not move.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bound = deadline !== null && deadline > started ? deadline : null;
    for (;;) {
      signal.throwIfAborted();
      const now = clockNow(this.#clock) + offset;
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
  /**
   * Save the wait's outcome, then notify: first `announce` (a tolerated error's run event committed
   * in this save), then `step.completed`, so the live order matches the record.
   */
  async #complete(
    id: string,
    step: StepRecord,
    waiter: Waiter,
    outcome: Outcome,
    signal?: { at: string; by: string },
    announce?: () => void,
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
    announce?.();
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
  /**
   * Start the failure drain: stop scheduling observations and abort an in-flight one, while the
   * runner keeps draining operations without a signal. Poll observers are read-only, so an aborted
   * observation records nothing and simply reruns on resume.
   */
  public drain(): void {
    this.#draining = true;
    this.#timer.abort();
    this.#inflight?.interrupt('run failing');
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

import { randomUUID } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { z } from 'zod';
import type { RunActivity } from './activity.js';
import { CancelledError } from './fan-out.js';
import { answerCandidates } from './inbox.js';
import { digest, jsonValue } from './json.js';
import { stepIdentity } from './identity.js';
import { answerEnvelopeSchema, questionRequest, validateAnswerAuthor } from './question-schema.js';
import type { AskOptions } from './question-model.js';
import type { JsonValue } from './model.js';
import type { RunRecord, StepRecord } from './store.js';

interface Waiter {
  readonly schema: z.ZodType;
  readonly resolve: (value: JsonValue) => void;
  readonly dispose: () => void;
}

interface QuestionDependencies {
  readonly record: RunRecord;
  readonly stateDir: string;
  readonly activity: RunActivity;
  readonly save: () => Promise<void>;
  readonly beforeLive: (id: string, step: StepRecord) => Promise<void>;
  readonly nextSeq: () => number;
  readonly emit: (
    type: 'step.waiting' | 'step.completed' | 'step.replayed',
    id: string,
    step: StepRecord,
  ) => void;
  readonly fail: (error: unknown) => void;
}

/** Owns waiting promises and the only checkpoint-writing inbox consumer. @internal */
export class RunQuestions {
  readonly #deps: QuestionDependencies;
  readonly #waiters = new Map<string, Waiter>();
  readonly #registered = new Set<string>();
  #poll: ReturnType<typeof setInterval> | undefined;
  #scan: Promise<void> | undefined;
  #closed = false;

  public constructor(deps: QuestionDependencies) {
    this.#deps = deps;
  }

  public get pending(): boolean {
    return this.#waiters.size > 0;
  }

  public waiting(id: string): boolean {
    return this.#registered.has(id) && (this.#closed || this.#waiters.has(id));
  }

  public async register<T>(
    id: string,
    options: AskOptions<T>,
    phase: string | null,
    signal: AbortSignal,
  ): Promise<{ answer: Promise<T> }> {
    const { record, activity, save, emit } = this.#deps;
    const finish = activity.begin();
    try {
      signal.throwIfAborted();
      const request = questionRequest(options);
      const identity = stepIdentity({
        kind: 'ask',
        ...(jsonValue(request) as Record<string, JsonValue>),
      });
      const fingerprint = digest(identity);
      const prior = Object.hasOwn(record.steps, id) ? record.steps[id] : undefined;
      if (prior && (prior.kind !== 'ask' || prior.fingerprint !== fingerprint))
        throw new Error(
          `Step ${id}: question changed; use a new ID for a different decision or revision.`,
        );
      if (prior?.status === 'completed') {
        const answer = jsonValue(
          options.schema.parse(structuredClone(prior.output)),
          `Question ${id} answer`,
          { canonical: false },
        ) as T;
        emit('step.replayed', id, prior);
        return { answer: Promise.resolve(answer) };
      }
      if (prior && prior.status !== 'waiting')
        throw new Error(`Step ${id}: question is ${prior.status}; use a new question ID.`);
      const now = new Date().toISOString();
      const step: StepRecord = prior ?? {
        kind: 'ask',
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
        startedAt: now,
        finishedAt: null,
        durationMs: null,
        request: null,
        errorStack: null,
        question: { request, askedAt: now, resolution: null, rejections: [] },
      };
      await this.#deps.beforeLive(id, step);
      Object.defineProperty(record.steps, id, {
        value: step,
        configurable: true,
        writable: true,
        enumerable: true,
      });
      await save();
      signal.throwIfAborted();
      // The boxed promise lets registration finish without adopting the unanswered promise.
      const answer = new Promise<T>((resolve, reject) => {
        const abort = (): void => {
          this.#waiters.delete(id);
          signal.removeEventListener('abort', abort);
          activity.touch();
          reject(
            signal.reason instanceof CancelledError
              ? signal.reason
              : new CancelledError(null, signal.reason),
          );
        };
        this.#waiters.set(id, {
          schema: options.schema,
          resolve: (value) => {
            resolve(value as T);
          },
          dispose: () => {
            signal.removeEventListener('abort', abort);
          },
        });
        signal.addEventListener('abort', abort, { once: true });
      });
      // Internal observation prevents a cancellation during the initial scan from being unhandled.
      void answer.catch(() => undefined);
      emit('step.waiting', id, step);
      this.#poll ??= setInterval(() => {
        void this.scan().catch(this.#deps.fail);
      }, 200);
      await this.scan();
      this.#registered.add(id);
      return { answer };
    } finally {
      finish();
    }
  }

  public scan(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#scan ??= this.#ingest().finally(() => {
      this.#scan = undefined;
    });
    return this.#scan;
  }

  async #ingest(): Promise<void> {
    const { record, stateDir, activity, save, emit } = this.#deps;
    const finish = activity.begin();
    try {
      for (const [id, waiter] of this.#waiters) {
        const step = record.steps[id];
        if (!step?.question || step.status !== 'waiting') continue;
        let delivery: { path: string; text: string } | undefined;
        for (const path of answerCandidates(stateDir, record.id, id)) {
          try {
            const text = (await stat(path)).size > 1_048_576 ? '' : await readFile(path, 'utf8');
            delivery = { path, text };
            break;
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
        if (!delivery) continue;
        const { path, text } = delivery;
        if (this.#closed || !this.#waiters.has(id)) continue;
        let value: JsonValue;
        let envelope: ReturnType<typeof answerEnvelopeSchema.parse>;
        try {
          envelope = answerEnvelopeSchema.parse(jsonValue(JSON.parse(text)));
          if (envelope.questionFingerprint !== step.fingerprint)
            throw new Error('Answer question fingerprint does not match the waiting question.');
          validateAnswerAuthor(step.question.request.audience, envelope.by);
          value = jsonValue(waiter.schema.parse(envelope.value), `Question ${id} answer`, {
            canonical: false,
          });
        } catch (error) {
          const rejected = `${path}.rejected.${randomUUID()}.json`;
          await rename(path, rejected);
          step.question.rejections.push({
            at: new Date().toISOString(),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
            file: basename(rejected),
          });
          step.question.rejections = step.question.rejections.slice(-20);
          await save();
          continue;
        }
        step.output = value;
        step.status = 'completed';
        step.finishedAt = new Date().toISOString();
        step.question.resolution = { via: 'inbox', by: envelope.by, at: envelope.at };
        await save();
        this.#waiters.delete(id);
        waiter.dispose();
        emit('step.completed', id, step);
        waiter.resolve(structuredClone(value));
        activity.touch();
      }
    } finally {
      finish();
    }
  }

  public withdraw(): void {
    for (const step of Object.values(this.#deps.record.steps)) {
      if (step.status === 'waiting') {
        step.status = 'withdrawn';
        step.finishedAt = new Date().toISOString();
      }
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#poll);
    try {
      await this.#scan;
    } finally {
      for (const waiter of this.#waiters.values()) waiter.dispose();
      this.#waiters.clear();
      // Keep abandoned question IDs parked in OperationTracker through failure finalization.
    }
  }
}

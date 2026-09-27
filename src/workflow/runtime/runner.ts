import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { HarnessError } from './harness-error.js';
import { digest, jsonValue } from './json.js';
import type {
  AgentClient,
  AgentOptions,
  AgentResult,
  ClaudeOptions,
  CodexOptions,
  Harness,
  HarnessRequest,
  JsonValue,
  RetryPolicy,
  StepContext,
  StepDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from './model.js';
import { lockRun, readRun, writeRun, type RunRecord, type StepRecord } from './store.js';

/** A lightweight notification emitted after the associated checkpoint is persisted. */
export interface WorkflowEvent {
  /** Event lifecycle transition. */
  readonly type: 'step.started' | 'step.completed' | 'step.replayed' | 'step.failed';
  /** Owning execution. */
  readonly runId: string;
  /** Named effect. */
  readonly stepId: string;
  /** Total persisted attempts for this effect. */
  readonly attempt: number;
}

/** A completed run with its output type inferred from the workflow definition. */
export type WorkflowRun<TOutput> = RunRecord & {
  /** Final validated output, inferred from the workflow schema. */
  readonly output: TOutput;
};

/** Explicit dependencies and execution policy for a workflow run. */
export interface RunOptions {
  /** Required stable identifier. Reuse it with resume to continue an execution. */
  readonly runId: string;
  /** Checkpoint directory; defaults to .quiet-choir/runs under the working directory. */
  readonly stateDir?: string;
  /** Workflow working directory; defaults to process.cwd(). */
  readonly cwd?: string;
  /** Untrusted input, validated by the workflow schema. Resume uses saved input when omitted. */
  readonly input?: unknown;
  /** Resume an existing run; new execution refuses to overwrite an existing run. */
  readonly resume?: boolean;
  /** Harness integration. Local-only workflows do not need this dependency. */
  readonly harness?: Harness;
  /** Cancellation signal, forwarded to all active effects. */
  readonly signal?: AbortSignal;
  /** Caller-provided code fingerprint; CLI supplies a hash of local TypeScript dependencies. */
  readonly fingerprint?: string;
  /** Optional observer. Observer exceptions are ignored so they cannot affect execution. */
  readonly onEvent?: (event: WorkflowEvent) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function schemaJson(schema: z.ZodType): JsonValue {
  // Zod attaches non-enumerable implementation metadata to its generated schema.
  // Serialize this trusted schema document before applying the checkpoint data rules.
  const generated: unknown = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })),
  );
  return jsonValue(generated);
}

async function waitUntil(timestamp: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let remaining = timestamp - Date.now();
  while (remaining > 0) {
    await delay(Math.min(remaining, 2_147_483_647), undefined, { signal });
    remaining = timestamp - Date.now();
  }
}

/** Run or resume a workflow with local, at-least-once durable effects. Throws after saving failures. */
export async function runWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
  options: RunOptions,
): Promise<WorkflowRun<TOutput>> {
  if (!definition.name.trim() || !definition.version.trim())
    throw new Error('Workflow name and version must be nonempty.');
  const cwd = resolve(options.cwd ?? process.cwd());
  const stateDir = resolve(cwd, options.stateDir ?? '.quiet-choir/runs');
  const fingerprint = digest({
    code: options.fingerprint ?? null,
    input: schemaJson(definition.input),
    output: schemaJson(definition.output),
  });
  const release = await lockRun(stateDir, options.runId);
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const { signal } = controller;
  try {
    let existing: RunRecord | undefined;
    try {
      existing = await readRun(stateDir, options.runId);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (existing && !options.resume)
      throw new Error(`Run ${options.runId} already exists; use resume or choose a new run ID.`);
    if (!existing && options.resume)
      throw new Error(`Run ${options.runId} does not exist; cannot resume.`);
    if (
      existing &&
      (existing.workflow.name !== definition.name ||
        existing.workflow.version !== definition.version ||
        existing.workflow.fingerprint !== fingerprint ||
        existing.cwd !== cwd)
    ) {
      throw new Error(
        'Workflow code, schemas, version, name, or working directory changed; start a new run.',
      );
    }
    const input = definition.input.parse(
      options.input === undefined && existing ? existing.input : options.input,
    );
    const savedInput = jsonValue(input);
    if (existing && digest(existing.input) !== digest(savedInput))
      throw new Error('Workflow input changed; start a new run.');
    if (existing?.status === 'completed') {
      const output = definition.output.parse(existing.output);
      return { ...existing, output: output as TOutput & JsonValue };
    }
    const now = new Date().toISOString();
    const record: RunRecord = existing ?? {
      formatVersion: 1,
      id: options.runId,
      workflow: { name: definition.name, version: definition.version, fingerprint },
      cwd,
      input: savedInput,
      output: null,
      status: 'running',
      error: null,
      steps: {},
      createdAt: now,
      updatedAt: now,
    };
    let writeQueue = Promise.resolve();
    function save(): Promise<void> {
      record.updatedAt = new Date().toISOString();
      writeQueue = writeQueue.then(() => writeRun(stateDir, structuredClone(record)));
      return writeQueue;
    }
    const used = new Set<string>();
    const pending = new Set<Promise<unknown>>();
    const inEffect = new AsyncLocalStorage<boolean>();
    let closed = false;
    const emit = (type: WorkflowEvent['type'], id: string, step: StepRecord): void => {
      try {
        options.onEvent?.({ type, runId: record.id, stepId: id, attempt: step.attempts });
      } catch {
        /* Observers must not invalidate committed effects. */
      }
    };

    function launch<T>(
      id: string,
      kind: StepRecord['kind'],
      dependencies: JsonValue,
      schema: z.ZodType<T>,
      retry: RetryPolicy | undefined,
      action: (context: StepContext, step: StepRecord) => Promise<T> | T,
      wakeAt: number | null = null,
    ): Promise<T> {
      const promise = effect(id, kind, dependencies, schema, retry, action, wakeAt);
      pending.add(promise);
      // Track active work without creating unhandled rejected cleanup promises.
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    }

    async function effect<T>(
      id: string,
      kind: StepRecord['kind'],
      dependencies: JsonValue,
      schema: z.ZodType<T>,
      retry: RetryPolicy | undefined,
      action: (context: StepContext, step: StepRecord) => Promise<T> | T,
      wakeAt: number | null,
    ): Promise<T> {
      if (closed) throw new Error('Workflow is closed; await all workflow operations.');
      if (inEffect.getStore())
        throw new Error(
          'Nested durable steps are unsupported; compose steps in the workflow body.',
        );
      signal.throwIfAborted();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id))
        throw new Error('Step ID must be 1–200 characters, starting with a letter or number.');
      if (used.has(id))
        throw new Error(`Duplicate step ID: ${id}. Use a unique ID for each loop iteration.`);
      used.add(id);
      const maxAttempts = retry?.maxAttempts ?? 1;
      const delayMs = retry?.delayMs ?? 100;
      if (
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        !Number.isFinite(delayMs) ||
        delayMs < 0
      ) {
        throw new Error(
          'Retry policy requires positive integer maxAttempts and a nonnegative finite delayMs.',
        );
      }
      const stepFingerprint = digest({
        kind,
        dependencies,
        schema: schemaJson(schema),
        retry: { maxAttempts, delayMs },
      });
      const prior = Object.hasOwn(record.steps, id) ? record.steps[id] : undefined;
      if (prior && (prior.kind !== kind || prior.fingerprint !== stepFingerprint)) {
        throw new Error(`Step ${id} changed inputs, options, kind, or schema; start a new run.`);
      }
      if (prior?.status === 'completed') {
        const output = schema.parse(structuredClone(prior.output));
        emit('step.replayed', id, prior);
        return output;
      }
      const step: StepRecord = prior ?? {
        kind,
        fingerprint: stepFingerprint,
        status: 'running',
        attempts: 0,
        output: null,
        error: null,
        wakeAt,
      };
      Object.defineProperty(record.steps, id, {
        value: step,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        step.attempts++;
        step.status = 'running';
        step.error = null;
        await save();
        emit('step.started', id, step);
        try {
          const result = await inEffect.run(true, () =>
            action(
              {
                signal,
                idempotencyKey: `${record.id}/${id}`,
                attempt: step.attempts,
              },
              step,
            ),
          );
          signal.throwIfAborted();
          const output = schema.parse(result);
          step.output = jsonValue(output);
          step.status = 'completed';
          await save();
          emit('step.completed', id, step);
          return schema.parse(structuredClone(step.output));
        } catch (error) {
          step.status = 'failed';
          step.error = message(error);
          if (error instanceof HarnessError) {
            (step.failedAttempts ??= []).push({
              attempt: step.attempts,
              sessionId: error.sessionId,
              usage: error.usage,
            });
          }
          await save();
          emit('step.failed', id, step);
          if (signal.aborted || attempt >= maxAttempts) throw error;
          await waitUntil(Date.now() + Math.min(30_000, delayMs * 2 ** (attempt - 1)), signal);
        }
      }
    }

    function client<TOptions extends AgentOptions>(
      provider: 'claude' | 'codex',
    ): AgentClient<TOptions> {
      async function invoke<T>(
        id: string,
        agentOptions: TOptions,
        schema: z.ZodType<T>,
        structured: boolean,
      ): Promise<AgentResult<T>> {
        const initialRequest: HarnessRequest = {
          provider,
          options: agentOptions,
          cwd: resolve(cwd, agentOptions.cwd ?? '.'),
          outputSchema: structured ? schemaJson(schema) : null,
        };
        // Keep execution and its fingerprint identical if the caller mutates its options later.
        const request = jsonValue(initialRequest) as unknown as HarnessRequest;
        const resultSchema = z.object({
          output: schema,
          sessionId: z.string().nullable(),
          usage: z.object({
            inputTokens: z.number().nullable(),
            outputTokens: z.number().nullable(),
            costUsd: z.number().nullable(),
          }),
        });
        return launch(id, provider, jsonValue(request), resultSchema, undefined, async () => {
          if (!options.harness)
            throw new Error(
              `No harness adapter configured for ${provider}. Supply RunOptions.harness.`,
            );
          const response = await options.harness.invoke(request, signal);
          const raw: unknown = structured ? JSON.parse(response.text) : response.text;
          return {
            output: schema.parse(raw),
            sessionId: response.sessionId,
            usage: response.usage,
          };
        });
      }
      return {
        text: (id, agentOptions) => invoke(id, agentOptions, z.string(), false),
        object: (id, agentOptions) => {
          const { schema, ...rest } = agentOptions;
          return invoke(id, rest as unknown as TOptions, schema, true);
        },
      };
    }

    const context: WorkflowContext = {
      runId: record.id,
      signal,
      claude: client<ClaudeOptions>('claude'),
      codex: client<CodexOptions>('codex'),
      step: <T>(id: string, step: StepDefinition<T>): Promise<T> =>
        launch(id, 'step', step.input, step.schema, step.retry, step.run),
      sleep: (id, milliseconds) => {
        if (
          !Number.isFinite(milliseconds) ||
          milliseconds < 0 ||
          milliseconds > Number.MAX_SAFE_INTEGER - Date.now()
        ) {
          return Promise.reject(
            new Error('Sleep duration must be a finite nonnegative safe duration.'),
          );
        }
        return launch(
          id,
          'sleep',
          milliseconds,
          z.null(),
          undefined,
          async (_context, step) => {
            await waitUntil(step.wakeAt ?? Date.now(), signal);
            return null;
          },
          Date.now() + milliseconds,
        );
      },
      map: async <T, U>(
        items: readonly T[],
        concurrency: number,
        mapper: (item: T, index: number) => Promise<U>,
      ): Promise<U[]> => {
        if (!Number.isInteger(concurrency) || concurrency < 1)
          throw new Error('Map concurrency must be a positive integer.');
        const results: U[] = new Array<U>(items.length);
        let next = 0;
        const state: { failed: boolean; error: unknown } = { failed: false, error: undefined };
        const fail = (error: unknown): void => {
          if (state.failed) return;
          state.failed = true;
          state.error = error;
          // A sibling may itself be waiting for cancellation. Abort before draining it.
          controller.abort(error);
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (!state.failed) {
              try {
                signal.throwIfAborted();
                const index = next++;
                if (index >= items.length) return;
                results[index] = await mapper(items[index] as T, index);
              } catch (error) {
                fail(error);
              }
            }
          }),
        );
        if (state.failed) throw state.error;
        return results;
      },
    };
    record.status = 'running';
    record.error = null;
    await save();
    try {
      signal.throwIfAborted();
      const output = await definition.run(context, input);
      const remaining = await Promise.allSettled([...pending]);
      const failure = remaining.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      closed = true;
      signal.throwIfAborted();
      const missing = Object.keys(record.steps).filter((id) => !used.has(id));
      if (missing.length)
        throw new Error(
          `Replay skipped recorded steps (${missing.join(', ')}); workflow control flow changed.`,
        );
      record.output = jsonValue(definition.output.parse(output));
      record.status = 'completed';
      await save();
      return {
        ...structuredClone(record),
        output: definition.output.parse(structuredClone(record.output)) as TOutput & JsonValue,
      };
    } catch (error) {
      closed = true;
      controller.abort(error);
      await Promise.allSettled([...pending]);
      record.status = 'failed';
      record.error = message(error);
      await save();
      throw error;
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await release();
  }
}

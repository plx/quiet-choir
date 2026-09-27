import { jsonValue, digest } from './json.js';
import { validateStepId } from './identity.js';
import {
  CancelledError,
  FanOutError,
  type FanOutFailure,
  type FailureOrigins,
  type MapStepError,
} from './fan-out.js';
import type { ExecutionScopes } from './scopes.js';
import type { OperationTracker } from './tracking.js';
import { errorKind, stepError } from './step-error.js';
import type { JsonValue, Settled, SettledMapOptions, WorkflowContext } from './model.js';
import type { MapRecord, RunRecord, StepRecord } from './store.js';

/** Owned map execution dependencies; never part of the public workflow API. @internal */
interface MapDependencies {
  readonly isClosed: () => boolean;
  readonly isInEffect: () => boolean;
  readonly launch: <T>(
    id: string,
    work: () => T | PromiseLike<T>,
    effectOperation?: boolean,
  ) => Promise<T>;
  readonly scopes: ExecutionScopes;
  readonly operations: OperationTracker;
  readonly origins: FailureOrigins;
  readonly cwd: string;
  readonly record: RunRecord;
  readonly maps: Record<string, MapRecord>;
  readonly used: Set<string>;
  readonly visitedMaps: Set<string>;
  readonly save: () => Promise<void>;
  /** Whether an error is this run's own checkpoint failure, not a domain error reusing the class. */
  readonly isCheckpointFailure: (error: unknown) => boolean;
  readonly replayed: (id: string, step: StepRecord) => void;
}

/** Build scoped fan-out with an optional explicit durable item journal. @internal */
export function createMap(dependencies: MapDependencies): WorkflowContext['map'] {
  const {
    isClosed,
    isInEffect,
    launch,
    scopes,
    operations,
    origins,
    cwd,
    record,
    maps,
    used,
    visitedMaps,
    save,
    isCheckpointFailure,
    replayed,
  } = dependencies;
  function validationError(message: string): Error {
    const error = new Error(message);
    origins.markFatal(error);
    return error;
  }
  function jsonData(items: unknown): JsonValue {
    try {
      return jsonValue(items);
    } catch (error) {
      origins.markFatal(error);
      throw error;
    }
  }
  function map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
    settings?: { readonly onError?: 'abort' | 'drain' },
  ): Promise<U[]>;
  function map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
    settings: SettledMapOptions,
  ): Promise<Settled<U, MapStepError>[]>;
  function map<T, U>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
    settings: { readonly onError?: 'abort' | 'drain' } | SettledMapOptions = {},
  ): Promise<U[] | Settled<U, MapStepError>[]> {
    return launch(
      'map',
      async () => {
        if (isClosed()) throw validationError('Workflow is closed; await all workflow operations.');
        if (isInEffect())
          throw validationError('Do not nest workflow operations inside a local effect callback.');
        if (!Number.isInteger(concurrency) || concurrency < 1)
          throw validationError('Map concurrency must be a positive integer.');
        if (!Array.isArray(items) || typeof mapper !== 'function')
          throw validationError('Map requires an array and a mapper callback.');
        // Fix scheduling to the items present at call time; later caller edits cannot add work.
        let snapshot: readonly T[] = Array.from<T>(items);
        const policy = settings.onError ?? 'drain';
        if (!['abort', 'drain', 'settle'].includes(policy))
          throw validationError('Map onError must be abort, drain, or settle.');
        const controller = new AbortController();
        const mapSignal = AbortSignal.any([scopes.signal, controller.signal]);
        mapSignal.throwIfAborted();
        const mapScope = scopes.create(mapSignal);
        let journal: MapRecord | undefined;
        if (settings.onError === 'settle') {
          if (typeof settings.id !== 'string')
            throw validationError('Settled maps require a stable id to journal item outcomes.');
          try {
            validateStepId(settings.id);
          } catch (error) {
            origins.markFatal(error);
            throw error;
          }
          if (
            settings.version !== undefined &&
            (typeof settings.version !== 'string' || !settings.version.trim())
          )
            throw validationError('Map version must be a nonempty string.');
          if (visitedMaps.has(settings.id))
            throw validationError(`Duplicate settled map ID: ${settings.id}.`);
          visitedMaps.add(settings.id);
          scopes.map(settings.id);
          // Fingerprint, journal, and process one detached JSON copy of the items.
          const data = jsonData(items) as JsonValue[];
          snapshot = data as readonly unknown[] as readonly T[];
          const fingerprint = digest({
            items: data,
            mapper: Function.prototype.toString.call(mapper),
            version: settings.version ?? null,
            cwd,
          });
          journal = Object.hasOwn(maps, settings.id) ? maps[settings.id] : undefined;
          if (journal && journal.fingerprint !== fingerprint) {
            if (
              journal.status === 'completed' ||
              journal.items.some((item) => item.status === 'completed')
            )
              throw validationError(
                `Settled map ${settings.id} changed after an item completed; fork a new run.`,
              );
            journal = undefined;
          }
          journal ??= {
            fingerprint,
            status: 'running',
            items: data.map(() => ({ status: 'running', outcome: null, steps: [], maps: [] })),
          };
          Object.defineProperty(maps, settings.id, {
            value: journal,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          await save();
        }
        const saved = journal;
        const results: (U | Settled<U, MapStepError>)[] = new Array<U | Settled<U, MapStepError>>(
          snapshot.length,
        );
        const failures: FanOutFailure[] = [];
        let fatal: { error: unknown } | undefined;
        let next = 0;
        const fail = (index: number, error: unknown): void => {
          const origin = origins.find(error);
          failures.push({ index, stepId: origin.stepId, error });
          if (policy === 'abort' && failures.length === 1)
            controller.abort(new CancelledError(origin.stepId, error, 'map'));
        };
        await scopes.run(mapScope, () =>
          Promise.all(
            Array.from({ length: Math.min(concurrency, snapshot.length) }, async () => {
              while (fatal === undefined && (policy === 'settle' || failures.length === 0)) {
                if (mapSignal.aborted) break;
                const index = next++;
                if (index >= snapshot.length) return;
                const itemScope = scopes.create(mapSignal);
                await scopes.run(itemScope, async () => {
                  const item = saved?.items[index];
                  try {
                    if (item?.status === 'completed') {
                      for (const id of item.steps) {
                        if (used.has(id))
                          throw validationError(
                            `Duplicate step ID: ${id} while replaying settled map.`,
                          );
                        used.add(id);
                        scopes.step(id);
                        const step = record.steps[id];
                        if (step) replayed(id, step);
                      }
                      for (const id of item.maps) {
                        if (visitedMaps.has(id))
                          throw validationError(`Duplicate settled map ID: ${id}.`);
                        visitedMaps.add(id);
                        scopes.map(id);
                      }
                      results[index] = structuredClone(item.outcome) as Settled<U, MapStepError>;
                      return;
                    }
                    let output: U | undefined;
                    let rejected: { error: unknown } | undefined;
                    try {
                      output = await mapper(snapshot[index] as T, index);
                    } catch (error) {
                      rejected = { error };
                    }
                    if (policy !== 'settle' && rejected !== undefined) fail(index, rejected.error);
                    // Own and drain the mapper's launched descendants before journaling its result.
                    await operations.drain(itemScope);
                    try {
                      operations.assertObserved(itemScope);
                    } catch (error) {
                      origins.markFatal(error);
                      throw error;
                    }
                    if (rejected !== undefined) throw rejected.error;
                    mapSignal.throwIfAborted();
                    if (saved && item) {
                      item.outcome = { ok: true, value: jsonData(output) };
                      item.status = 'completed';
                      item.steps = [...itemScope.steps].filter((id) =>
                        Object.hasOwn(record.steps, id),
                      );
                      item.maps = [...itemScope.maps].filter((id) => Object.hasOwn(maps, id));
                      await save();
                      results[index] = structuredClone(item.outcome) as Settled<U, MapStepError>;
                    } else results[index] = output as U;
                  } catch (error) {
                    if (
                      saved &&
                      item?.status === 'running' &&
                      !mapSignal.aborted &&
                      errorKind(error) !== 'cancelled' &&
                      !isCheckpointFailure(error) &&
                      !origins.isFatal(error)
                    ) {
                      const origin = origins.find(error);
                      item.outcome = {
                        ok: false,
                        error: {
                          ...stepError(
                            origin.error,
                            origin.stepId === null
                              ? 1
                              : (record.steps[origin.stepId]?.attempts ?? 1),
                          ),
                          stepId: origin.stepId,
                        },
                      };
                      item.status = 'completed';
                      item.steps = [...itemScope.steps].filter((id) =>
                        Object.hasOwn(record.steps, id),
                      );
                      item.maps = [...itemScope.maps].filter((id) => Object.hasOwn(maps, id));
                      try {
                        await save();
                      } catch {
                        fatal ??= { error };
                        return;
                      }
                      results[index] = structuredClone(item.outcome);
                    } else if (policy === 'settle') fatal ??= { error };
                    else if (!failures.some((failure) => failure.index === index))
                      fail(index, error);
                  }
                });
              }
            }),
          ),
        );
        if (fatal !== undefined) throw fatal.error;
        if (failures.length)
          throw new FanOutError(
            policy === 'abort' ? 'abort' : 'drain',
            failures,
            Array.from({ length: Math.max(0, snapshot.length - next) }, (_, index) => next + index),
          );
        mapSignal.throwIfAborted();
        if (saved) {
          saved.status = 'completed';
          await save();
        }
        return results as U[] | Settled<U, MapStepError>[];
      },
      false,
    );
  }

  return map;
}

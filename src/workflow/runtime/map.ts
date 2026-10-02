import { jsonValue, digest } from './json.js';
import { validateStepId, displayId, duplicateStepId } from './identity.js';
import {
  CancelledError,
  FanOutError,
  type FanOutFailure,
  type FailureOrigins,
  type MapStepError,
} from './fan-out.js';
import type { ExecutionScopes } from './scopes.js';
import type { NameScopes } from './names.js';
import type { OperationTracker } from './tracking.js';
import { errorKind, stepError } from './step-error.js';
import type {
  JsonValue,
  Settled,
  SettledMapOptions,
  MapOptions,
  SettledNamedMapOptions,
  WorkflowContext,
} from './model.js';
import type { MapRecord, RunRecord, StepRecord } from './store.js';

/** Owned map execution dependencies; never part of the public workflow API. @internal */
interface MapDependencies {
  readonly isClosed: () => boolean;
  readonly isInEffect: () => boolean;
  readonly launch: <T>(
    id: string,
    work: () => T | PromiseLike<T>,
    /** Call-site effect kind, or null for a map, scope, phase or child operation. */
    effect: string | null,
  ) => Promise<T>;
  readonly scopes: ExecutionScopes;
  readonly names: NameScopes;
  readonly operations: OperationTracker;
  readonly origins: FailureOrigins;
  readonly cwd: string;
  readonly record: RunRecord;
  readonly maps: Record<string, MapRecord>;
  readonly used: Set<string>;
  readonly visitedMaps: Set<string>;
  readonly save: () => Promise<void>;
  /** Allocate the next run-wide first-use ordering value, shared with leaf steps. */
  readonly nextSeq: () => number;
  /** Whether an error is this run's own checkpoint failure, not a domain error reusing the class. */
  readonly isCheckpointFailure: (error: unknown) => boolean;
  readonly replayed: (id: string, step: StepRecord) => void;
  readonly replayChild: (id: string) => void;
}

/** Build scoped fan-out with an optional explicit durable item journal. @internal */
export function createMap(dependencies: MapDependencies): WorkflowContext['map'] {
  const {
    isClosed,
    isInEffect,
    launch,
    scopes,
    names,
    operations,
    origins,
    cwd,
    record,
    maps,
    used,
    visitedMaps,
    save,
    nextSeq,
    isCheckpointFailure,
    replayed,
    replayChild,
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
    id: string,
    items: readonly T[],
    options: MapOptions<T>,
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<U[]>;
  function map<T, U>(
    id: string,
    items: readonly T[],
    options: SettledNamedMapOptions<T>,
    mapper: (item: T, index: number) => Promise<U>,
  ): Promise<Settled<U, MapStepError>[]>;
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
    first: string | readonly T[],
    second: readonly T[] | number,
    third: MapOptions<T> | SettledNamedMapOptions<T> | ((item: T, index: number) => Promise<U>),
    fourth:
      | { readonly onError?: 'abort' | 'drain' }
      | SettledMapOptions
      | ((item: T, index: number) => Promise<U>) = {},
  ): Promise<U[] | Settled<U, MapStepError>[]> {
    const parentPath = names.path;
    return launch(
      'map',
      async () => {
        const named = typeof first === 'string';
        const items = (named ? second : first) as readonly T[];
        const rawSettings: unknown = named ? third : fourth;
        if (rawSettings === null || typeof rawSettings !== 'object')
          throw validationError(
            named
              ? 'Map options must be an object.'
              : 'Map options must be an object when provided.',
          );
        const settings = rawSettings as
          MapOptions<T> | SettledNamedMapOptions<T> | SettledMapOptions;
        const concurrency = named ? (settings as MapOptions<T>).concurrency : (second as number);
        const mapper = (named ? fourth : third) as (item: T, index: number) => Promise<U>;
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
        let journalId: string | undefined;
        let itemPaths: string[] | undefined;
        let keys: string[] | undefined;
        try {
          if (named) {
            const prefix = names.prefix(first);
            const key = (settings as MapOptions<T>).key;
            if (key !== undefined && typeof key !== 'function')
              throw new Error('Map key must be a function.');
            const seen = new Set<string>();
            keys = Array.from<T, string>(snapshot, (item, index) => {
              const value = key === undefined ? String(index) : key(item, index);
              try {
                validateStepId(value, { scope: prefix, leaf: value });
                validateStepId(prefix + value, { scope: prefix, leaf: value });
              } catch (cause) {
                throw new Error(
                  `Invalid map key ${typeof value === 'string' ? displayId(value) : String(value)} at index ${String(index)}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                );
              }
              if (seen.has(value))
                throw new Error(
                  `Duplicate map key ${displayId(value)} (scope ${displayId(prefix)}). Provide a unique key for every item.`,
                );
              seen.add(value);
              return value;
            });
            itemPaths = keys.map((key) => `${prefix}${key}/`);
            journalId = names.qualify(first);
          } else if (settings.onError === 'settle') {
            const id = (settings as SettledMapOptions).id;
            if (typeof id !== 'string')
              throw new Error('Settled maps require a stable id to journal item outcomes.');
            journalId = names.qualify(id);
            validateStepId(journalId, names.describe(journalId));
          }
        } catch (error) {
          origins.markFatal(error);
          throw error;
        }
        const controller = new AbortController();
        const mapSignal = AbortSignal.any([scopes.signal, controller.signal]);
        mapSignal.throwIfAborted();
        const mapScope = scopes.create(mapSignal, settings.onError === 'settle');
        let journal: MapRecord | undefined;
        if (settings.onError === 'settle' && journalId !== undefined) {
          if (
            settings.version !== undefined &&
            (typeof settings.version !== 'string' || !settings.version.trim())
          )
            throw validationError('Map version must be a nonempty string.');
          if (visitedMaps.has(journalId))
            throw validationError(`Duplicate settled map ID: ${journalId}.`);
          if (record.children?.[journalId])
            throw validationError(`Settled map ${journalId} collides with a recorded child frame.`);
          visitedMaps.add(journalId);
          scopes.map(journalId);
          // Fingerprint, journal, and process one detached JSON copy of the items.
          const data = jsonData(snapshot) as JsonValue[];
          snapshot = data as readonly unknown[] as readonly T[];
          const fingerprint = digest({
            items: data,
            mapper: Function.prototype.toString.call(mapper),
            version: settings.version ?? null,
            cwd,
            ...(keys === undefined ? {} : { keys }),
          });
          journal = Object.hasOwn(maps, journalId) ? maps[journalId] : undefined;
          if (journal && journal.fingerprint !== fingerprint) {
            if (
              journal.status === 'completed' ||
              journal.items.some((item) => item.status === 'completed')
            )
              throw validationError(
                `Settled map ${journalId} changed after an item completed; fork a new run.`,
              );
            journal = undefined;
          }
          // A reused journal keeps its first-use order; a new or reset one takes the next seq.
          journal ??= {
            fingerprint,
            seq: nextSeq(),
            status: 'running',
            items: data.map(() => ({ status: 'running', outcome: null, steps: [], maps: [] })),
          };
          Object.defineProperty(maps, journalId, {
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
                await scopes.run(itemScope, () =>
                  names.run(itemPaths?.[index] ?? parentPath, async () => {
                    const item = saved?.items[index];
                    try {
                      if (item?.status === 'completed') {
                        for (const id of item.steps) {
                          if (used.has(id))
                            throw validationError(duplicateStepId(id, names.describe(id)).message);
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
                        for (const id of item.children ?? []) replayChild(id);
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
                      if (policy !== 'settle' && rejected !== undefined)
                        fail(index, rejected.error);
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
                        item.children = [...itemScope.children];
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
                        item.children = [...itemScope.children];
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
                  }),
                );
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
      null,
    );
  }

  return map;
}

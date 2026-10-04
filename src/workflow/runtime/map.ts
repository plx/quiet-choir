import { jsonValue, digest } from './json.js';
import { validateStepId, displayId, duplicateStepId } from './identity.js';
import {
  CancelledError,
  FanOutError,
  errorMessage,
  type FanOutFailure,
  type FailureOrigins,
  type MapStepError,
} from './fan-out.js';
import type { ExecutionScopes } from './scopes.js';
import type { NameScopes } from './names.js';
import {
  decideSettledMapReplay,
  mapperOnlyChange,
  settledMapRefusalMessage,
  type MapItemScope,
} from './replay-decision.js';
import type { OperationTracker } from './tracking.js';
import { errorKind } from './step-error.js';
import { ownedRecords, settledFailure, settlesFailure } from './settled-outcome.js';
import type { JsonValue, Settled, MapOptions, WorkflowContext } from './model.js';
import type { MapComponents, MapRecord, RunRecord, StepRecord } from './store.js';

/** Settled map refusals thrown by this module, with whether only the mapper changed. */
const settledMapRefusals = new WeakMap<Error, { readonly mapperOnly: boolean }>();

/**
 * Whether an error is a settled map refusal for a change after an item completed, and whether only
 * the mapper changed (which `acceptCodeChange` would accept). Recovery advice reads it instead of
 * the message text. @internal
 */
export function settledMapChange(error: unknown): { readonly mapperOnly: boolean } | undefined {
  return error instanceof Error ? settledMapRefusals.get(error) : undefined;
}

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
  /** Whether this resume explicitly accepts code changes; a committed map then accepts a mapper-only change. */
  readonly acceptCodeChange: boolean;
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
    acceptCodeChange,
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
  ): Promise<U[] | Settled<U, MapStepError>[]> {
    const parentPath = names.path;
    return launch(
      'map',
      async () => {
        if (typeof id !== 'string')
          throw validationError(
            'Map requires a string ID first: the positional ctx.map(items, concurrency, mapper) form was removed. Use ctx.map(id, items, { concurrency }, mapper).',
          );
        const rawSettings: unknown = options;
        if (rawSettings === null || typeof rawSettings !== 'object')
          throw validationError('Map options must be an object.');
        const settings = rawSettings as MapOptions<T> & {
          readonly onError?: unknown;
          readonly cancelSiblings?: unknown;
        };
        const concurrency = settings.concurrency;
        if (isClosed()) throw validationError('Workflow is closed; await all workflow operations.');
        if (isInEffect())
          throw validationError('Do not nest workflow operations inside a local effect callback.');
        if (!Number.isInteger(concurrency) || concurrency < 1)
          throw validationError('Map concurrency must be a positive integer.');
        if (!Array.isArray(items) || typeof mapper !== 'function')
          throw validationError('Map requires an array and a mapper callback.');
        // Normalize before any journal or identity use. 'settle' is an untyped runtime alias for
        // 'return'; neither enters the fingerprint, so both journal identically (ADR 0008).
        const mode = mapMode(settings.onError);
        if (mode === undefined)
          throw validationError(
            `Map onError must be 'throw' or 'return', not ${describeValue(settings.onError)}. The default drains started mappers after a failure; use cancelSiblings: true to cancel this map's subtree instead.`,
          );
        if (settings.cancelSiblings !== undefined && typeof settings.cancelSiblings !== 'boolean')
          throw validationError('Map cancelSiblings must be a boolean.');
        const cancelSiblings = settings.cancelSiblings === true;
        // Fix scheduling to the items present at call time; later caller edits cannot add work.
        let snapshot: readonly T[] = Array.from<T>(items);
        const policy = cancelSiblings ? 'abort' : 'drain';
        let journalId: string;
        // Named-map items are declared independent; fork prefix reuse reads them (ADR 0006).
        let itemPaths: MapItemScope[];
        let keys: string[];
        try {
          const prefix = names.prefix(id);
          const key = settings.key;
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
          const items = new Set(keys.map((key) => `${prefix}${key}/`));
          itemPaths = [...items].map((item) => ({ map: prefix, item, items }));
          journalId = names.qualify(id);
        } catch (error) {
          origins.markFatal(error);
          throw error;
        }
        // Only this map's controller aborts for cancelSiblings; the parent scope is never cancelled.
        const controller = new AbortController();
        const parentSignal = scopes.signal;
        const mapSignal = AbortSignal.any([parentSignal, controller.signal]);
        mapSignal.throwIfAborted();
        // The settled scope flag follows the journal, not cancelSiblings.
        const mapScope = scopes.create(mapSignal, mode === 'return');
        let journal: MapRecord | undefined;
        if (mode === 'return') {
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
          const source = Function.prototype.toString.call(mapper);
          // The aggregate is unchanged so existing journals keep matching (ADR 0008).
          const fingerprint = digest({
            items: data,
            mapper: source,
            version: settings.version ?? null,
            cwd,
            keys,
          });
          const components: MapComponents = {
            items: digest(data),
            mapper: digest(source),
            version: digest(settings.version ?? null),
            cwd: digest(cwd),
            keys: digest(keys),
          };
          const prior = Object.hasOwn(maps, journalId) ? maps[journalId] : undefined;
          const decision = decideSettledMapReplay({
            saved: prior && {
              fingerprint: prior.fingerprint,
              components: prior.components,
              committed:
                prior.status === 'completed' ||
                prior.items.some((item) => item.status === 'completed'),
            },
            fingerprint,
            components,
            acceptCodeChange,
          });
          switch (decision.kind) {
            case 'refuse':
            case 'refuse-legacy': {
              const error = validationError(settledMapRefusalMessage(journalId, decision));
              settledMapRefusals.set(error, { mapperOnly: mapperOnlyChange(decision) });
              throw error;
            }
            case 'reset':
              break;
            case 'reuse':
              journal = prior;
              if (journal && decision.backfill) journal.components = components;
              break;
            case 'accept':
              journal = prior;
              if (journal) {
                // Record and apply the acceptance in the same save, so it is never repeated.
                (record.codeChanges ??= []).push({
                  at: new Date().toISOString(),
                  from: journal.fingerprint,
                  to: fingerprint,
                  files: [],
                  components: ['mapper'],
                  map: journalId,
                });
                journal.fingerprint = fingerprint;
                journal.components = components;
              }
              break;
          }
          // A reused journal keeps its first-use order; a new or reset one takes the next seq.
          journal ??= {
            fingerprint,
            components,
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
          // A committed failure already cancelled the rest on an earlier run: abort before
          // scheduling, so uncommitted items are journaled as cancelled deterministically.
          const committed = journal.items.find(
            (item) =>
              item.status === 'completed' &&
              item.outcome?.ok === false &&
              item.outcome.error.kind !== 'cancelled',
          )?.outcome;
          if (cancelSiblings && committed?.ok === false)
            controller.abort(
              new CancelledError(committed.error.stepId, new Error(committed.error.message), 'map'),
            );
        }
        const saved = journal;
        // In return mode, cancelSiblings may abort only the map's controller; work still drains
        // and journals until the parent scope itself is cancelled.
        const scopeSignal = mode === 'return' ? parentSignal : mapSignal;
        const results: (U | Settled<U, MapStepError>)[] = new Array<U | Settled<U, MapStepError>>(
          snapshot.length,
        );
        const failures: FanOutFailure[] = [];
        let fatal: { error: unknown } | undefined;
        let next = 0;
        const fail = (index: number, error: unknown): void => {
          const origin = origins.find(error);
          failures.push({ index, stepId: origin.stepId, error });
          if (cancelSiblings && failures.length === 1)
            controller.abort(new CancelledError(origin.stepId, error, 'map'));
        };
        await scopes.run(mapScope, () =>
          Promise.all(
            Array.from({ length: Math.min(concurrency, snapshot.length) }, async () => {
              while (fatal === undefined && (mode === 'return' || failures.length === 0)) {
                if (scopeSignal.aborted) break;
                const index = next++;
                if (index >= snapshot.length) return;
                const itemScope = scopes.create(mapSignal);
                await scopes.run(itemScope, () =>
                  names.run(itemPaths[index] ?? parentPath, async () => {
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
                      if (saved && item && controller.signal.aborted && !parentSignal.aborted) {
                        // An unstarted item after this map's own cancellation: no attempt started.
                        item.outcome = {
                          ok: false,
                          error: {
                            message: errorMessage(controller.signal.reason),
                            kind: 'cancelled',
                            attempts: 0,
                            stepId: null,
                          },
                        };
                        item.status = 'completed';
                        item.steps = [];
                        item.maps = [];
                        item.children = [];
                        try {
                          await save();
                        } catch (error) {
                          fatal ??= { error };
                          return;
                        }
                        results[index] = structuredClone(item.outcome);
                        return;
                      }
                      let output: U | undefined;
                      let rejected: { error: unknown } | undefined;
                      try {
                        output = await mapper(snapshot[index] as T, index);
                      } catch (error) {
                        rejected = { error };
                      }
                      if (mode === 'throw' && rejected !== undefined) fail(index, rejected.error);
                      // Own and drain the mapper's launched descendants before journaling its result.
                      await operations.drain(itemScope);
                      try {
                        operations.assertObserved(itemScope);
                      } catch (error) {
                        origins.markFatal(error);
                        throw error;
                      }
                      if (rejected !== undefined) throw rejected.error;
                      // A valid result resolved after this map's own abort still commits (ADR 0008).
                      scopeSignal.throwIfAborted();
                      if (saved && item) {
                        item.outcome = { ok: true, value: jsonData(output) };
                        item.status = 'completed';
                        Object.assign(item, ownedRecords(itemScope, record));
                        await save();
                        results[index] = structuredClone(item.outcome) as Settled<U, MapStepError>;
                      } else results[index] = output as U;
                    } catch (error) {
                      if (
                        saved &&
                        item?.status === 'running' &&
                        settlesFailure(error, {
                          parentAborted: parentSignal.aborted,
                          // Only this map's own cancelSiblings cancellation becomes item data.
                          ownCancellation: controller.signal.aborted,
                          checkpointFailure: isCheckpointFailure(error),
                          origins,
                        })
                      ) {
                        // A cancelled leaf keeps its own step: the cause chain leads to the
                        // initiating failure, which must not be attributed to this item.
                        const origin =
                          errorKind(error) === 'cancelled'
                            ? { error, stepId: origins.exact(error) }
                            : origins.find(error);
                        item.outcome = settledFailure(origin, record);
                        item.status = 'completed';
                        Object.assign(item, ownedRecords(itemScope, record));
                        try {
                          await save();
                        } catch {
                          fatal ??= { error };
                          return;
                        }
                        results[index] = structuredClone(item.outcome);
                        if (cancelSiblings && !controller.signal.aborted)
                          controller.abort(new CancelledError(origin.stepId, origin.error, 'map'));
                      } else if (mode === 'return') fatal ??= { error };
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
            policy,
            failures,
            Array.from({ length: Math.max(0, snapshot.length - next) }, (_, index) => next + index),
          );
        scopeSignal.throwIfAborted();
        if (saved) {
          saved.status = 'completed';
          await save();
        }
        return results as U[] | Settled<U, MapStepError>[];
      },
      null,
    );
  }

  return map as WorkflowContext['map'];
}

/** Normalize a map's onError, or undefined for an invalid value. */
function mapMode(value: unknown): 'throw' | 'return' | undefined {
  if (value === undefined || value === 'throw') return 'throw';
  if (value === 'return' || value === 'settle') return 'return';
  return undefined;
}

/** Show an invalid option value in a validation message. */
function describeValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * Team-free control flow over durable effects: {@link untilDry} repeats a discovery round until it
 * stops finding anything new, {@link waves} runs items in dependency order as settled maps, and
 * {@link each} is a settled fan-out that splits results into done and failed items.
 *
 * Each helper takes a required `id` and records its effects under it, and runs the caller's
 * callbacks inside deterministic scopes, so a resume replays the same steps. {@link waves} and
 * {@link each} pass the caller's function itself to `ctx.map` as the mapper, so the settled map's
 * fingerprint covers that function's source; their items must be plain lossless JSON.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const hunt = await std.flow.untilDry(ctx, {
 *   id: 'hunt',
 *   rounds: 4,
 *   key: std.data.findingKey,
 *   round: async (n, known) => {
 *     const report = await ctx.roster.Finder.value('find', {
 *       prompt: `Find bugs not in this list:\n${std.exec.json(known)}`,
 *       schema: std.types.Findings,
 *     });
 *     return { found: report.findings };
 *   },
 * });
 * ```
 *
 * @module
 */
import type { MapStepError, WorkflowContext } from '../index.js';
import { fresh, topoWaves, uniqueKeys } from './data.js';
import { DEFAULT_CONCURRENCY, positiveInt } from './pattern-kit.js';

/** What one {@link untilDry} round reports. */
export interface UntilDryRound<T> {
  /** The items the round found; items already known are dropped by key. */
  readonly found: readonly T[];
  /**
   * How many of the round's sources failed (for example settled agent calls that returned an
   * error). A round with failures is never dry and restarts the count of consecutive dry rounds.
   * Defaults to 0.
   */
  readonly failed?: number | undefined;
}

/** Options of {@link untilDry}. */
export interface UntilDryOptions<T> {
  /** The scope for every step the rounds record. */
  readonly id: string;
  /** The most rounds to run, a positive integer. */
  readonly rounds: number;
  /** How many consecutive dry rounds end the loop, a positive integer; defaults to 2. */
  readonly patience?: number | undefined;
  /** An item's identity for deduplication across rounds, such as `std.data.findingKey`. */
  readonly key: (item: T) => string;
  /**
   * Run round `n` (from 0) given everything found so far; it runs under the scope
   * `<id>/round/<n>`, so fixed leaves inside it are unique per round.
   */
  readonly round: (n: number, known: readonly T[]) => Promise<UntilDryRound<T>>;
}

/** Result of {@link untilDry}. */
export interface UntilDryResult<T> {
  /** Every distinct item found, in discovery order (the first occurrence of each key). */
  readonly found: T[];
  /** How many rounds ran. */
  readonly rounds: number;
  /** How many rounds found nothing new without a failure. */
  readonly dryRounds: number;
  /** How many rounds reported a failure. */
  readonly failedRounds: number;
  /** `'dry'` when `patience` consecutive dry rounds ended the loop, else `'round-limit'`. */
  readonly status: 'dry' | 'round-limit';
}

/**
 * Repeat a discovery round until it runs dry. Round `n` runs `options.round(n, known)` under
 * `ctx.scope(id)` and then `ctx.scope(ctx.id('round', n))`, so its effects record as
 * `<id>/round/<n>/<leaf>`. The round's items are deduplicated by `key` against everything seen in
 * earlier rounds (and within the round); a round is dry when it adds nothing and reports no
 * failure, so a failed source never ends the loop early. The loop stops after `patience`
 * consecutive dry rounds or after `rounds` rounds, whichever comes first.
 *
 * The loop decides only from the rounds' results, so when every round is built from durable
 * effects a resume replays the same rounds without new calls.
 *
 * @typeParam T - The item type.
 * @param ctx - The workflow context.
 * @param options - The scope, the round limit, the patience, the key and the round callback.
 * @returns The distinct items found, round counts and why the loop stopped.
 * @throws TypeError - When `rounds` or `patience` is not a positive integer, or a round returns no
 * `found` array or an invalid `failed` count.
 */
export async function untilDry<T>(
  ctx: WorkflowContext,
  options: UntilDryOptions<T>,
): Promise<UntilDryResult<T>> {
  const rounds = positiveInt('rounds', options.rounds);
  const patience = positiveInt('patience', options.patience ?? 2);
  const { key, round } = options;
  return ctx.scope(options.id, async () => {
    const seen = new Set<string>();
    const found: T[] = [];
    let ran = 0;
    let dryRounds = 0;
    let failedRounds = 0;
    let streak = 0;
    while (ran < rounds && streak < patience) {
      const n = ran;
      const known = found.slice();
      const result = await ctx.scope(ctx.id('round', n), () => round(n, known));
      if (!Array.isArray(result.found))
        throw new TypeError(`untilDry round ${String(n)} must return { found: [...] }.`);
      const failed = result.failed ?? 0;
      if (!Number.isSafeInteger(failed) || failed < 0) {
        throw new TypeError(
          `untilDry round ${String(n)} returned failed: ${String(failed)}; expected a nonnegative integer.`,
        );
      }
      ran += 1;
      const added = fresh(result.found, seen, key);
      for (const item of added) found.push(item);
      if (failed > 0) {
        failedRounds += 1;
        streak = 0;
      } else if (added.length === 0) {
        dryRounds += 1;
        streak += 1;
      } else {
        streak = 0;
      }
    }
    return {
      found,
      rounds: ran,
      dryRounds,
      failedRounds,
      status: streak >= patience ? 'dry' : 'round-limit',
    };
  });
}

/** Options of {@link waves}. */
export interface WavesOptions<T, U> {
  /** The scope for every wave's settled map. */
  readonly id: string;
  /** The items; each must be plain lossless JSON, since it is a settled map item. */
  readonly items: readonly T[];
  /**
   * An item's unique key, which `dependsOn` refers to. Its map key is `std.data.uniqueKeys` of it:
   * the key itself when it is a clean `ctx.id` segment.
   */
  readonly key: (item: T) => string;
  /** The keys of the items that must succeed before this item runs. */
  readonly dependsOn: (item: T) => readonly string[];
  /** Each wave's mapper bound; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for dependencies the items, keys and `run` source do not show. */
  readonly version?: string | undefined;
  /**
   * Run one item; passed to `ctx.map` as the mapper itself, so its source is fingerprinted. Its
   * `index` is the item's position among the items its wave runs, not in `items`.
   */
  readonly run: (item: T, index: number) => Promise<U>;
}

/** One item's outcome in {@link waves}. */
export interface WaveItem<T, U> {
  /** The item's key, as `key` returned it. */
  readonly key: string;
  /** The item. */
  readonly item: T;
  /** `'done'` or `'failed'` after running, or `'skipped'` when a dependency did not succeed. */
  readonly status: 'done' | 'failed' | 'skipped';
  /** The value `run` returned, or null unless `status` is `'done'`. */
  readonly value: U | null;
  /** The settled failure, or null unless `status` is `'failed'`. */
  readonly error: MapStepError | null;
}

/** Result of {@link waves}. */
export interface WavesResult<T, U> {
  /** Every item's outcome, in input order. */
  readonly results: WaveItem<T, U>[];
  /** The planned waves as item keys, in run order; skipped items stay in their wave. */
  readonly waves: string[][];
  /** `'complete'` when every item is done, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/**
 * Run items in dependency waves. The waves are planned with `std.data.topoWaves` before anything
 * runs; wave `n` is the settled map `ctx.map(ctx.id('wave', n), ...)` under `ctx.scope(id)`,
 * keyed by item key, so an item's effects record as `<id>/wave/<n>/<key>/<leaf>`. An item runs
 * only when all of its dependencies are done: a dependent of a failed or skipped item is skipped
 * without running, and a wave with nothing left to run records no map. Failures are journaled by
 * the settled maps, so a resume skips the same items again.
 *
 * @typeParam T - The item type.
 * @typeParam U - The value `run` returns.
 * @param ctx - The workflow context.
 * @param options - The scope, the items with their keys and dependencies, and the runner.
 * @returns Every item's outcome, the planned waves and the overall status.
 * @throws Error - Before any effect, `Invalid dependencies: ...` for duplicate keys, unknown
 * dependencies or a cycle, and a `TypeError` for an invalid `concurrency`.
 */
export async function waves<T, U>(
  ctx: WorkflowContext,
  options: WavesOptions<T, U>,
): Promise<WavesResult<T, U>> {
  const concurrency = positiveInt('concurrency', options.concurrency ?? DEFAULT_CONCURRENCY);
  const { version, run } = options;
  const nodes = options.items.map((item, index) => ({
    item,
    index,
    key: options.key(item),
    deps: options.dependsOn(item).slice(),
  }));
  const planned = topoWaves(
    nodes,
    (node) => node.key,
    (node) => node.deps,
  );
  const mapKeys = uniqueKeys(nodes.map((node) => node.key));
  return ctx.scope(options.id, async () => {
    const state = new Map<string, WaveItem<T, U>['status']>();
    const outcomes = new Map<number, WaveItem<T, U>>();
    for (const [n, wave] of planned.entries()) {
      const runnable = [];
      for (const node of wave) {
        if (node.deps.every((dep) => state.get(dep) === 'done')) {
          runnable.push(node);
        } else {
          state.set(node.key, 'skipped');
          outcomes.set(node.index, {
            key: node.key,
            item: node.item,
            status: 'skipped',
            value: null,
            error: null,
          });
        }
      }
      if (runnable.length === 0) continue;
      const keys = runnable.map((node) => mapKeys[node.index] ?? String(node.index));
      const settled = await ctx.map(
        ctx.id('wave', n),
        runnable.map((node) => node.item),
        {
          concurrency,
          key: (_item, index) => keys[index] ?? String(index),
          onError: 'return',
          version,
        },
        run,
      );
      for (const [position, node] of runnable.entries()) {
        const result = settled[position];
        if (result === undefined) throw new Error(`Missing settled result for ${node.key}.`);
        const outcome: WaveItem<T, U> = result.ok
          ? { key: node.key, item: node.item, status: 'done', value: result.value, error: null }
          : { key: node.key, item: node.item, status: 'failed', value: null, error: result.error };
        state.set(node.key, outcome.status);
        outcomes.set(node.index, outcome);
      }
    }
    const results = nodes.map((node) => {
      const outcome = outcomes.get(node.index);
      if (outcome === undefined) throw new Error(`Missing wave outcome for ${node.key}.`);
      return outcome;
    });
    return {
      results,
      waves: planned.map((wave) => wave.map((node) => node.key)),
      status: results.every((result) => result.status === 'done') ? 'complete' : 'degraded',
    };
  });
}

/** Options of {@link each}. */
export interface EachOptions<T> {
  /**
   * An item's label; the map key is `std.data.uniqueKeys` of the labels, so arbitrary or repeated
   * labels become distinct clean segments (clean unique labels stay as they are). Omitted, the key
   * is the item's index.
   */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /** The mapper bound; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for dependencies the items, keys and mapper source do not show. */
  readonly version?: string | undefined;
}

/** A successful item of {@link each}. */
export interface EachDone<T, U> {
  /** The item's map key. */
  readonly key: string;
  /** The item. */
  readonly item: T;
  /** The item's position in the input. */
  readonly index: number;
  /** The mapper's value. */
  readonly value: U;
}

/** A failed item of {@link each}. */
export interface EachFailure<T> {
  /** The item's map key. */
  readonly key: string;
  /** The item. */
  readonly item: T;
  /** The item's position in the input. */
  readonly index: number;
  /** The settled failure, replayed on resume without running the item again. */
  readonly error: MapStepError;
}

/** Result of {@link each}. */
export interface EachResult<T, U> {
  /** The successful items, in input order. */
  readonly done: EachDone<T, U>[];
  /** The failed items, in input order. */
  readonly failed: EachFailure<T>[];
  /** `'complete'` when nothing failed, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/**
 * A settled fan-out: `ctx.map(id, items, { ...options, onError: 'return' }, mapper)` with the
 * caller's `mapper` passed as is (so its source is fingerprinted) and the results split into done
 * and failed items. Item `i` records under `<id>/<key>/`, where the key is the index or, with
 * `key`, the item's unique ID-safe label. Each item's whole outcome is journaled, so a resume
 * neither reruns a done item nor retries a failed one.
 *
 * @typeParam T - The item type; items must be plain lossless JSON.
 * @typeParam U - The mapper's value.
 * @param ctx - The workflow context.
 * @param id - The map ID, unique among settled maps in the current scope.
 * @param items - The items.
 * @param options - Optional `key`, `concurrency` (default 4) and `version`.
 * @param mapper - The per-item body.
 * @returns The done and failed items and the status.
 * @throws TypeError - When `concurrency` is not a positive integer.
 */
export async function each<T, U>(
  ctx: WorkflowContext,
  id: string,
  items: readonly T[],
  options: EachOptions<T>,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<EachResult<T, U>> {
  const concurrency = positiveInt('concurrency', options.concurrency ?? DEFAULT_CONCURRENCY);
  const snapshot = items.slice();
  const label = options.key;
  const keys =
    label === undefined
      ? snapshot.map((_item, index) => String(index))
      : uniqueKeys(snapshot.map((item, index) => label(item, index)));
  const settled = await ctx.map(
    id,
    snapshot,
    {
      concurrency,
      key: label === undefined ? undefined : (_item, index) => keys[index] ?? String(index),
      onError: 'return',
      version: options.version,
    },
    mapper,
  );
  const done: EachDone<T, U>[] = [];
  const failed: EachFailure<T>[] = [];
  for (const [index, item] of snapshot.entries()) {
    const result = settled[index];
    const key = keys[index] ?? String(index);
    if (result === undefined) throw new Error(`Missing settled result for ${key}.`);
    if (result.ok) done.push({ key, item, index, value: result.value });
    else failed.push({ key, item, index, error: result.error });
  }
  return { done, failed, status: failed.length === 0 ? 'complete' : 'degraded' };
}

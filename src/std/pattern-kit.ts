/**
 * Shared plumbing for the std pattern modules (`panels`, `revise`, `select`, `aggregate`, `gates`,
 * `investigate`, `edits`) and `flow`. Only {@link CallDefaults} is public, re-exported as
 * `std.patterns.CallDefaults`; the other exports are helpers those modules import directly, so they
 * agree on defaults, option validation and settled-map keys.
 *
 * ```ts
 * import { DEFAULT_CONCURRENCY, keyed, positiveInt, settledMap } from './pattern-kit.js';
 *
 * const seats = positiveInt('seats', options.seats ?? 3);
 * const records = keyed(options.items, options.key).map(({ key, item }) => ({
 *   key,
 *   prompt: std.text.promptText(prompt(item)),
 * }));
 * const verdicts = await ctx.map('verify', records, settledMap(options), (record) =>
 *   team.skeptic.value('verdict', { ...options.calls, prompt: record.prompt, schema }),
 * );
 * ```
 *
 * @module
 */
import type { BoundCallOptions, MapOptions } from '../index.js';
import { uniqueKeys } from './data.js';

/** Options applied to every agent call a pattern makes; the pattern sets the prompt, schema and error mode. */
export type CallDefaults = Omit<BoundCallOptions, 'prompt' | 'onError'>;

/** The `concurrency` a pattern's fan-out uses when the caller gives none. */
export const DEFAULT_CONCURRENCY = 4;

/** A short, unambiguous rendering of an option value for error messages. */
function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Validate a count option such as `rounds`, `seats` or `concurrency`.
 *
 * @param name - The option name, for the message.
 * @param value - The value to check.
 * @returns `value`, when it is a positive safe integer.
 * @throws TypeError - `<name> must be a positive integer; got <value>.`
 */
export function positiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer; got ${show(value)}.`);
  return value;
}

/**
 * Validate a count option that may be zero, such as a cap or a number of extra attempts.
 *
 * @param name - The option name, for the message.
 * @param value - The value to check.
 * @returns `value`, when it is a nonnegative safe integer.
 * @throws TypeError - `<name> must be a nonnegative integer; got <value>.`
 */
export function nonNegativeInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a nonnegative integer; got ${show(value)}.`);
  return value;
}

/** Whether `items` has at least one element, as a tuple type guard. */
function hasItems<T>(items: readonly T[]): items is readonly [T, ...T[]] {
  return items.length > 0;
}

/**
 * Validate a list option that needs at least one element, such as lenses, criteria or the keys of
 * a dynamic `z.enum`.
 *
 * @typeParam T - The element type.
 * @param name - The option name, for the message.
 * @param items - The list to check.
 * @returns `items`, typed as a nonempty tuple (as `z.enum` requires).
 * @throws TypeError - `<name> must not be empty.`
 */
export function nonEmpty<T>(name: string, items: readonly T[]): readonly [T, ...T[]] {
  if (!hasItems(items)) throw new TypeError(`${name} must not be empty.`);
  return items;
}

/** An item with its unique, ID-safe map key, as returned by {@link keyed}. */
export interface Keyed<T> {
  /** The map key: unique among the items and a clean `ctx.id` segment. */
  readonly key: string;
  /** The caller's label the key was made from (the index as text without a `key` function). */
  readonly label: string;
  /** The item. */
  readonly item: T;
  /** The item's position in the input. */
  readonly index: number;
}

/**
 * Pair every item with a unique, ID-safe key before a map starts: the labels from `key` (or the
 * index) go through `std.data.uniqueKeys`, so arbitrary or repeated labels become distinct clean
 * segments and clean unique labels stay as they are.
 *
 * @typeParam T - The item type.
 * @param items - The items.
 * @param key - A label for an item, such as a caller's `key` option; omitted, the index.
 * @returns One {@link Keyed} record per item, in input order.
 */
export function keyed<T>(
  items: readonly T[],
  key?: (item: T, index: number) => string,
): Keyed<T>[] {
  const labels = items.map((item, index) => (key === undefined ? String(index) : key(item, index)));
  const keys = uniqueKeys(labels);
  return items.map((item, index) => ({
    key: keys[index] ?? String(index),
    label: labels[index] ?? String(index),
    item,
    index,
  }));
}

/** The fan-out options a pattern forwards to {@link settledMap}. */
export interface FanOutOptions {
  /** The settled map's mapper bound; defaults to {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number | undefined;
  /** The caller's revision for prompts and schemas the map fingerprint does not show. */
  readonly version?: string | undefined;
}

/**
 * The options of a settled map over records that carry their own `key`: the validated
 * `concurrency` (default {@link DEFAULT_CONCURRENCY}), `key: (record) => record.key`,
 * `onError: 'return'` and the caller's `version`. Pass the result straight to `ctx.map`.
 *
 * @typeParam T - The map's item record, with a unique ID-safe `key` (see {@link keyed}).
 * @param options - The pattern's options; only `concurrency` and `version` are read.
 * @returns Map options in settled mode.
 * @throws TypeError - When `concurrency` is not a positive integer.
 */
export function settledMap<T extends { readonly key: string }>(
  options: FanOutOptions,
): MapOptions<T> & {
  /** Settled mode: the map journals every item outcome and returns `Settled` results. */
  readonly onError: 'return';
} {
  return {
    concurrency: positiveInt('concurrency', options.concurrency ?? DEFAULT_CONCURRENCY),
    key: (record: T) => record.key,
    onError: 'return',
    version: options.version,
  };
}

/**
 * The status of a step that tolerates failures: `'complete'` when nothing failed, else
 * `'degraded'`.
 *
 * @param failed - How many tolerated failures occurred.
 * @returns The status string.
 */
export function statusOf(failed: number): 'complete' | 'degraded' {
  return failed === 0 ? 'complete' : 'degraded';
}

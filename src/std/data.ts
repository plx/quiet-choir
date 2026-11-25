/**
 * Pure data helpers for workflow bodies and the std patterns: settled results ({@link oks},
 * {@link failures}), combined health ({@link health}), voting ({@link majority},
 * {@link threshold}, {@link tally}), deduplication across sources and rounds ({@link dedupeBy},
 * {@link fresh}, {@link corroborate}), ordering and selection ({@link rankBy},
 * {@link bySeverity}, {@link rankCap}, {@link rotate}, {@link chunk}), map keys and checks
 * ({@link uniqueKeys}, {@link assertUnique}, {@link assertDisjoint}, {@link coverage},
 * {@link topoWaves}), and stable hashing ({@link canonicalJson}, {@link digest}). The schemas
 * {@link Health} and {@link Coverage} check the values those helpers return.
 *
 * Nothing here takes a workflow context or records an effect: every function is deterministic in
 * its arguments, so a body may call them freely between durable effects and replay computes the
 * same values. Functions that receive invalid arguments throw a `TypeError` naming the argument.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const votes = await ctx.map('seats', ['s1', 's2', 's3'], { concurrency: 3, onError: 'return' }, ask);
 * const ballots = std.data.oks(votes);
 * const upheld = ballots.filter((ballot) => ballot.yes).length;
 * const verdict = std.data.tally({ upheld, against: ballots.length - upheld, seats: 3 });
 * // verdict.outcome is 'confirmed', 'refuted' or 'undecided'; verdict.missing counts failed seats.
 * ```
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { stepId, z, type Settled } from '../index.js';

/** Severity order used by {@link bySeverity}, most severe first. */
const SEVERITIES: readonly ['critical', 'high', 'medium', 'low'] = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
] as const);

/** The longest clean `ctx.id` segment; {@link uniqueKeys} keeps every key within it. */
const MAX_SEGMENT = 64;

/** A short, unambiguous rendering of an argument for error messages. */
function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Return `value` when it is a safe integer of at least `min`; otherwise throw a `TypeError`. */
function integer(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    const kind = min === 0 ? 'a nonnegative integer' : `an integer of at least ${String(min)}`;
    throw new TypeError(`${name} must be ${kind}; got ${show(value)}.`);
  }
  return value;
}

/**
 * The successful values of settled results, in result order.
 *
 * @typeParam T - The value type of a successful result.
 * @typeParam E - The error type of a failed result.
 * @param results - Settled results, such as those of `ctx.map(..., { onError: 'return' })`.
 * @returns The `value` of every `ok` result.
 */
export function oks<T, E>(results: readonly Settled<T, E>[]): T[] {
  const values: T[] = [];
  for (const result of results) if (result.ok) values.push(result.value);
  return values;
}

/**
 * The errors of failed settled results, in result order.
 *
 * @typeParam T - The value type of a successful result.
 * @typeParam E - The error type of a failed result.
 * @param results - Settled results, such as those of `ctx.map(..., { onError: 'return' })`.
 * @returns The `error` of every result that is not `ok`.
 */
export function failures<T, E>(results: readonly Settled<T, E>[]): E[] {
  const errors: E[] = [];
  for (const result of results) if (!result.ok) errors.push(result.error);
  return errors;
}

/** The schema of a {@link Health}, as every std pattern result schema checks its `status`. */
export const Health: z.ZodEnum<z.util.ToEnum<'complete' | 'degraded'>> = z.enum([
  'complete',
  'degraded',
]);

/**
 * The health of a step that tolerates failures, as every std pattern result's `status` reports it:
 * `'complete'` when nothing it tolerated failed, else `'degraded'`.
 */
export type Health = 'complete' | 'degraded';

/**
 * One input of {@link health}: a failure count, a {@link Health}, or a result that carries one as
 * its `status`, such as any std pattern result.
 */
export type HealthPart =
  | number
  | Health
  | {
      /** The result's health. */
      readonly status: Health;
    };

/** Return `value` when it is a {@link Health}; otherwise throw a `TypeError` naming `name`. */
function healthOf(name: string, value: unknown): Health {
  if (value === 'complete' || value === 'degraded') return value;
  throw new TypeError(`${name} must be 'complete' or 'degraded'; got ${show(value)}.`);
}

/**
 * Combine the health of several steps, such as the patterns a workflow ran and the failures it
 * tolerated itself: `'degraded'` when any part is `'degraded'` (or a result whose `status` is) or a
 * positive failure count, else `'complete'`.
 *
 * ```ts
 * const status = std.data.health(review, verdicts, skipped.length);
 * ```
 *
 * @param parts - Failure counts, healths and results with a `status`; none gives `'complete'`.
 * @returns The combined health.
 * @throws TypeError - When a count is not a nonnegative integer, or a health or a result's
 * `status` is neither `'complete'` nor `'degraded'`.
 */
export function health(...parts: readonly HealthPart[]): Health {
  let degraded = false;
  for (const [index, part] of (parts as readonly unknown[]).entries()) {
    const name = `parts[${String(index)}]`;
    let status: Health;
    if (typeof part === 'number') status = integer(name, part, 0) > 0 ? 'degraded' : 'complete';
    else if (typeof part === 'string') status = healthOf(name, part);
    else if (typeof part === 'object' && part !== null)
      status = healthOf(`${name}.status`, (part as { readonly status?: unknown }).status);
    else {
      throw new TypeError(
        `${name} must be a failure count, a health or a result with a status; got ${show(part)}.`,
      );
    }
    if (status === 'degraded') degraded = true;
  }
  return degraded ? 'degraded' : 'complete';
}

/**
 * How many of a panel's seats must uphold a claim: a strict `'majority'` (more than half), all
 * seats (`'unanimous'`), or an explicit count `{ atLeast: n }` with `1 <= n <= seats`.
 */
export type Rule =
  | 'majority'
  | 'unanimous'
  | {
      /** The fewest upholding seats that confirm, from 1 to the number of seats. */
      readonly atLeast: number;
    };

/**
 * The strict majority of `seats`: `floor(seats / 2) + 1`, so 2 of 3, 3 of 4 and 3 of 5.
 *
 * @param seats - The panel size, a positive integer.
 * @returns The fewest seats that form a majority.
 * @throws TypeError - When `seats` is not a positive integer.
 */
export function majority(seats: number): number {
  return Math.floor(integer('seats', seats, 1) / 2) + 1;
}

/**
 * The number of upholding seats a {@link Rule} needs on a panel of `seats`.
 *
 * @param rule - The rule: `'majority'`, `'unanimous'` or `{ atLeast: n }`.
 * @param seats - The panel size, a positive integer.
 * @returns The threshold, from 1 to `seats`.
 * @throws TypeError - When `seats` is not a positive integer, or the rule is not one of the three
 * forms or its `atLeast` is not an integer from 1 to `seats`.
 */
export function threshold(rule: Rule, seats: number): number {
  integer('seats', seats, 1);
  if (rule === 'majority') return majority(seats);
  if (rule === 'unanimous') return seats;
  // Callers may pass untyped options (JavaScript, parsed JSON), so guard before reading `atLeast`.
  const shape: unknown = rule;
  const atLeast: unknown =
    typeof shape === 'object' && shape !== null
      ? (shape as { readonly atLeast?: unknown }).atLeast
      : undefined;
  if (typeof atLeast === 'number' && Number.isSafeInteger(atLeast) && atLeast >= 1) {
    if (atLeast <= seats) return atLeast;
  }
  throw new TypeError(
    `Invalid vote rule ${JSON.stringify(rule)}: expected 'majority', 'unanimous' or { atLeast: n } with n an integer from 1 to ${String(seats)}.`,
  );
}

/** The outcome of a {@link tally}. */
export type Outcome = 'confirmed' | 'refuted' | 'undecided';

/** The seat counts {@link tally} decides from. */
export interface TallyCounts {
  /** Seats that upheld the claim. */
  readonly upheld: number;
  /** Seats that answered against it. */
  readonly against: number;
  /** The panel size; seats that neither upheld nor answered against are missing (failed). */
  readonly seats: number;
}

/** A decided vote: the outcome and the counts it was decided from. */
export interface Tally {
  /**
   * `'confirmed'` when the upholding seats reach the threshold, `'refuted'` when they cannot reach
   * it even if every missing seat had upheld, else `'undecided'` (missing seats decide it).
   */
  readonly outcome: Outcome;
  /** Seats that upheld the claim. */
  readonly upheld: number;
  /** Seats that answered against it. */
  readonly against: number;
  /** Seats without an answer, such as failed agent calls: `seats - upheld - against`. */
  readonly missing: number;
  /** The panel size. */
  readonly seats: number;
}

/**
 * Decide a vote from its counts under `rule`. With `need = threshold(rule, seats)`, the outcome is
 * `confirmed` when `upheld >= need`, `refuted` when `upheld + missing < need`, and `undecided`
 * otherwise, so a failed seat never counts for either side.
 *
 * @param counts - Upholding and opposing seats and the panel size.
 * @param rule - The {@link Rule}; defaults to `'majority'`.
 * @returns The outcome with the counts, including the derived `missing`.
 * @throws TypeError - When a count is not a nonnegative integer, `seats` is not positive,
 * `upheld + against` exceeds `seats`, or the rule is invalid for `seats`.
 */
export function tally(counts: TallyCounts, rule: Rule = 'majority'): Tally {
  const seats = integer('seats', counts.seats, 1);
  const upheld = integer('upheld', counts.upheld, 0);
  const against = integer('against', counts.against, 0);
  if (upheld + against > seats) {
    throw new TypeError(
      `upheld (${String(upheld)}) plus against (${String(against)}) exceeds seats (${String(seats)}).`,
    );
  }
  const need = threshold(rule, seats);
  const missing = seats - upheld - against;
  const outcome: Outcome =
    upheld >= need ? 'confirmed' : upheld + missing < need ? 'refuted' : 'undecided';
  return { outcome, upheld, against, missing, seats };
}

/**
 * Remove items whose key was already seen, keeping the first occurrence in its position. With
 * `merge`, a duplicate is folded into the kept item instead of being dropped.
 *
 * @typeParam T - The item type.
 * @param items - The items, in priority order.
 * @param key - The identity of an item; equal strings are duplicates.
 * @param merge - Combines the kept item with a later duplicate; its result replaces the kept item.
 * @returns The unique items in first-occurrence order.
 */
export function dedupeBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  merge?: (kept: T, duplicate: T) => T,
): T[] {
  const slots = new Map<string, { value: T }>();
  const order: { value: T }[] = [];
  for (const item of items) {
    const id = key(item);
    const slot = slots.get(id);
    if (slot === undefined) {
      const created = { value: item };
      slots.set(id, created);
      order.push(created);
    } else if (merge !== undefined) {
      slot.value = merge(slot.value, item);
    }
  }
  return order.map((slot) => slot.value);
}

/**
 * The items whose keys are not in `seen`, deduplicated (first wins), adding their keys to `seen`.
 * Use one `seen` set across loop rounds so each round keeps only what is new.
 *
 * @typeParam T - The item type.
 * @param items - This round's items.
 * @param seen - Keys seen before; mutated to include the returned items' keys.
 * @param key - The identity of an item.
 * @returns The new items in input order.
 */
export function fresh<T>(items: readonly T[], seen: Set<string>, key: (item: T) => string): T[] {
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

/** An item reported by one or more sources, as returned by {@link corroborate}. */
export interface Corroborated<T> {
  /** The item's key. */
  readonly key: string;
  /** The first occurrence of the item across the lists. */
  readonly item: T;
  /** How many lists contain the key; a list that repeats it counts once. */
  readonly count: number;
}

/**
 * Merge independent lists, such as several finders' reports, counting how many lists report each
 * key. The result is sorted by count, most corroborated first; ties keep first-occurrence order.
 *
 * @typeParam T - The item type.
 * @param lists - One list per source.
 * @param key - The identity of an item.
 * @returns One entry per distinct key with its first occurrence and its count.
 */
export function corroborate<T>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
): Corroborated<T>[] {
  const entries = new Map<string, { key: string; item: T; count: number }>();
  for (const list of lists) {
    const inList = new Set<string>();
    for (const item of list) {
      const id = key(item);
      if (inList.has(id)) continue;
      inList.add(id);
      const entry = entries.get(id);
      if (entry === undefined) entries.set(id, { key: id, item, count: 1 });
      else entry.count += 1;
    }
  }
  // Array.prototype.sort is stable, so equal counts keep their first-occurrence order.
  return [...entries.values()].sort((a, b) => b.count - a.count);
}

/**
 * Split `items` into consecutive chunks of `size`; the last chunk may be shorter.
 *
 * @typeParam T - The item type.
 * @param items - The items.
 * @param size - The chunk size, a positive integer.
 * @returns The chunks in order; empty for no items.
 * @throws TypeError - When `size` is not a positive integer.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  integer('size', size, 1);
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

/**
 * A deterministic window over `pool` for loop round `round`: `pool[(round * count + i) % length]`
 * for `i < min(count, length)`, so consecutive rounds walk through the pool (lens rotation).
 *
 * @typeParam T - The pool's item type.
 * @param pool - The items to rotate through.
 * @param round - The zero-based round number.
 * @param count - How many items each round takes; at most the whole pool is returned.
 * @returns The round's items, distinct positions of the pool; empty for an empty pool.
 * @throws TypeError - When `round` or `count` is not a nonnegative integer.
 */
export function rotate<T>(pool: readonly T[], round: number, count: number): T[] {
  integer('round', round, 0);
  integer('count', count, 0);
  const length = pool.length;
  if (length === 0) return [];
  // (round * count) % length without overflow for large rounds.
  const start = ((round % length) * (count % length)) % length;
  return [...pool.slice(start), ...pool.slice(0, start)].slice(0, Math.min(count, length));
}

/**
 * Sort items by the position of `get(item)` in `order`, keeping input order among equal ranks.
 * Values missing from `order` sort last.
 *
 * @typeParam T - The item type.
 * @typeParam K - The ranked values, such as an enum's options.
 * @param items - The items.
 * @param get - The ranked value of an item.
 * @param order - The values from first to last, such as a Zod enum's `.options`.
 * @returns A new, stably sorted array.
 */
export function rankBy<T, K extends string>(
  items: readonly T[],
  get: (item: T) => K,
  order: readonly K[],
): T[] {
  const rank = new Map<string, number>();
  order.forEach((value, index) => {
    if (!rank.has(value)) rank.set(value, index);
  });
  return items
    .map((item) => ({ item, rank: rank.get(get(item)) ?? order.length }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item);
}

/**
 * Sort items by `severity`: `critical`, `high`, `medium`, `low`, then any other value, keeping
 * input order within a severity.
 *
 * @typeParam T - An item with a `severity` string, such as a `std.types.Finding`.
 * @param items - The items.
 * @returns A new, stably sorted array.
 */
export function bySeverity<
  T extends {
    /** The item's severity, such as `'high'`. */
    readonly severity: string;
  },
>(items: readonly T[]): T[] {
  return rankBy<T, string>(items, (item) => item.severity, SEVERITIES);
}

/** Options of {@link rankCap}. */
export interface RankCapOptions<T> {
  /** How many items to choose, a nonnegative integer. */
  readonly cap: number;
  /** A comparator, as for `Array.prototype.sort`; omitted, the input order is the priority. */
  readonly by?: ((a: T, b: T) => number) | undefined;
}

/** Result of {@link rankCap}: the chosen items and the rest, both in priority order. */
export interface RankCapResult<T> {
  /** The first `cap` items in priority order. */
  readonly chosen: T[];
  /** The remaining items in priority order; report them rather than dropping them silently. */
  readonly deferred: T[];
}

/**
 * Prioritize and cap: stably sort `items` with `by` and split them after `cap` items, so a
 * workflow can act on the most important ones and report the deferred rest.
 *
 * @typeParam T - The item type.
 * @param items - The candidates.
 * @param options - The cap and an optional comparator.
 * @returns The chosen and deferred items.
 * @throws TypeError - When `cap` is not a nonnegative integer.
 */
export function rankCap<T>(items: readonly T[], options: RankCapOptions<T>): RankCapResult<T> {
  const cap = integer('cap', options.cap, 0);
  const sorted = options.by === undefined ? items.slice() : items.slice().sort(options.by);
  return { chosen: sorted.slice(0, cap), deferred: sorted.slice(cap) };
}

/**
 * Turn arbitrary labels into unique, ID-safe map keys before a map starts. Each label becomes
 * `stepId(label)` (a clean label passes through unchanged; other text is slugged with a hash
 * suffix), and a repeated key gets `.2`, `.3`, ... in input order, skipping any key another label
 * already produces. Every key is a clean `ctx.id` segment of at most 64 characters, so it passes
 * through `ctx.id` unchanged and adds no path depth.
 *
 * @param labels - One label per item, such as finding keys or titles.
 * @returns One key per label, index-aligned and unique.
 */
export function uniqueKeys(labels: readonly string[]): string[] {
  const bases = labels.map((label) => stepId(label));
  const reserved = new Set(bases);
  const used = new Set<string>();
  return bases.map((base) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let occurrence = 2; ; occurrence++) {
      const suffix = `.${String(occurrence)}`;
      const candidate = `${base.slice(0, MAX_SEGMENT - suffix.length)}${suffix}`;
      if (!reserved.has(candidate) && !used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  });
}

/**
 * Throw when `values` contains a repeated value.
 *
 * @param values - The values that must be unique, such as item keys or task IDs.
 * @param what - What the values are, for the message (`'task ID'`).
 * @throws Error - `Duplicate <what>: "a", "b".`, listing each repeated value once.
 */
export function assertUnique(values: readonly string[], what: string): void {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  if (repeated.size > 0) {
    const list = [...repeated].map((value) => JSON.stringify(value)).join(', ');
    throw new Error(`Duplicate ${what}: ${list}.`);
  }
}

/**
 * Throw when two items claim overlapping repository paths: the same path, or a directory and a
 * path inside it (`src` and `src/a.ts`). Trailing slashes are ignored, and the empty path is the
 * repository root, which contains every other path. Use it to check that parallel editors own
 * disjoint files before they start.
 *
 * @typeParam T - The item type.
 * @param items - The owners.
 * @param files - The repository-relative paths or directory prefixes an item owns.
 * @param label - An item's name for the message.
 * @throws Error - `Overlapping files: ...`, listing every overlap.
 */
export function assertDisjoint<T>(
  items: readonly T[],
  files: (item: T) => readonly string[],
  label: (item: T) => string,
): void {
  const names = items.map(label);
  const owners = new Map<string, number[]>();
  items.forEach((item, index) => {
    for (const raw of files(item)) {
      const path = raw.replace(/\/+$/u, '');
      const list = owners.get(path);
      if (list === undefined) owners.set(path, [index]);
      else if (!list.includes(index)) list.push(index);
    }
  });
  const nameOf = (indexes: readonly number[]): string =>
    indexes.map((index) => names[index] ?? String(index)).join(', ');
  const overlaps: string[] = [];
  for (const [path, list] of owners) {
    if (list.length > 1) overlaps.push(`${JSON.stringify(path)} is claimed by ${nameOf(list)}`);
    const parts = path.split('/');
    // Depth 0 is the root (the empty path); the root itself has no parent.
    for (let depth = path === '' ? parts.length : 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/');
      const above = owners.get(parent);
      if (above === undefined) continue;
      if (above.some((outer) => list.some((inner) => outer !== inner))) {
        overlaps.push(
          `${JSON.stringify(parent)} (${nameOf(above)}) contains ${JSON.stringify(path)} (${nameOf(list)})`,
        );
      }
    }
  }
  if (overlaps.length > 0) throw new Error(`Overlapping files: ${overlaps.join('; ')}.`);
}

/** Which expected entries were seen, as returned by {@link coverage}. */
export interface Coverage {
  /** The expected entries that were seen, in expected order. */
  readonly covered: string[];
  /** The expected entries that were not seen, in expected order. */
  readonly missing: string[];
}
/** The schema of a {@link Coverage}, as `std.patterns.MapReduceResult` checks its `coverage`. */
export const Coverage: z.ZodType<Coverage> = z.strictObject({
  covered: z.array(z.string()),
  missing: z.array(z.string()),
});

/**
 * Split the expected entries into covered and missing ones, computed in code rather than reported
 * by a model. Duplicates in `all` are listed once; entries of `seen` outside `all` are ignored.
 *
 * @param all - Every entry that should be covered, such as the item keys of a map.
 * @param seen - The entries that were covered, such as the keys of successful chunks.
 * @returns The covered and missing entries in the order of `all`.
 */
export function coverage(all: readonly string[], seen: Iterable<string>): Coverage {
  const present = new Set(seen);
  const listed = new Set<string>();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const entry of all) {
    if (listed.has(entry)) continue;
    listed.add(entry);
    (present.has(entry) ? covered : missing).push(entry);
  }
  return { covered, missing };
}

/**
 * Serialize a JSON value canonically: object keys sorted by UTF-16 code units, no whitespace,
 * `undefined` object members omitted. Equal values give equal text regardless of key insertion
 * order, so the text is a stable basis for a digest. Keys sort as strings, so `"10"` precedes
 * `"9"`, and `-0` is written as `0`.
 *
 * The parameter is typed `unknown` so read-only arrays and interfaces (such as a pattern result)
 * pass without a cast; the value is checked at run time instead.
 *
 * @param value - A JSON value: `null`, booleans, finite numbers, strings, arrays and plain objects,
 * read-only or not.
 * @returns The canonical JSON text.
 * @throws TypeError - When the value holds a non-finite number, `undefined` in an array, an array
 * hole, a cycle, a class instance, or a function, symbol or BigInt.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const invalid = (path: string, reason: string): never => {
    throw new TypeError(`Value is not canonical JSON at ${path}: ${reason}.`);
  };
  const visit = (item: unknown, path: string): string => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid(path, `${String(item)} is not a finite number`);
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') return invalid(path, `${typeof item} is not a JSON value`);
    if (ancestors.has(item)) return invalid(path, 'the value contains a cycle');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const parts: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const at = `${path}[${String(index)}]`;
          if (!Object.hasOwn(item, index)) return invalid(at, 'arrays cannot have holes');
          const element: unknown = item[index];
          if (element === undefined) return invalid(at, 'arrays cannot contain undefined');
          parts.push(visit(element, at));
        }
        return `[${parts.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        return invalid(path, 'values must be plain objects, not class instances');
      const record = item as Readonly<Record<string, unknown>>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) continue;
        members.push(`${JSON.stringify(key)}:${visit(member, `${path}.${key}`)}`);
      }
      return `{${members.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, '$');
}

/**
 * The SHA-256 of `text` encoded as UTF-8.
 *
 * @param text - The text to hash.
 * @returns 64 lowercase hexadecimal characters.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A stable digest of a JSON value: `sha256(canonicalJson(value))`. Use it as an approval subject or
 * a change marker; equal values give equal digests regardless of key order.
 *
 * @param value - A JSON value, read-only arrays and interfaces included; checked at run time.
 * @returns 64 lowercase hexadecimal characters.
 * @throws TypeError - When the value is not plain JSON (see {@link canonicalJson}).
 */
export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Normalize a title for duplicate detection: Unicode NFKC, lowercase, every run of characters
 * other than letters, marks and digits replaced by one space, trimmed. `"Null deref: parse()"` and
 * `"null-deref parse"` both become `"null deref parse"`.
 *
 * @param title - The title.
 * @returns The normalized title; empty when it has no letters or digits.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The deduplication key of a located finding: `<file>::<normalized title>`.
 *
 * @param finding - Any value with a `file` and a `title`, such as a `std.types.Finding`.
 * @returns The key; findings in the same file with equivalent titles share it.
 */
export function findingKey(finding: {
  /** The repository-relative file. */
  readonly file: string;
  /** The finding's title. */
  readonly title: string;
}): string {
  return `${finding.file}::${normalizeTitle(finding.title)}`;
}

/**
 * Group items into dependency waves: wave 0 holds the items without dependencies, and each later
 * wave the items whose dependencies all sit in earlier waves. Items keep their input order within
 * a wave. All problems are reported together, so the message can go back to a planner as is.
 *
 * @typeParam T - The item type.
 * @param items - The items, such as planned tasks.
 * @param key - An item's unique key.
 * @param dependsOn - The keys an item depends on; repeats are ignored.
 * @returns The waves in order; empty for no items.
 * @throws Error - `Invalid dependencies: ...`, listing every duplicate key and unknown dependency,
 * or, when those are absent, one dependency cycle (a self-dependency is a cycle).
 */
export function topoWaves<T>(
  items: readonly T[],
  key: (item: T) => string,
  dependsOn: (item: T) => readonly string[],
): T[][] {
  const nodes: WaveNode<T>[] = items.map((item) => ({ item, key: key(item), deps: [], wave: -1 }));
  const byKey = new Map<string, WaveNode<T>>();
  const problems: string[] = [];
  const repeated = new Set<string>();
  for (const node of nodes) {
    if (!byKey.has(node.key)) byKey.set(node.key, node);
    else if (!repeated.has(node.key)) {
      repeated.add(node.key);
      problems.push(`duplicate key ${JSON.stringify(node.key)}`);
    }
  }
  for (const node of nodes) {
    for (const dep of dependsOn(node.item)) {
      const target = byKey.get(dep);
      if (target === undefined) {
        problems.push(`${JSON.stringify(node.key)} depends on unknown ${JSON.stringify(dep)}`);
      } else if (!node.deps.includes(target)) {
        node.deps.push(target);
      }
    }
  }
  if (problems.length > 0) throw new Error(`Invalid dependencies: ${problems.join('; ')}.`);
  const waves: T[][] = [];
  let pending = nodes;
  while (pending.length > 0) {
    const ready = pending.filter((node) => node.deps.every((dep) => dep.wave >= 0));
    if (ready.length === 0) throw new Error(`Invalid dependencies: ${describeCycle(pending)}.`);
    for (const node of ready) node.wave = waves.length;
    waves.push(ready.map((node) => node.item));
    pending = pending.filter((node) => node.wave < 0);
  }
  return waves;
}

/** A {@link topoWaves} graph node; `wave` is -1 until the node is scheduled. */
interface WaveNode<T> {
  readonly item: T;
  readonly key: string;
  readonly deps: WaveNode<T>[];
  wave: number;
}

/**
 * Describe one cycle among `pending` nodes, each of which has an unscheduled dependency: walk from
 * the first node along unscheduled dependencies until a node repeats.
 */
function describeCycle<T>(pending: readonly WaveNode<T>[]): string {
  const path: WaveNode<T>[] = [];
  let current: WaveNode<T> | undefined = pending[0];
  while (current !== undefined && !path.includes(current)) {
    path.push(current);
    current = current.deps.find((dep) => dep.wave < 0);
  }
  const cycle = current === undefined ? path : [...path.slice(path.indexOf(current)), current];
  return `cycle ${cycle.map((node) => JSON.stringify(node.key)).join(' -> ')}`;
}

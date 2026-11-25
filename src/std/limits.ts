/**
 * Claude turn, spend and time limits as fragments: spread one after a capability, tier or role to
 * resize it, as in `Planner: { ...std.roles.Planner, ...std.limits.Hour }`. Each fixes `maxTurns`,
 * `maxBudgetUsd` and `timeoutMs` together, so a spread never leaves a long timeout with a short
 * turn budget. The first three match the runtime's text, read-only and edit configurations
 * (`std.claude.Text`, `ReadOnly` and `Edit`); the last two size long planning and implementation
 * calls like the bundled package rosters.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Planner: { ...std.roles.Planner, ...std.limits.Hour },
 *   Mechanic: { ...std.roles.Mechanic, ...std.limits.Long, maxBudgetUsd: 15 },
 * });
 * ```
 *
 * The fragments carry no `harness`, and they are Claude-only by design: `maxTurns` and
 * `maxBudgetUsd` are Claude options, so spreading one onto a Codex entry fails typecheck. Give a
 * Codex entry a `timeoutMs` directly. A launch can still override any limit with
 * `--profile Name.maxTurns=...` and the like.
 *
 * @module
 */

/**
 * The shape of every limits fragment: a turn cap, a per-call spend cap and a per-call timeout.
 *
 * @typeParam T - The `maxTurns` value.
 * @typeParam B - The `maxBudgetUsd` value.
 * @typeParam M - The `timeoutMs` value.
 */
export interface Limits<
  T extends number = number,
  B extends number = number,
  M extends number = number,
> {
  /** The most agent turns one call may take. */
  readonly maxTurns: T;
  /** The most one call may spend, in US dollars, as Claude enforces it. */
  readonly maxBudgetUsd: B;
  /** The longest one call may run, in milliseconds. */
  readonly timeoutMs: M;
}

/** A short answer: 10 turns, USD 0.50 and five minutes, the text configuration's limits. */
export const Brief: Limits<10, 0.5, 300_000> = Object.freeze({
  maxTurns: 10,
  maxBudgetUsd: 0.5,
  timeoutMs: 300_000,
});

/** A focused read: 25 turns, USD 2 and fifteen minutes, the read-only configuration's limits. */
export const Standard: Limits<25, 2, 900_000> = Object.freeze({
  maxTurns: 25,
  maxBudgetUsd: 2,
  timeoutMs: 900_000,
});

/** A typical edit: 40 turns, USD 5 and thirty minutes, the edit configuration's limits. */
export const Extended: Limits<40, 5, 1_800_000> = Object.freeze({
  maxTurns: 40,
  maxBudgetUsd: 5,
  timeoutMs: 1_800_000,
});

/** An hour of work: 100 turns, USD 10 and one hour, for deep reviews and plans. */
export const Hour: Limits<100, 10, 3_600_000> = Object.freeze({
  maxTurns: 100,
  maxBudgetUsd: 10,
  timeoutMs: 3_600_000,
});

/** A long task: 200 turns, USD 25 and two hours, for whole-ticket implementation. */
export const Long: Limits<200, 25, 7_200_000> = Object.freeze({
  maxTurns: 200,
  maxBudgetUsd: 25,
  timeoutMs: 7_200_000,
});

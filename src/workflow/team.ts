import type { Agent } from './runtime/model.js';

// ADR 0067. A team is a typed record of named Agent slots. This module is pure: nothing is
// registered with the runtime, no capability check compares a slot to the agent that fills it, and
// no core module imports it. Agent is a type import only, so the authoring model is untouched.

/**
 * A team: a plain, read-only record of named {@link Agent} slots (ADR 0067 section 1). Each slot is
 * a structured, native-capability agent, so a text-only registered agent does not typecheck as a
 * slot. A team is just data of bound agents: calls through a slot are identical to calls through the
 * agent that fills it, with the same step IDs, fingerprints and records.
 *
 * @typeParam K - The slot names.
 */
export type Team<K extends string> = Readonly<Record<K, Agent>>;

/**
 * Derive the team record type from a {@link defineTeam} result (ADR 0067 section 1). With the
 * ADR's `ReviewTeam`, `TeamOf<typeof ReviewTeam>` is
 * `{ readonly actor: Agent; readonly critic: Agent }`.
 *
 * @typeParam T - The value `defineTeam` returned.
 */
export type TeamOf<T> = T extends {
  readonly slots: Readonly<Record<infer K extends string, string>>;
}
  ? Team<K>
  : never;

/**
 * Declare the slots a higher-order pattern needs, independent of which configured agent fills them
 * (ADR 0067 sections 1-2). The result carries `slots` (plain, frozen data mapping each slot name to
 * its one-line description, readable without running a workflow body) and `from`, the one
 * convenience for filling a team.
 *
 * `from(record)` picks exactly the slot keys from any record that has them, so
 * `ReviewTeam.from(ctx.roster)` fills a team whose roster entries use the slot names and
 * `ReviewTeam.from({ ...ctx.roster, critic: ctx.roster.Skeptic })` overrides one slot. A record
 * missing a slot, or holding a non-agent there, fails typecheck; an untyped caller that omits a slot
 * gets a `TypeError` naming it. That is a presence check only: nothing compares an agent to its
 * slot, and the agents are neither inspected nor wrapped. Nothing is registered with the runtime
 * and validation output does not list teams.
 *
 * @param slots - Slot names mapped to one-line descriptions. Expectations about a slot's capability
 * belong in its description, not in a runtime check.
 * @returns The frozen definition: `slots` and `from`.
 * @throws TypeError - When `slots` is not a plain object, has no slots, or has a description that
 * is not a string.
 */
export function defineTeam<const K extends string>(
  slots: Readonly<Record<K, string>>,
): {
  /** The slot descriptions: a frozen, null-prototype copy that later edits to the input cannot change. */
  readonly slots: Readonly<Record<K, string>>;
  /** Fill the team by picking the slot keys from `record`; extra keys are dropped. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- `R` admits records with extra keys (a whole roster) without an excess-property error.
  from<R extends Team<K>>(record: R): Team<K>;
} {
  const prototype: unknown =
    typeof slots === 'object' ? (Object.getPrototypeOf(slots) as unknown) : undefined;
  if (
    typeof slots !== 'object' ||
    Array.isArray(slots) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError('defineTeam expects a plain object of slot names to descriptions.');
  }
  const names = Object.keys(slots) as K[];
  if (names.length === 0) throw new TypeError('defineTeam needs at least one slot.');
  const copy = Object.create(null) as Record<K, string>;
  for (const name of names) {
    const description: unknown = slots[name];
    if (typeof description !== 'string') {
      throw new TypeError(`Team slot ${name} needs a string description.`);
    }
    copy[name] = description;
  }
  Object.freeze(copy);
  return Object.freeze({
    slots: copy,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Mirrors the declared signature.
    from<R extends Team<K>>(record: R): Team<K> {
      const team = {} as Record<K, Agent>;
      for (const name of names) {
        const agent: unknown = (record as Partial<Record<K, Agent>>)[name];
        if (agent === undefined || agent === null) {
          throw new TypeError(`Team slot ${name} is not filled.`);
        }
        team[name] = agent as Agent;
      }
      return Object.freeze(team);
    },
  });
}

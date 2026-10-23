import type { WorkflowDecider } from './child-model.js';
import type { DecisionBinding } from './decisions.js';
import type { HarnessDeclaration } from './harness-model.js';
import type { JsonValue } from './model.js';
import type { AgentProfile } from './profiles-model.js';
import type { CheckedRosterEntries, Roster, RosterEntries, RosterOptions } from './roster-model.js';
import { jsonValue } from './json.js';
import { promptOptionsAsText } from '../prompts/prompt.js';

// ADR 0063 sections 3-4. A roster entry compiles to an ordinary declared profile under its own
// name, pinned to one harness, so resolution, launch overrides, attempt records, grants and the
// manifest reuse the profile code. `ctx.roster.Name` is the pinned harness client bound to that
// entry through the internal role channel (`bindRole`), not a public option, and the runner
// resolves its calls as the entry's. A decider entry (ADR 0066 section 2) is not a role: it
// compiles to nothing, and `ctx.roster.Name` is `{ decide }` over `ctx.decide` with the entry's
// provider and model preset.

/** Entry keys: identifiers, so dot access always works, capped to the manifest's name length. */
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
/** Built-in preset names and the words grants and the access lattice reserve. */
const reservedNames: ReadonlySet<string> = new Set([
  'text',
  'readonly',
  'edit',
  'all',
  'none',
  'read',
  'write',
  'exec',
  'constructor',
  'prototype',
  '__proto__',
]);
/**
 * Keys an entry cannot set: the per-call-only keys of ADR 0063 section 1, the profile machinery an
 * entry replaces (`profile`, `extends`, `access`) and the cross-harness blocks.
 */
const forbiddenKeys: Readonly<Record<string, string>> = {
  prompt: 'it is a per-call option',
  schema: 'it is a per-call option',
  cwd: 'it is a per-call option',
  worktree: 'it is a per-call option',
  onError: 'it is a per-call option',
  retry: 'it is a per-call option',
  images: 'it is a per-call option',
  profile: 'an entry is itself the role',
  extends: 'entries have no inheritance; spread a shared entry instead',
  access: 'access is derived from the entry',
  claude: 'entries have no cross-harness blocks; the harness field selects the options',
  codex: 'entries have no cross-harness blocks; the harness field selects the options',
  harnesses: 'entries have no cross-harness blocks; the harness field selects the options',
  addDirRoots: 'bounded call-site directories belong to profiles; list addDirs on the entry',
};
/** Limits that compile to top-level profile limits, so `--profile Name.limit=` overrides them. */
const limitKeys = ['timeoutMs', 'idleTimeoutMs', 'maxTurns', 'maxBudgetUsd'] as const;

/** Decision provider names, as `defineDecisionProvider` requires them. */
const providerNamePattern = /^[a-z][a-z0-9-]{0,31}$/u;
/** The only keys a decider entry may set. */
const deciderKeys: ReadonlySet<string> = new Set(['decider', 'model', 'description']);

/** A validated agent entry as plain JSON data. */
type AgentEntryData = Readonly<Record<string, JsonValue>> & { readonly harness: string };
/** A validated decider entry as plain JSON data. */
interface DeciderEntryData {
  readonly decider: string;
  readonly model?: string;
  readonly description?: string;
}
/** A validated entry as plain JSON data. */
type EntryData = AgentEntryData | DeciderEntryData;

/** Whether a validated entry is a decider entry. */
function isDecider(entry: EntryData): entry is DeciderEntryData {
  return Object.hasOwn(entry, 'decider');
}

/** Validate a decider entry (ADR 0066 section 2) and copy it as plain JSON. */
function checkedDecider(name: string, entry: Readonly<Record<string, unknown>>): DeciderEntryData {
  if (Object.hasOwn(entry, 'harness'))
    throw new Error(
      `Roster entry ${name} cannot set both harness and decider; an entry is an agent or a decider.`,
    );
  for (const key of Object.keys(entry))
    if (!deciderKeys.has(key))
      throw new Error(
        `Roster entry ${name} is a decider; it cannot set ${key} (a decider entry takes only decider, model and description).`,
      );
  const { decider, model, description } = entry;
  if (typeof decider !== 'string' || !providerNamePattern.test(decider))
    throw new Error(
      `Roster entry ${name} decider must be a decision provider name matching /^[a-z][a-z0-9-]{0,31}$/.`,
    );
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    throw new Error(`Roster entry ${name} model must be a nonempty string.`);
  if (description !== undefined && typeof description !== 'string')
    throw new Error(`Roster entry ${name} description must be a string.`);
  return jsonValue(entry, `Roster entry ${name}`) as unknown as DeciderEntryData;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate a roster value and copy each entry as plain JSON. `registered` lists the harness names
 * entries may use besides `claude` and `codex`; `unknown` words the refusal of any other one.
 */
function checkedEntries(
  value: unknown,
  registered: ReadonlySet<string>,
  unknown: (name: string, harness: string) => string,
): Record<string, EntryData> {
  if (!isRecord(value)) throw new TypeError('A roster must be an object of named entries.');
  if (Reflect.ownKeys(value).length !== Object.keys(value).length)
    throw new TypeError('A roster cannot contain symbol or non-enumerable keys.');
  const result: Record<string, EntryData> = Object.create(null) as Record<string, EntryData>;
  for (const name of Object.keys(value)) {
    if (!keyPattern.test(name))
      throw new Error(
        `Roster entry name ${JSON.stringify(name)} must be an identifier matching /^[A-Za-z][A-Za-z0-9_]*$/ of at most 64 characters.`,
      );
    if (reservedNames.has(name))
      throw new Error(`Roster entry name ${name} is reserved (a built-in preset or access word).`);
    const entry = value[name];
    if (!isRecord(entry)) throw new TypeError(`Roster entry ${name} must be an object.`);
    if (Object.hasOwn(entry, 'decider')) {
      result[name] = checkedDecider(name, entry);
      continue;
    }
    for (const key of Object.keys(entry))
      if (Object.hasOwn(forbiddenKeys, key))
        throw new Error(`Roster entry ${name} cannot set ${key}: ${forbiddenKeys[key] ?? ''}.`);
    const harness = entry['harness'];
    if (typeof harness !== 'string')
      throw new Error(`Roster entry ${name} must name its harness or decider.`);
    if (harness !== 'claude' && harness !== 'codex' && !registered.has(harness))
      throw new Error(unknown(name, harness));
    if (entry['description'] !== undefined && typeof entry['description'] !== 'string')
      throw new Error(`Roster entry ${name} description must be a string.`);
    if (entry['expectsToolUse'] !== undefined && typeof entry['expectsToolUse'] !== 'boolean')
      throw new Error(`Roster entry ${name} expectsToolUse must be a boolean.`);
    // A standing systemPrompt or appendSystemPrompt may be a rendered Prompt (ADR 0064 section 2).
    result[name] = jsonValue(promptOptionsAsText(entry), `Roster entry ${name}`) as AgentEntryData;
  }
  return result;
}

/**
 * Define the workflow inventory: named, concrete agent configurations, each pinned to one harness
 * (ADR 0063 section 3), and named deciders (ADR 0066 section 2). Pass the result as `roster` to
 * `defineWorkflow`, whose `ctx.roster.Name` is then that harness's client bound to the entry, typed
 * as an `Agent`, or for a decider entry a `RosterDecider`.
 *
 * An entry is `{ harness, description?, expectsToolUse? }` plus that harness's own option type
 * minus the per-call-only keys (`prompt`, the schema, `cwd`, `worktree`, `onError`, `retry` and
 * Codex `images`) and `profile`. `options.harnesses` types entries for registered harnesses; the
 * workflow must still declare each one in its own `harnesses`. Keys are identifiers
 * (`/^[A-Za-z][A-Za-z0-9_]*$/`, at most 64 characters), PascalCase by convention, and cannot be a
 * built-in preset (`text`, `readonly`, `edit`) or reserved word.
 *
 * A decider entry is `{ decider, model?, description? }`: `decider` names one of the workflow's
 * `decisions` (checked when the workflow loads) and `model` is the requested model, both fixed for
 * every `ctx.roster.Name.decide` call. It takes no other key, and an entry cannot set both
 * `harness` and `decider`. A decider entry is not a role: it has no capability profile, grant or
 * `--profile` override.
 *
 * It validates the names, harnesses and forbidden keys when the module loads and returns a
 * deep-frozen JSON copy. A `Prompt` in `systemPrompt` or `appendSystemPrompt` is stored as its
 * text, and the result's entries type it as `string`. Option values are checked against the harness when a workflow using the
 * roster is validated or run.
 */
export function defineRoster<
  const E extends RosterEntries<H>,
  const H extends readonly HarnessDeclaration[] = readonly [],
>(entries: CheckedRosterEntries<E, H>, options: RosterOptions<H> = {}): Roster<E, H> {
  if (typeof options !== 'object' || (options as unknown) === null)
    throw new TypeError('defineRoster options must be an object.');
  const harnesses: unknown = options.harnesses ?? [];
  if (!Array.isArray(harnesses))
    throw new TypeError('defineRoster options.harnesses must be an array of harness definitions.');
  const registered = new Set<string>();
  for (const definition of harnesses as unknown[]) {
    const name: unknown = isRecord(definition) ? definition['name'] : undefined;
    if (typeof name !== 'string')
      throw new TypeError('defineRoster options.harnesses must contain harness definitions.');
    registered.add(name);
  }
  const checked = checkedEntries(
    entries,
    registered,
    (name, harness) =>
      `Roster entry ${name} uses unknown harness ${harness}; pass its definition in defineRoster options.harnesses.`,
  );
  // A plain object, so the roster spreads and prints like the literal it came from.
  return deepFreeze({ ...checked }) as unknown as Roster<E, H>;
}

/**
 * The roster profiles of a definition and the harness each one is pinned to, plus its decider
 * entries, which are not profiles. @internal
 */
export interface CompiledRoster {
  /** Each agent entry as a declared profile without `extends`, under the entry's name. */
  readonly profiles: Readonly<Record<string, AgentProfile>>;
  /** Agent entry name to its pinned harness. */
  readonly pins: Readonly<Record<string, string>>;
  /** Decider entry name to its provider, model and description. */
  readonly deciders: Readonly<Record<string, WorkflowDecider>>;
}

/**
 * Compile a definition's roster to profiles (ADR 0063 section 4). Each entry becomes a profile with
 * no `extends`, so it layers on the text baseline and workflow `defaults`: `description` and
 * `expectsToolUse` stay top-level, the four limits become profile limits, and every other key goes
 * into the pinned harness's block (`claude`, `codex` or `harnesses.<name>`). Decider entries are
 * skipped and listed in `deciders`. The roster is validated again, since a definition need not have
 * come from `defineRoster`. @internal
 */
export function compileRoster(definition: {
  readonly name?: string;
  readonly roster?: unknown;
  readonly harnesses?: readonly Pick<HarnessDeclaration, 'name'>[];
}): CompiledRoster {
  if (definition.roster === undefined) return { profiles: {}, pins: {}, deciders: {} };
  const declared = new Set((definition.harnesses ?? []).map((item) => item.name));
  const entries = checkedEntries(
    definition.roster,
    declared,
    (name, harness) =>
      `Roster entry ${name} uses harness ${harness}, which workflow ${definition.name ?? '<unnamed>'} does not declare; add its definition to the workflow's harnesses.`,
  );
  const profiles: Record<string, AgentProfile> = {};
  const pins: Record<string, string> = {};
  const deciders: Record<string, WorkflowDecider> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (isDecider(entry)) {
      deciders[name] = {
        provider: entry.decider,
        model: entry.model ?? null,
        description: entry.description ?? null,
      };
      continue;
    }
    const options: Record<string, JsonValue> = { ...entry };
    const top: Record<string, JsonValue> = {};
    for (const key of ['description', 'expectsToolUse', ...limitKeys])
      if (Object.hasOwn(options, key)) {
        top[key] = options[key] as JsonValue;
        Reflect.deleteProperty(options, key);
      }
    Reflect.deleteProperty(options, 'harness');
    const block =
      entry.harness === 'claude' || entry.harness === 'codex'
        ? { [entry.harness]: options }
        : { harnesses: { [entry.harness]: options } };
    profiles[name] = { ...top, ...block };
    pins[name] = entry.harness;
  }
  return { profiles, pins, deciders };
}

/**
 * Check that each decider entry of a roster names one of the workflow's declared decision
 * providers (ADR 0066 section 2), as the definition loads. Only entries with a string `decider`
 * are looked at; the full entry validation runs when the roster compiles. @internal
 */
export function checkRosterDeciders(
  roster: unknown,
  providers: ReadonlySet<string>,
  workflow: string,
): void {
  if (!isRecord(roster)) return;
  for (const [name, entry] of Object.entries(roster)) {
    const decider: unknown = isRecord(entry) ? entry['decider'] : undefined;
    if (typeof decider === 'string' && !providers.has(decider))
      throw new Error(
        `Roster entry ${name} names decision provider ${decider}, which workflow ${workflow} does not declare; add it to the workflow's decisions.`,
      );
  }
}

const noAgents: Readonly<Record<string, unknown>> = Object.freeze(
  Object.create(null) as Record<string, unknown>,
);

/** A `ctx.decide` with a decider entry's provider and model preset. @internal */
export type BoundDecide = (id: string, options: unknown) => Promise<unknown>;

/**
 * The agents of `ctx.roster`: each agent entry's agent from `agentFor`, its pinned harness client
 * bound to the entry through the internal role channel, and each decider entry a frozen
 * `{ decide }` from `deciderFor`, in a frozen null-prototype object so a misspelled untyped name is
 * `undefined` rather than an `Object.prototype` member. @internal
 */
export function rosterAgents(
  roster: unknown,
  agentFor: (harness: string, entry: string) => unknown,
  deciderFor: (binding: DecisionBinding) => BoundDecide,
): Readonly<Record<string, unknown>> {
  if (!isRecord(roster)) return noAgents;
  const agents = Object.create(null) as Record<string, unknown>;
  for (const [name, entry] of Object.entries(roster)) {
    if (!isRecord(entry)) continue;
    const { harness, decider, model } = entry;
    let value: unknown;
    if (typeof decider === 'string')
      value = Object.freeze({
        decide: deciderFor({
          entry: name,
          provider: decider,
          ...(model === undefined ? {} : { model: model as string }),
        }),
      });
    else if (typeof harness === 'string') value = agentFor(harness, name);
    else continue;
    Object.defineProperty(agents, name, { value, enumerable: true });
  }
  return Object.freeze(agents);
}

/**
 * A reader for `ctx.roster` over one set of clients: it builds the agents of a roster once and
 * reuses them for every later read of the same roster object. Agents resolve their entry by name
 * against the definition running when they are called, so sharing them across definitions that
 * share a roster is sound. @internal
 */
export function rosterReader(
  agentFor: (harness: string, entry: string) => unknown,
  deciderFor: (binding: DecisionBinding) => BoundDecide,
): (roster: unknown) => Readonly<Record<string, unknown>> {
  const cache = new WeakMap<object, Readonly<Record<string, unknown>>>();
  return (roster) => {
    if (!isRecord(roster)) return noAgents;
    let agents = cache.get(roster);
    if (!agents) {
      agents = rosterAgents(roster, agentFor, deciderFor);
      cache.set(roster, agents);
    }
    return agents;
  };
}

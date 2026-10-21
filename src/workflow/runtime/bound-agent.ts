import type {
  AgentClient,
  AgentOptions,
  BindExcess,
  BindOptions,
  BoundOptionsOf,
  SelectBranch,
} from './model.js';

// ADR 0063 sections 1-2. A bound agent is partial application over the client it was bound from:
// each call merges its options over the bound ones and calls that client, so naming, profiles,
// policy, fingerprints and records see exactly the object a raw call would have spelled.

/** Keys only a call may set; `bind` rejects them. */
const perCallOnly: ReadonlySet<string> = new Set([
  'prompt',
  'schema',
  'cwd',
  'worktree',
  'onError',
  'retry',
  'images',
]);
/** Keys both `bind` and a call may set; the only keys a bound agent binds again. */
const bothSides: ReadonlySet<string> = new Set(['addDirs', 'timeoutMs', 'idleTimeoutMs']);

/** What the runtime that owns a client passes to the agents bound over it. @internal */
export interface BindHooks {
  /**
   * Mark a bind or bound-call validation error as an authoring error, as the runtime marks a raw
   * call's, so a settled map fails the run instead of journaling it as item data.
   */
  readonly markFatal?: ((error: unknown) => void) | undefined;
  /**
   * Fail a bound call whose options do not merge as an operation launched under `id` on the bound
   * client's harness, as a raw call's invalid options fail, so the runtime tracks it and an
   * unawaited failed call fails the run. Without it the call returns a rejected Promise.
   */
  readonly reject?: ((id: string, error: Error) => Promise<never>) | undefined;
}

type Options = Readonly<Record<string, unknown>>;
type Call = (id: string, options: Options) => Promise<unknown>;
interface Methods {
  readonly value: Call;
  readonly text: Call;
  readonly object: Call;
}

function isOptions(value: unknown): value is Options {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Set `key` as a plain data property, so an own `__proto__` key stays one (as `jsonValue` does). */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Who is validating: `bind` or a bound call, which prefix the errors they throw. */
type Where = 'bind' | 'A bound agent call';

/** Throw the error for a value that a raw call's JSON boundary would also reject. */
function notJson(where: Where, key: string, reason: string): never {
  throw new TypeError(`${where} ${key} must be plain JSON: ${reason}.`);
}

/**
 * The data value of `value`'s own property `name`, refusing what `jsonValue` refuses: a missing
 * property (an array hole), a getter, or a non-enumerable property.
 */
function dataValue(value: object, name: string, where: Where, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return notJson(where, key, 'arrays cannot have holes');
  if (!('value' in descriptor)) return notJson(where, key, 'it cannot contain getters');
  if (descriptor.enumerable !== true)
    return notJson(where, key, 'it cannot contain non-enumerable properties');
  return descriptor.value;
}

/**
 * The entries of bind or call options, read through their descriptors so that reading them never
 * evaluates a getter and never drops a symbol or non-enumerable key: each throws instead.
 */
function entries(options: Options, where: Where): (readonly [string, unknown])[] {
  if (Reflect.ownKeys(options).length !== Object.keys(options).length)
    throw new TypeError(`${where} cannot set a symbol or non-enumerable option.`);
  return Object.keys(options).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor))
      throw new TypeError(`${where} ${key} must be a data property, not a getter.`);
    return [key, descriptor.value] as const;
  });
}

/**
 * A fresh copy of an `addDirs` list, refusing what `frozen` refuses in a bound array (a hole, a
 * getter, a non-enumerable entry or an extra key) and an array that is not a plain `Array`, so
 * appending never runs a custom iterator or evaluates a getter.
 */
function directories(value: unknown, where: Where): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${where} addDirs must be an array.`);
  if (Object.getPrototypeOf(value) !== Array.prototype)
    return notJson(where, 'addDirs', 'it must be a plain array');
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++)
    copy.push(dataValue(value, String(index), where, 'addDirs'));
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return notJson(where, 'addDirs', 'arrays cannot have extra keys');
  return copy;
}

/**
 * A frozen deep copy of a bound value. Bound options are JSON by contract (the runner passes them
 * through `jsonValue`), so plain arrays and objects are copied and anything else is kept as is, for
 * that boundary to judge. A copy must not change what it copies, so a getter, a symbol key, a
 * non-enumerable property, an array hole or an extra array key throws here instead of being
 * evaluated or dropped: the raw call would reject the same value. A subclassed array, like a class
 * instance, is kept as is.
 */
function frozen(value: unknown, key: string, ancestors: readonly unknown[] = []): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.includes(value)) throw new TypeError(`bind ${key} must not be circular.`);
  const within = [...ancestors, value];
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) && prototype === Array.prototype) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++)
      items.push(frozen(dataValue(value, String(index), 'bind', key), key, within));
    if (Reflect.ownKeys(value).length !== value.length + 1)
      return notJson('bind', key, 'arrays cannot have extra keys');
    return Object.freeze(items);
  }
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (Reflect.ownKeys(value).length !== Object.keys(value).length)
    return notJson('bind', key, 'objects cannot contain symbols or non-enumerable properties');
  const copy: Record<string, unknown> = {};
  for (const name of Object.keys(value))
    define(copy, name, frozen(dataValue(value, name, 'bind', key), key, within));
  return Object.freeze(copy);
}

/**
 * Deep-copy and freeze the defined bound options, rejecting per-call-only keys. A re-bind (`again`)
 * may set only the both-sides keys: the first bind fixed every other one.
 */
function snapshot(bound: unknown, again: boolean): Options {
  if (!isOptions(bound)) throw new TypeError('bind options must be an object.');
  const copy: Record<string, unknown> = {};
  for (const [key, value] of entries(bound, 'bind')) {
    if (value === undefined) continue;
    if (perCallOnly.has(key))
      throw new TypeError(`bind cannot set ${key}; it is a per-call option (ADR 0063).`);
    if (again && !bothSides.has(key))
      throw new TypeError(
        `A bound agent cannot bind ${key} again; the first bind fixed it (ADR 0063).`,
      );
    define(copy, key, frozen(key === 'addDirs' ? directories(value, 'bind') : value, key));
  }
  return Object.freeze(copy);
}

/**
 * The options a raw call would spell: defined call values replace bound ones, addDirs append. The
 * top-level call options are read as `snapshot` reads bound ones, and `addDirs` is copied; other
 * call values (the schema, retry, onError) pass through as the caller gave them.
 */
function merge(bound: Options, call: unknown): Options {
  if (!isOptions(call)) throw new TypeError('Bound agent call options must be an object.');
  const merged: Record<string, unknown> = { ...bound };
  for (const [key, value] of entries(call, 'A bound agent call')) {
    if (value === undefined) continue;
    if (!perCallOnly.has(key) && !bothSides.has(key))
      throw new TypeError(
        `A bound agent call cannot set ${key}; bind it instead, or call the harness client directly (ADR 0063).`,
      );
    define(
      merged,
      key,
      key === 'addDirs'
        ? [
            ...((bound['addDirs'] as readonly unknown[] | undefined) ?? []),
            ...directories(value, 'A bound agent call'),
          ]
        : value,
    );
  }
  return merged;
}

function layer(client: Methods, options: unknown, hooks: BindHooks, again: boolean): Methods {
  let bound: Options;
  try {
    bound = snapshot(options, again);
  } catch (error) {
    hooks.markFatal?.(error);
    throw error;
  }
  const forward =
    (method: keyof Methods): Call =>
    (id, call) => {
      let merged: Options;
      try {
        merged = merge(bound, call);
      } catch (error) {
        const failure = error instanceof Error ? error : new TypeError(String(error));
        hooks.markFatal?.(failure);
        return hooks.reject ? hooks.reject(id, failure) : Promise.reject(failure);
      }
      return client[method](id, merged);
    };
  const agent: Methods & { readonly bind: (more: unknown) => Methods } = {
    value: forward('value'),
    text: forward('text'),
    object: forward('object'),
    bind: (more) => layer(agent, more, hooks, true),
  };
  return agent;
}

/**
 * Bind `options` over `client` (ADR 0063 section 2). Validation and the snapshot are synchronous;
 * binding claims no step ID and reads no run state. A call delegates synchronously, so the step ID
 * prefix is the one in effect where the bound agent is invoked. The returned agent binds again
 * over the both-sides keys only, and its calls and re-binds report errors through `hooks`. @internal
 */
export function bindAgent<TOptions extends AgentOptions, const B extends BindOptions<TOptions>>(
  client: AgentClient<TOptions>,
  options: B & BindExcess<B, TOptions>,
  hooks: BindHooks = {},
): AgentClient<BoundOptionsOf<SelectBranch<TOptions, B>, B>> {
  return layer(client as unknown as Methods, options, hooks, false) as unknown as AgentClient<
    BoundOptionsOf<SelectBranch<TOptions, B>, B>
  >;
}

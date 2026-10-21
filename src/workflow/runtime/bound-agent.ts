import type { AgentClient, AgentOptions, BindOptions, BoundOptionsOf } from './model.js';

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
/** Keys both `bind` and a call may set. */
const bothSides: ReadonlySet<string> = new Set(['addDirs', 'timeoutMs', 'idleTimeoutMs']);

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

function directories(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${where} addDirs must be an array.`);
  return value;
}

/** Copy the defined bound options, rejecting per-call-only keys; addDirs is copied and frozen. */
function snapshot(bound: unknown): Options {
  if (!isOptions(bound)) throw new TypeError('bind options must be an object.');
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bound)) {
    if (value === undefined) continue;
    if (perCallOnly.has(key))
      throw new TypeError(`bind cannot set ${key}; it is a per-call option (ADR 0063).`);
    copy[key] = key === 'addDirs' ? Object.freeze([...directories(value, 'bind')]) : value;
  }
  return Object.freeze(copy);
}

/** The options a raw call would spell: defined call values replace bound ones, addDirs append. */
function merge(bound: Options, call: unknown): Options {
  if (!isOptions(call)) throw new TypeError('Bound agent call options must be an object.');
  const merged: Record<string, unknown> = { ...bound };
  for (const [key, value] of Object.entries(call)) {
    if (value === undefined) continue;
    if (!perCallOnly.has(key) && !bothSides.has(key))
      throw new TypeError(
        `A bound agent call cannot set ${key}; bind it instead, or call the harness client directly (ADR 0063).`,
      );
    merged[key] = value;
  }
  const callDirs = call['addDirs'];
  if (callDirs !== undefined)
    merged['addDirs'] = [
      ...((bound['addDirs'] as readonly unknown[] | undefined) ?? []),
      ...directories(callDirs, 'A bound agent call'),
    ];
  return merged;
}

/**
 * Bind `options` over `client` (ADR 0063 section 2). Validation and the snapshot are synchronous;
 * binding claims no step ID and reads no run state. A call delegates synchronously, so the step ID
 * prefix is the one in effect where the bound agent is invoked. @internal
 */
export function bindAgent<TOptions extends AgentOptions>(
  client: AgentClient<TOptions>,
  options: BindOptions<TOptions>,
): AgentClient<BoundOptionsOf<TOptions>> {
  const target = client as unknown as Methods;
  const bound = snapshot(options);
  const forward =
    (method: keyof Methods): Call =>
    (id, call) => {
      let merged: Options;
      try {
        merged = merge(bound, call);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
      }
      return target[method](id, merged);
    };
  const agent = {
    value: forward('value'),
    text: forward('text'),
    object: forward('object'),
    bind: (more: Options) => bindAgent(agent as unknown as AgentClient<AgentOptions>, more),
  };
  return agent as unknown as AgentClient<BoundOptionsOf<TOptions>>;
}

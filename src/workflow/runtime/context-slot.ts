import { AsyncLocalStorage } from 'node:async_hooks';

// One storage for every slot. Before AsyncContextFrame, Node keeps each AsyncLocalStorage that ran
// in a process-wide list until disable() and copies every listed store onto each new async
// resource, so a storage per run would make every later async resource in the process carry one
// property per finished run.
const shared = new AsyncLocalStorage<ReadonlyMap<object, unknown>>();

/**
 * A per-owner context value with the `run` and `getStore` of an AsyncLocalStorage, kept in one
 * process-wide storage so that creating a slot per run allocates no storage. Each slot sees only
 * the values it ran with, exactly as its own storage would. @internal
 */
export class ContextSlot<T> {
  /** The value of the innermost enclosing {@link run} of this slot, if any. */
  public getStore(): T | undefined {
    return shared.getStore()?.get(this) as T | undefined;
  }

  /** Run `action` with `value` as this slot's value, leaving every other slot's value as it is. */
  public run<R>(value: T, action: () => R): R {
    return shared.run(new Map(shared.getStore()).set(this, value), action);
  }
}

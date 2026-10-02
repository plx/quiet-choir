import { AsyncLocalStorage } from 'node:async_hooks';
import { validateStepId } from './identity.js';
import { createHash } from 'node:crypto';
import type { MapItemScope } from './replay-decision.js';

/** A lexical context binding and its nested bindings. @internal */
export interface NameFrame {
  readonly path: string;
  readonly bindings: readonly symbol[];
  /** The named-map items enclosing this frame, outermost first; fork reuse treats siblings as independent. */
  readonly items: readonly MapItemScope[];
}

/** Prefixes are captured at invocation; there are no call-order counters. @internal */
export class NameScopes {
  private readonly storage = new AsyncLocalStorage<NameFrame>();
  public get path(): string {
    return this.storage.getStore()?.path ?? '';
  }
  /** The named-map items enclosing the current invocation, captured with its ID prefix. */
  public get items(): readonly MapItemScope[] {
    return this.storage.getStore()?.items ?? [];
  }
  public qualify(leaf: string): string {
    // Preserve invalid runtime values for the tracked validator instead of coercing them into IDs.
    return typeof leaf === 'string' ? this.path + leaf : leaf;
  }
  /** Keep child namespaces bounded without changing any existing ordinary scope spelling. */
  public childId(leaf: string): string {
    validateStepId(leaf);
    const expanded = this.qualify(leaf);
    return expanded.length <= 96
      ? expanded
      : `child:${createHash('sha256').update(expanded).digest('hex')}`;
  }
  public describe(id: string): { scope: string; leaf: string } {
    return {
      scope: this.path,
      leaf: typeof id === 'string' && id.startsWith(this.path) ? id.slice(this.path.length) : id,
    };
  }
  public prefix(leaf: string): string {
    if (leaf === '') throw new Error('Invalid scope prefix: expected a nonempty ID.');
    const id = this.qualify(leaf);
    validateStepId(id, { scope: this.path, leaf });
    return `${id}/`;
  }
  /** Run under a path, or enter a named-map item under its prefix; other items carry over. */
  public run<T>(scope: string | MapItemScope, action: () => T): T {
    const current = this.storage.getStore();
    const items = current?.items ?? [];
    return this.storage.run(
      typeof scope === 'string'
        ? { path: scope, bindings: current?.bindings ?? [], items }
        : { path: scope.item, bindings: current?.bindings ?? [], items: [...items, scope] },
      action,
    );
  }
  public bind(prefix: string): NameFrame {
    return {
      path: this.prefix(prefix),
      bindings: [...(this.storage.getStore()?.bindings ?? []), Symbol(prefix)],
      items: this.items,
    };
  }
  public bound<T>(frame: NameFrame, action: () => T): T {
    // Calls made through the same view inside its own scope/map retain descendant prefixes.
    const token = frame.bindings.at(-1);
    return token !== undefined && this.storage.getStore()?.bindings.includes(token)
      ? action()
      : this.storage.run(frame, action);
  }
}

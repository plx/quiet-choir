import { AsyncLocalStorage } from 'node:async_hooks';
import { validateStepId } from './identity.js';
import { createHash } from 'node:crypto';

/** A lexical context binding and its nested bindings. @internal */
export interface NameFrame {
  readonly path: string;
  readonly bindings: readonly symbol[];
}

/** Prefixes are captured at invocation; there are no call-order counters. @internal */
export class NameScopes {
  private readonly storage = new AsyncLocalStorage<NameFrame>();
  public get path(): string {
    return this.storage.getStore()?.path ?? '';
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
  public run<T>(path: string, action: () => T): T {
    return this.storage.run({ path, bindings: this.storage.getStore()?.bindings ?? [] }, action);
  }
  public bind(prefix: string): NameFrame {
    return {
      path: this.prefix(prefix),
      bindings: [...(this.storage.getStore()?.bindings ?? []), Symbol(prefix)],
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

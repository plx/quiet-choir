import { AsyncLocalStorage } from 'node:async_hooks';

/** Ownership of effects launched by a mapper, including its nested scopes. @internal */
export interface MapperScope {
  readonly settled: boolean;
  readonly signal: AbortSignal;
  readonly parents: readonly MapperScope[];
  readonly steps: Set<string>;
  readonly maps: Set<string>;
  readonly children: Set<string>;
}

/** Capture cancellation and mapper ownership at operation launch. @internal */
export class ExecutionScopes {
  private readonly storage = new AsyncLocalStorage<MapperScope>();
  public constructor(private readonly rootSignal: AbortSignal) {}
  public get signal(): AbortSignal {
    return this.storage.getStore()?.signal ?? this.rootSignal;
  }
  public get owners(): readonly MapperScope[] {
    const current = this.storage.getStore();
    return current === undefined ? [] : [...current.parents, current];
  }
  public create(signal: AbortSignal, settled = false): MapperScope {
    return {
      signal,
      settled,
      parents: this.owners,
      steps: new Set(),
      maps: new Set(),
      children: new Set(),
    };
  }
  public get requiresDeclaredChildren(): boolean {
    return this.owners.some((owner) => owner.settled);
  }
  public run<T>(scope: MapperScope, action: () => T): T {
    return this.storage.run(scope, action);
  }
  public step(id: string): void {
    for (const owner of this.owners) owner.steps.add(id);
  }
  public map(id: string): void {
    for (const owner of this.owners) owner.maps.add(id);
  }
  public child(id: string): void {
    for (const owner of this.owners) owner.children.add(id);
  }
}

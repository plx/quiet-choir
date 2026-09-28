/** A Promise whose public consumption is distinct from the runner's bookkeeping. @internal */
class OperationPromise<T> extends Promise<T> {
  public observed = false;

  public static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  public override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.observed = true;
    return super.then(onfulfilled, onrejected);
  }

  public watch(fulfilled: () => void, rejected: (error: unknown) => void): Promise<void> {
    return super.then(fulfilled, rejected);
  }
}

/** Tracks owned work without treating internal drain handlers as user error handling. @internal */
export class OperationTracker {
  private readonly pending = new Map<
    Promise<void>,
    { readonly owners: readonly object[]; readonly blocks: () => boolean }
  >();
  private readonly changes = new Set<() => void>();
  private readonly failures: {
    id: string;
    promise: OperationPromise<unknown>;
    error: unknown;
    owners: readonly object[];
  }[] = [];

  public launch<T>(
    id: string,
    work: () => T | PromiseLike<T>,
    owners: readonly object[] = [],
    blocks: () => boolean = () => true,
  ): Promise<T> {
    const promise = new OperationPromise<T>((resolve) => {
      resolve(work());
    });
    const done = promise.watch(
      () => {
        this.pending.delete(done);
        this.changed();
      },
      (error) => {
        this.pending.delete(done);
        this.failures.push({ id, promise, error, owners });
        this.changed();
      },
    );
    this.pending.set(done, { owners, blocks });
    this.changed();
    return promise;
  }

  /** Reconsider drains when a question transitions between registering and externally waiting. */
  public changed(): void {
    for (const changed of this.changes) changed();
  }

  /** Waits until no owned blocking work is pending after the microtask queue has fully flushed. */
  public async drain(owner?: object): Promise<void> {
    const owned = (): Promise<void>[] =>
      [...this.pending]
        .filter(
          ([, entry]) => entry.blocks() && (owner === undefined || entry.owners.includes(owner)),
        )
        .map(([promise]) => promise);
    for (;;) {
      for (let pending = owned(); pending.length; pending = owned()) {
        let notify!: () => void;
        const changed = new Promise<void>((resolve) => {
          notify = resolve;
        });
        this.changes.add(notify);
        try {
          await Promise.race([Promise.all(pending), changed]);
        } finally {
          this.changes.delete(notify);
        }
      }
      // A macrotask yield lets pure-microtask continuation chains launch their next operation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!owned().length) return;
    }
  }

  public assertObserved(owner?: object): void {
    const failure = this.failures.find(
      (failure) =>
        !failure.promise.observed && (owner === undefined || failure.owners.includes(owner)),
    );
    if (failure)
      throw new Error(
        `Unawaited workflow operation ${JSON.stringify(failure.id)} failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}; await all workflow operations.`,
        { cause: failure.error },
      );
  }
}

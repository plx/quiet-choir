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
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: { id: string; promise: OperationPromise<unknown>; error: unknown }[] =
    [];

  public launch<T>(id: string, work: () => T | PromiseLike<T>): Promise<T> {
    const promise = new OperationPromise<T>((resolve) => {
      resolve(work());
    });
    const done = promise.watch(
      () => {
        this.pending.delete(done);
      },
      (error) => {
        this.pending.delete(done);
        this.failures.push({ id, promise, error });
      },
    );
    this.pending.add(done);
    return promise;
  }

  public async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  public assertObserved(): void {
    const failure = this.failures.find((failure) => !failure.promise.observed);
    if (failure)
      throw new Error(
        `Unawaited workflow operation ${JSON.stringify(failure.id)} failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}; await all workflow operations.`,
        { cause: failure.error },
      );
  }
}

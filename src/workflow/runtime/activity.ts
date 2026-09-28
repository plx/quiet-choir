import { setImmediate as turn } from 'node:timers/promises';

/** Counts owned work without counting continuations blocked on external answers. @internal */
export class RunActivity {
  #active = 0;
  #generation = 0;
  #closed = false;
  readonly #listeners = new Set<() => void>();

  public touch(): void {
    this.#generation++;
    for (const listener of this.#listeners) listener();
  }

  public begin(): () => void {
    this.#active++;
    this.touch();
    return () => {
      this.#active--;
      this.touch();
    };
  }

  public close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  #stable(generation: number): boolean {
    return !this.#closed && this.#active === 0 && generation === this.#generation;
  }

  public quiet(pending: () => boolean, scan: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      let checking = false;
      let settled = false;
      const check = (): void => {
        if (settled || checking || this.#closed || this.#active !== 0 || !pending()) return;
        checking = true;
        void (async () => {
          let generation = this.#generation;
          await turn();
          await turn();
          if (!this.#stable(generation)) return;
          await scan();
          generation = this.#generation;
          await turn();
          await turn();
          if (this.#stable(generation) && pending()) {
            this.#listeners.delete(check);
            settled = true;
            resolve();
          }
        })().then(
          () => {
            checking = false;
            check();
          },
          (error: unknown) => {
            this.#listeners.delete(check);
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
          },
        );
      };
      this.#listeners.add(check);
      check();
    });
  }
}

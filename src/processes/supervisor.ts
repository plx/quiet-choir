import type { HarnessProcess } from '../workflow/runtime/model.js';
import { processIdentity, groupState, signalProcess } from './identity.js';

/** Live child ownership shared with an embedder's second-signal handler. No signal handlers are installed. */
export class ProcessSupervisor {
  readonly #children = new Set<HarnessProcess>();

  /** Register synchronously before asynchronous persistence; the disposer follows confirmed reaping. @internal */
  public track(child: HarnessProcess): () => void {
    this.#children.add(child);
    return () => {
      this.#children.delete(child);
    };
  }

  /** Synchronously send SIGKILL to all owned groups (immediate children on Windows). Return signal failures. */
  public forceKill(): readonly string[] {
    const errors: string[] = [];
    for (const child of this.#children) {
      try {
        const current = processIdentity(child.pid);
        if (
          groupState(child) === 'dead' ||
          (current?.start && child.osStartTime && current.start !== child.osStartTime)
        ) {
          this.#children.delete(child);
          continue;
        }
        signalProcess(child, 'SIGKILL');
      } catch (error) {
        errors.push(
          `${child.binary} pid ${String(child.pid)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return errors;
  }
}
